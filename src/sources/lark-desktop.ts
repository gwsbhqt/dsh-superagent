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
import { KV } from '../kv.ts'
import type { SourceKind } from './kind.ts'
import { JEV_KEY_REF, JevBatcher, httpJev, type JevAsk } from './lark-desktop-jev.ts'
import { larkDesktopThreadContext } from './lark-desktop-read.ts'
import { larkDesktopChannel } from './lark-desktop-channel.ts'
import { desktop, NOTIFY_HEALTH } from './lark-desktop-notify.ts'
/** How often open tickets are checked for one that waits for the person. */
const NOTICE_CHECK_MS = 30_000
import { ExpiredLineSchema, NoticeLineSchema, SOURCE, WatchedMessageSchema, larkScope, larkTrigger, needsJev, storedMessage, withJev,
  botReply, withQuote, type WatchedMessage } from './lark-desktop-trigger.ts'

export { AGENT_MARK, SOURCE, botReply, withQuote, larkScope, larkThreadId, larkTrigger, larkTriggerId, needsJev, storedMessage, withJev } from './lark-desktop-trigger.ts'
export { JevBatcher, httpJev, jevBatch, type JevAsk } from './lark-desktop-jev.ts'
export { larkDesktopThreadContext, larkView } from './lark-desktop-read.ts'
export { CHANNEL_CONSUMER, STANDALONE, larkDesktopChannel, larkParts, sendLarkDesktop } from './lark-desktop-channel.ts'

const LarkDesktopConfigSchema = z.object({
  cli: z.string().trim().min(1).default('lark-desktop'),
  consumer: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/, 'Letters, digits, dots, dashes and underscores').default('dsh-superagent'),
  jev: z.enum(['off', 'observe', 'filter']).default('observe'),
  jevMinimum: z.number().int().min(0).max(100).default(50),
  notify: z.boolean().default(true),
  notifier: z.string().trim().min(1).default('terminal-notifier'),
  panelUrl: z.union([z.literal(''), z.url()]).default(''),
}).strict()
export type LarkDesktopConfig = z.infer<typeof LarkDesktopConfigSchema>

export const larkDesktopKind: SourceKind<LarkDesktopConfig> = {
  kind: SOURCE,
  title: { zh: '飞书桌面端', en: 'Lark desktop' },
  description: { zh: '经 lark-desktop 读本人的飞书桌面端：私聊、@ 和回复本人的消息，以及没有设免打扰的群里的消息；回复时以本人身份回到原消息下，末尾带 🤖。不贴表情。',
    en: 'Reads the person\'s own Feishu or Lark desktop client through lark-desktop: direct messages, messages that mention or reply to them, and the messages of chats they did not mute. It replies in the person\'s name under the message it answers, ending with 🤖, and adds no emoji.' },
  schema: LarkDesktopConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'lark-desktop 命令', en: 'lark-desktop command' },
      hint: { zh: '命令名或绝对路径。飞书桌面端要以调试模式运行，lark-desktop 才读得到它。', en: 'A command name or an absolute path. The desktop client must run in debug mode for lark-desktop to read it.' } },
    { key: 'consumer', type: 'text', advanced: true, label: { zh: '订阅名', en: 'Subscriber name' },
      hint: { zh: 'lark-desktop 按这个名字记住读到哪里；同一台电脑上别的程序不要用同一个名字。', en: 'lark-desktop remembers how far this name has read; no other program on the machine should use the same name.' } },
    { key: 'jev', type: 'select', label: { zh: 'Jev 判断', en: 'Jev' },
      options: [{ value: 'off', label: { zh: '关闭', en: 'Off' } }, { value: 'observe', label: { zh: '只记分数', en: 'Score only' } }, { value: 'filter', label: { zh: '过滤', en: 'Filter' } }],
      hint: { zh: '群里没有 @ 或回复本人的消息，先让 Jev 小模型一批批判断本人是否需要处理。“只记分数”不过滤；“过滤”时低于阈值的记为被过滤。私聊、@ 和回复本人的消息不经过它；它出错时消息照常收下。钥匙取凭据里的 TYPESAFE_API_KEY。',
        en: 'Messages in chats that neither mention nor reply to the person first go to the small Jev model, in batches, which judges whether the person needs them. Score only filters nothing; Filter leaves out those below the threshold. Direct messages, mentions and replies skip it, and when it fails the messages are received as usual. Its key is TYPESAFE_API_KEY in the credentials.' } },
    { key: 'jevMinimum', type: 'number', advanced: true, min: 0, max: 100, label: { zh: 'Jev 阈值 / %', en: 'Jev threshold / %' },
      hint: { zh: '“过滤”时，Jev 认为本人需要的概率低于它就不收。', en: 'With Filter, a message Jev gives a lower probability that the person needs it is not received.' } },
    { key: 'notify', type: 'switch', label: { zh: '桌面通知', en: 'Desktop notifications' },
      hint: { zh: '以本人名义发出消息时，以及工单需要本人回答、卡住、失败、做好等你看时，在这台电脑上弹通知；每件事只弹一次。', en: 'Shows a notification on this computer when a message goes out in the person\'s name, and when a ticket needs their answer, is blocked, failed, or is ready for them; once each.' } },
    { key: 'notifier', type: 'text', advanced: true, label: { zh: '通知命令', en: 'Notifier command' },
      hint: { zh: 'terminal-notifier，或它的绝对路径（Homebrew 安装）。', en: 'terminal-notifier, or its absolute path (installed with Homebrew).' } },
    { key: 'panelUrl', type: 'text', label: { zh: '面板地址', en: 'Panel address' },
      hint: { zh: '这个 DeepSeek Harness 网页的地址，如 http://127.0.0.1:3082/。填了以后，点通知会打开那张工单；不填就只弹通知。', en: 'The address of this DeepSeek Harness web page, such as http://127.0.0.1:3082/. With it, clicking a notification opens its ticket; without it, the notification opens nothing.' } },
  ],
  health: [SOURCE, NOTIFY_HEALTH],
  scope: ({ meta }) => larkScope(meta),
  threadContext: larkDesktopThreadContext,
  channel: larkDesktopChannel,
  policy: {
    unnamed: { person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的人', en: 'People who may originate work' },
        hint: { zh: '他们找本人的消息是明确的请求。只替本人做事时可以留空：名单外的人找本人，按下面的准入表交给评估。', en: 'Their messages to the person are explicit requests. Acting for the person alone, leave it empty: people not on it who reach the person go to Eval by the admission table below.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户编号', en: 'User id' }, pattern: '[0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息总能成为候选的机器人', en: 'Bots whose messages may always become candidates' },
        hint: { zh: '名单里的机器人在接收范围里的消息都成为推断的候选；不在名单上的机器人按准入表里“名单外”的格子处理。', en: 'Every received message of a bot on this list becomes an inferred candidate; any other bot takes the admission table\'s cells for senders not on the list.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '机器人编号', en: 'Bot id' }, pattern: '[0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '私聊本人，或在群里 @、回复、加急本人', en: 'A direct message to the person, or a group message that mentions, replies to or urgently calls them' },
    rows: () => [
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '全部接收', en: 'All received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'mentions', label: { zh: '群里找本人的消息', en: 'Group messages to the person' }, note: { zh: '@、回复、加急本人', en: 'Mentions, replies and urgent calls' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'chats', label: { zh: '没设免打扰的群', en: 'Chats not muted' }, note: { zh: '群里其余的消息', en: 'Their other messages' },
        cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: true } },
    ],
  },
}

/** How many attempts a watch line whose intake failed gets before the Source gives it up and reports it. */
const MAX_TRIES = 5
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
/**
 * Keeps a watch line whose intake failed for another attempt: lark-desktop counts a printed line as delivered, so a line
 * dropped here would never come again. Lines are keyed by their message id; one failing `MAX_TRIES` times is given up.
 */
export function park(ctx: SourceContext, line: string, error: unknown): void {
  let id: string
  try { id = String((JSON.parse(line) as { message_id?: unknown }).message_id ?? '') } catch { id = '' }
  if (!id) { ctx.report(SOURCE, { state: 'error', detail: errorText(error) }); return }
  const parked = { ...ctx.state.get(KV.larkDesktop.parked) }
  const tries = (parked[id]?.tries ?? 0) + 1
  if (tries >= MAX_TRIES) delete parked[id]
  else parked[id] = { line, tries, error: errorText(error).slice(0, 500), at: new Date().toISOString() }
  ctx.state.set(KV.larkDesktop.parked, parked)
  ctx.report(SOURCE, { state: 'error', detail: tries >= MAX_TRIES ? `Gave up message ${id} after ${tries} attempts: ${errorText(error)}`
    : `Message ${id} failed (attempt ${tries} of ${MAX_TRIES}) and will be retried: ${errorText(error)}` })
}
/** Takes in the parked lines again, dropping each that now succeeds. */
async function retryParked(ctx: SourceContext, run: Run): Promise<void> {
  for (const [id, entry] of Object.entries(ctx.state.get(KV.larkDesktop.parked) ?? {})) {
    if (run.signal.aborted) return
    const before = ctx.state.get(KV.larkDesktop.parked) ?? {}
    if (!before[id]) continue
    try {
      await take(ctx, run, entry.line)
      const parked = { ...ctx.state.get(KV.larkDesktop.parked) }
      delete parked[id]
      ctx.state.set(KV.larkDesktop.parked, parked)
    } catch (error) { park(ctx, entry.line, error) }
  }
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

/** Runs `lark-desktop watch` while the Source is on, restarting it with a backoff when it exits; `jev` asks layer one, when there is one. */
export async function runLarkDesktop(ctx: SourceContext, signal: AbortSignal, options: { jev?: JevAsk } = {}): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'setupPending')); return }
  const muted: Muted = { chats: new Map(), at: 0 }
  const checkNotices = () => { const config = enabled(ctx); if (config) { desktop.use(ctx, config); desktop.check() } }
  checkNotices()
  const notices = setInterval(checkNotices, NOTICE_CHECK_MS)
  let retry: number | undefined
  try {
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
      try { await consume(ctx, config, muted, running.signal, options.jev) }
      catch (error) { if (!running.signal.aborted) ctx.report(SOURCE, { state: 'error', detail: error instanceof Error ? error.message : String(error) }) }
      finally { clearInterval(check); signal.removeEventListener('abort', stop) }
      if (running.signal.aborted) continue
      retry = consumerRetry(retry, Date.now() - began)
      await delay(retry, undefined, { signal }).catch(() => {})
    }
  } finally { clearInterval(notices) }
}

async function consume(ctx: SourceContext, config: LarkDesktopConfig, muted: Muted, signal: AbortSignal, jev?: JevAsk): Promise<void> {
  const cli = program(ctx, config)
  const listening = { state: 'ready' as const, detail: `Receiving as ${config.consumer}` }
  const batcher = jev && config.jev !== 'off' ? new JevBatcher(jev, signal, error => {
    ctx.report(SOURCE, { ...listening, detail: `${listening.detail}; Jev failed, so its batch was received unscored: ${error instanceof Error ? error.message : String(error)}`, at: new Date().toISOString() })
  }) : undefined
  const scoring = new Set<Promise<void>>()
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
  const run: Run = { cli, config, muted, signal, batcher, scoring }
  const retry = () => { chain = chain.then(() => retryParked(ctx, run)).catch(error => { ctx.report(SOURCE, { state: 'error', detail: errorText(error) }) }) }
  const rereads = setInterval(() => { void refresh(); retry() }, MUTED_REFRESH_MS)
  stderr.on('line', (line: string) => {
    if (line.includes('LARK_DESKTOP_READY')) {
      ready = true; clearTimeout(timeout)
      ctx.report(SOURCE, { ...listening, at: new Date().toISOString() })
      retry()
    } else if (line.trim()) diagnostic = line.slice(0, 4000)
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(() => take(ctx, run, line)).catch(error => { park(ctx, line, error) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => signal.aborted ? resolve() : reject(new Error(`lark-desktop watch exited (${code}, subscribed=${ready}): ${diagnostic}`)))
    })
  } finally {
    clearTimeout(timeout); clearInterval(rereads); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain
    await batcher?.flush(); await Promise.all(scoring)
  }
}

interface Run { cli: string; config: LarkDesktopConfig; muted: Muted; signal: AbortSignal; batcher?: JevBatcher | undefined; scoring: Set<Promise<void>> }
/**
 * Takes in one line of `lark-desktop watch`: a message, a message whose body expired and is read again, or a problem it reports.
 * A message Jev scores is received once its batch is answered, while the next lines go on.
 */
async function take(ctx: SourceContext, run: Run, line: string): Promise<void> {
  const { cli, config, muted, signal, batcher, scoring } = run
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
  let trigger = larkTrigger(message, muted.chats.get(message.chat_id) === true)
  if (!trigger) return
  // A reply to the person answers one of their messages, which no Trigger holds: read it so the card shows what the reply answers.
  if (message.reply_to_me === true && message.reply_to) {
    // Without it the reply is received all the same: a failed or unreadable read leaves the card without the quote.
    const parent = await ctx.commands.withSignal(signal).run(cli, ['message', message.reply_to, '--no-parent'])
      .then(out => storedMessage(JSON.parse(out))).catch(() => undefined)
    if (parent) trigger = withQuote(trigger, parent)
  }
  // Lines read after the Source was switched off are dropped; the watch stops shortly after.
  if (!batcher || !needsJev(trigger)) { if (enabled(ctx)) await receive(ctx, trigger); return }
  const scored: Promise<void> = batcher.score(message)
    .then(score => score === undefined ? trigger : withJev(trigger, score, config.jev === 'filter' || botReply(trigger) ? config.jevMinimum : undefined))
    .then(async result => { if (enabled(ctx)) await receive(ctx, result) })
    .catch((error: unknown) => { park(ctx, line, error) })
    .finally(() => { scoring.delete(scored) })
  scoring.add(scored)
}

/** DeepSeek Harness's credentials service, as far as this Source reads it; a reference is its name, which the service checks. */
interface Credentials { resolve(ref: string): Promise<{ value: string } | undefined> }
/** The value of a credential reference, read on each use since the credentials service may mount after this plugin. */
async function credential(ctx: Context, ref: string): Promise<string | undefined> {
  return (await (ctx.get('credentials') as Credentials | undefined)?.resolve(ref))?.value
}

export const name = 'dsh-superagent-lark-desktop'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(larkDesktopKind), 'lark-desktop: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runLarkDesktop(sourceContext(ctx.orchestrator, larkDesktopKind), controller.signal, { jev: httpJev(() => credential(ctx, JEV_KEY_REF)) })
    return async () => { controller.abort(); await running }
  })
}
