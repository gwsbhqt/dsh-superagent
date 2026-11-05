import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { AGENT_MARK, larkDesktopKind, larkScope, larkThreadId, larkTrigger, larkTriggerId, runLarkDesktop, storedMessage }
  from '../src/sources/lark-desktop.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A message as `lark-desktop watch` prints it; the names and ids are made up. */
const line = (overrides: Record<string, unknown> = {}) => ({ message_id: 'm-1', chat_id: 'chat-1', chat_name: 'Widgets', chat_kind: 'group',
  sender_id: 'user-1', sender_name: 'Ada', sent_at: Date.parse('2026-01-02T03:04:05Z'), text: 'please take a look', ...overrides })

describe('lark-desktop messages', () => {
  it('address the person in a direct message, or with a mention or a reply to them, and keep the chat in meta', () => {
    expect(larkTrigger(line({ chat_kind: 'direct' }), false)).toMatchObject({ id: larkTriggerId('m-1'), source: 'lark-desktop',
      threads: [{ source: 'lark-desktop', id: 'chat-1:m-1' }], actor: { source: 'lark-desktop', id: 'user-1' }, human: true, addressed: 'direct',
      at: '2026-01-02T03:04:05.000Z', text: 'please take a look', meta: { chatId: 'chat-1', chatName: 'Widgets', direct: true, mentioned: false, muted: false } })
    expect(larkTrigger(line({ is_at_me: true }), true)).toMatchObject({ addressed: 'mention', meta: { mentioned: true, muted: true } })
    expect(larkTrigger(line({ addressed_to_me: true }), false)).toMatchObject({ addressed: 'mention' })
    expect(larkTrigger(line(), false)).not.toHaveProperty('addressed')
    expect(larkTrigger(line({ sender_is_bot: true }), false)).toMatchObject({ human: false })
  })
  it('leave out a recalled message and one an agent sent as the person', () => {
    expect(larkTrigger(line({ recalled: true }), false)).toBeUndefined()
    expect(larkTrigger(line({ text: `done ${AGENT_MARK}\n` }), false)).toBeUndefined()
  })
  it('put a topic, or a message and the replies to it, in one Thread', () => {
    expect(larkThreadId(line({ thread_id: 't-1', reply_to: 'm-0' }))).toBe('chat-1:t-1')
    expect(larkThreadId(line({ reply_to: 'm-0' }))).toBe('chat-1:m-0')
    expect(larkThreadId(line())).toBe('chat-1:m-1')
  })
  it('receive direct messages, mentions and replies, and the rest only from chats the person did not mute', () => {
    const scope = (overrides: Record<string, unknown>, muted: boolean) => larkScope(larkTrigger(line(overrides), muted)!.meta)
    expect(scope({ chat_kind: 'direct' }, true)).toEqual({ listened: true, observed: true, row: 'direct' })
    expect(scope({ is_at_me: true }, true)).toEqual({ listened: true, observed: false, row: 'mentions' })
    expect(scope({}, true)).toEqual({ listened: false, reason: 'lark_desktop_muted' })
    expect(scope({}, false)).toEqual({ listened: true, observed: true, row: 'chats' })
  })
  it('read a message lark-desktop returns with the client\'s field names', () => {
    expect(storedMessage({ message: { id: 'm-2', chat_id: 'chat-1', chat_kind: 'group', parent_id: 'm-1', text: 'body' }, context: [] }))
      .toMatchObject({ message_id: 'm-2', reply_to: 'm-1', text: 'body' })
    expect(() => storedMessage({ context: [] })).toThrow()
  })
})

describe('lark-desktop watch', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  // The fake CLI is a real process, which starts slower while the whole suite runs.
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lark-desktop-')); controller = new AbortController() })
  afterEach(async () => { controller.abort(); await running; rmSync(dir, { recursive: true, force: true }) })
  /** A lark-desktop CLI that records each call, lists one muted and one open chat, prints `events` once subscribed, and reads one expired message again. */
  function cli(): string {
    const path = join(dir, 'lark-desktop')
    const chats = JSON.stringify([{ chat_id: 'chat-muted', muted: true }, { chat_id: 'chat-open', muted: false },
      // A topic entry of the muted chat says nothing about the chat itself.
      { chat_id: 'chat-muted', thread_id: 't-9', muted: false }])
    const stored = JSON.stringify({ message: { id: 'm-expired', chat_id: 'chat-open', chat_kind: 'group', sender_id: 'user-2', sent_at: 1, text: 'read again', parent_id: 'm-root' } })
    writeFileSync(path, `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1" in
  chats) echo '${chats}' ;;
  message) echo '${stored}' ;;
  watch) echo 'LARK_DESKTOP_READY' >&2; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
    return path
  }
  function source(path: string) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { 'lark-desktop': { enabled: true, config: { cli: path } } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(larkDesktopKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
    const deployment = testDeployment({ stateDir: dir })
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands: new Commands(() => deployment, {}, controller.signal), sources,
      deployment, ready: Promise.resolve(), configured: () => true, receive: (trigger: Trigger) => engine.receive(trigger) }
    return { ctx: sourceContextOf(deps, larkDesktopKind), health: board.all, store }
  }
  it('takes in what reaches the person, leaves a muted chat out, rereads an expired body, and only reads', async () => {
    const lines = [line({ message_id: 'm-dm', chat_id: 'dm-1', chat_kind: 'direct' }), line({ message_id: 'm-at', chat_id: 'chat-muted', is_at_me: true }),
      line({ message_id: 'm-muted', chat_id: 'chat-muted' }), line({ message_id: 'm-open', chat_id: 'chat-open' }),
      line({ message_id: 'm-mine', chat_id: 'chat-open', text: `on it ${AGENT_MARK}` }), { message_id: 'm-expired', body_expired: true },
      { event: 'stale_lamp', message_id: 'm-open' }, { event: 'problem', kind: 'push_missing', detail: 'no push for a while' }]
    writeFileSync(join(dir, 'events'), lines.map(item => JSON.stringify(item)).join('\n') + '\n')
    const { ctx, health, store } = source(cli())
    running = runLarkDesktop(ctx, controller.signal)
    await vi.waitFor(() => expect(health['lark-desktop']).toMatchObject({ state: 'error', detail: expect.stringContaining('push_missing') }), until)
    const got = (id: string) => store.triggers.get(larkTriggerId(id))
    expect([got('m-dm')?.addressed, got('m-at')?.addressed, got('m-open')?.addressed]).toEqual(['direct', 'mention', undefined])
    expect(store.triggers.disposition(larkTriggerId('m-muted'))?.filtered).toMatchObject({ code: 'lark_desktop_muted' })
    expect(got('m-open')?.meta.muted).toBe(false)
    expect(got('m-mine')).toBeUndefined()
    expect(got('m-expired')).toMatchObject({ text: 'read again', threads: [{ id: 'chat-open:m-root' }] })
    // Read-only: it lists the chats, subscribes without status emoji, and reads one message; it writes nothing.
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
    expect(calls).toEqual(['chats --all', 'watch dsh-superagent --scope others --no-ack', 'message m-expired --no-parent'])
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reports a lark-desktop it cannot find, and waits while the Source is off', async () => {
    const { ctx, health, store } = source(join(dir, 'missing'))
    running = runLarkDesktop(ctx, controller.signal)
    await vi.waitFor(() => expect(health['lark-desktop']).toMatchObject({ state: 'error', detail: expect.stringContaining('is not an executable file') }), until)
    store.saveSettings(SettingsSchema.parse({ sources: { 'lark-desktop': { enabled: false, config: {} } } }))
    await vi.waitFor(() => expect(health['lark-desktop']).toMatchObject({ state: 'paused' }), { timeout: 15_000 })
    expect(existsSync(join(dir, 'calls'))).toBe(false)
    controller.abort(); await running; store.close()
  }, 25_000)
})
