/**
 * The lark-desktop Source kind and plugin entry: a read-only stream of the messages that reach a person in their own Feishu
 * or Lark desktop client, read through the lark-desktop CLI. It sends nothing and leaves no status emoji.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { executable } from '../deployment.ts'
import { withoutDirectory, workerBin } from '../infra/environment.ts'
import { consumerRetry } from './feishu-loops.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { ExpiredLineSchema, NoticeLineSchema, SOURCE, WatchedMessageSchema, larkScope, larkTrigger, storedMessage, type WatchedMessage }
  from './lark-desktop-trigger.ts'

export { AGENT_MARK, SOURCE, larkScope, larkThreadId, larkTrigger, larkTriggerId, storedMessage } from './lark-desktop-trigger.ts'

const LarkDesktopConfigSchema = z.object({
  cli: z.string().trim().min(1).default('lark-desktop'),
  consumer: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/, 'Letters, digits, dots, dashes and underscores').default('dsh-superagent'),
}).strict()
export type LarkDesktopConfig = z.infer<typeof LarkDesktopConfigSchema>

export const larkDesktopKind: SourceKind<LarkDesktopConfig> = {
  kind: SOURCE,
  title: { zh: '飞书桌面端', en: 'Lark desktop' },
  description: { zh: '经 lark-desktop 读本人的飞书桌面端：私聊、@ 和回复本人的消息，以及没有设免打扰的群里的消息。只读，不发消息，也不贴表情。',
    en: 'Reads the person\'s own Feishu or Lark desktop client through lark-desktop: direct messages, messages that mention or reply to them, and the messages of chats they did not mute. Read-only: it sends nothing and adds no emoji.' },
  schema: LarkDesktopConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'lark-desktop 命令', en: 'lark-desktop command' },
      hint: { zh: '命令名或绝对路径。飞书桌面端要以调试模式运行，lark-desktop 才读得到它。', en: 'A command name or an absolute path. The desktop client must run in debug mode for lark-desktop to read it.' } },
    { key: 'consumer', type: 'text', advanced: true, label: { zh: '订阅名', en: 'Subscriber name' },
      hint: { zh: 'lark-desktop 按这个名字记住读到哪里；同一台电脑上别的程序不要用同一个名字。', en: 'lark-desktop remembers how far this name has read; no other program on the machine should use the same name.' } },
  ],
  health: [SOURCE],
  scope: ({ meta }) => larkScope(meta),
}

/** How often the Source rereads which chats the person muted. */
const MUTED_REFRESH_MS = 300_000
/** How long `lark-desktop watch` may take to subscribe before the Source reports it. */
const READY_TIMEOUT_MS = 60_000
const ChatsSchema = z.array(z.looseObject({ chat_id: z.string(), thread_id: z.string().nullish(), muted: z.boolean().optional() }))
/** Which chats the person muted, as of `at`. */
interface Muted { chats: Map<string, boolean>; at: number }

const enabled = (ctx: SourceContext): LarkDesktopConfig | undefined => ctx.config<LarkDesktopConfig>(SOURCE)
/** PATH without the worker shims, so a command blocked for workers, such as lark-desktop itself, still reaches the Source. */
const hostPath = (ctx: SourceContext): string => withoutDirectory(process.env.PATH ?? '', workerBin(ctx.deployment.stateDir))
const program = (ctx: SourceContext, config: LarkDesktopConfig): string =>
  executable(config.cli, hostPath(ctx), workerBin(ctx.deployment.stateDir))

/** Rereads which chats the person muted; the previous map stays when the read fails. */
export async function refreshMuted(ctx: SourceContext, cli: string, muted: Muted, signal?: AbortSignal): Promise<void> {
  const chats = ChatsSchema.parse(JSON.parse(await ctx.commands.withSignal(signal).run(cli, ['chats', '--all'])))
  muted.chats = new Map(chats.filter(chat => !chat.thread_id).map(chat => [chat.chat_id, chat.muted === true]))
  muted.at = Date.now()
}

async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const name = typeof trigger.meta.chatName === 'string' ? trigger.meta.chatName : ''
  const chat = trigger.meta.direct === true ? { value: { zh: `私聊 ${name}`.trim(), en: `Direct message ${name}`.trim() } } : { value: name || String(trigger.meta.chatId) }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
}

/** Runs `lark-desktop watch` while the Source is on, restarting it with a backoff when it exits. */
export async function runLarkDesktop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'setupPending')); return }
  const muted: Muted = { chats: new Map(), at: 0 }
  let retry: number | undefined
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report(SOURCE, health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (JSON.stringify(enabled(ctx)) !== JSON.stringify(config)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, config, muted, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report(SOURCE, { state: 'error', detail: error instanceof Error ? error.message : String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}

async function consume(ctx: SourceContext, config: LarkDesktopConfig, muted: Muted, signal: AbortSignal): Promise<void> {
  const cli = program(ctx, config)
  const refresh = () => refreshMuted(ctx, cli, muted, signal).catch(() => { /* The previous map stays; an unknown chat counts as not muted. */ })
  if (Date.now() - muted.at > MUTED_REFRESH_MS) await refresh()
  // `--scope others`: direct messages, and every group message but the person's own; `--no-ack` leaves no status emoji.
  const child = spawn(cli, ['watch', config.consumer, '--scope', 'others', '--no-ack'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: hostPath(ctx) } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  const stop = (): void => { child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = `lark-desktop watch did not subscribe within ${READY_TIMEOUT_MS / 1000} seconds`; stop() }, READY_TIMEOUT_MS)
  const rereads = setInterval(() => { void refresh() }, MUTED_REFRESH_MS)
  stderr.on('line', (line: string) => {
    if (line.includes('LARK_DESKTOP_READY')) {
      ready = true; clearTimeout(timeout)
      ctx.report(SOURCE, { state: 'ready', detail: `Receiving as ${config.consumer}`, at: new Date().toISOString() })
    } else if (line.trim()) diagnostic = line.slice(0, 4000)
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(() => take(ctx, cli, line, muted, signal))
      .catch(error => { ctx.report(SOURCE, { state: 'error', detail: error instanceof Error ? error.message : String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => signal.aborted ? resolve() : reject(new Error(`lark-desktop watch exited (${code}, subscribed=${ready}): ${diagnostic}`)))
    })
  } finally { clearTimeout(timeout); clearInterval(rereads); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/** Takes in one line of `lark-desktop watch`: a message, a message whose body expired and is read again, or a problem it reports. */
async function take(ctx: SourceContext, cli: string, line: string, muted: Muted, signal: AbortSignal): Promise<void> {
  if (!line.trim()) return
  if (line.length > 1_048_576) throw new Error('lark-desktop line exceeds 1 MiB')
  const value: unknown = JSON.parse(line)
  const expired = ExpiredLineSchema.safeParse(value), notice = NoticeLineSchema.safeParse(value)
  let message: WatchedMessage
  if (expired.success) {
    message = storedMessage(JSON.parse(await ctx.commands.withSignal(signal).run(cli, ['message', expired.data.message_id, '--no-parent'])))
  } else if (notice.success) {
    if (notice.data.event === 'problem') ctx.report(SOURCE, { state: 'error', detail: `lark-desktop reports ${notice.data.kind ?? 'a problem'}: ${JSON.stringify(notice.data.detail ?? '')}` })
    return
  } else message = WatchedMessageSchema.parse(value)
  const trigger = larkTrigger(message, muted.chats.get(message.chat_id) === true)
  // Lines read after the Source was switched off are dropped; the watch stops shortly after.
  if (trigger && enabled(ctx)) await receive(ctx, trigger)
}

export const name = 'dsh-superagent-lark-desktop'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(larkDesktopKind), 'lark-desktop: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runLarkDesktop(sourceContext(ctx.orchestrator, larkDesktopKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
