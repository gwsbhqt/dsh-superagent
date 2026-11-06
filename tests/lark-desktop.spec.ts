import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, anyoneAdmitted, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { triggerMessage } from '../src/executor/dsh.ts'
import { KV } from '../src/kv.ts'
import { CliError } from '../src/infra/commands.ts'
import { DesktopNotifier, REVIEW_GRACE_MS, desktop, showDesktop, ticketLink, type DesktopNotice } from '../src/sources/lark-desktop-notify.ts'
import { AGENT_MARK, JevBatcher, botReply, larkParts, sendLarkDesktop, withQuote, larkDesktopThreadContext, httpJev, jevBatch, larkDesktopKind, larkScope, larkThreadId, larkTrigger, larkTriggerId, needsJev, runLarkDesktop,
  storedMessage, withJev, type JevAsk } from '../src/sources/lark-desktop.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A message as `lark-desktop watch` prints it; the names and ids are made up. */
const line = (overrides: Record<string, unknown> = {}) => ({ message_id: 'm-1', chat_id: 'chat-1', chat_name: 'Widgets', chat_kind: 'group',
  sender_id: 'user-1', sender_name: 'Ada', sender_is_bot: false, sent_at: Date.parse('2026-01-02T03:04:05Z'), text: 'please take a look', ...overrides })

describe('lark-desktop messages', () => {
  it('address the person in a direct message, or with a mention or a reply to them, and keep the chat in meta', () => {
    expect(larkTrigger(line({ chat_kind: 'direct' }), false)).toMatchObject({ id: larkTriggerId('m-1'), source: 'lark-desktop',
      threads: [{ source: 'lark-desktop', id: 'chat-1:m-1' }], actor: { source: 'lark-desktop', id: 'user-1', name: 'Ada' }, human: true, addressed: 'direct',
      at: '2026-01-02T03:04:05.000Z', text: 'please take a look', meta: { chatId: 'chat-1', chatName: 'Widgets', direct: true, mentioned: false, muted: false } })
    expect(larkTrigger(line({ is_at_me: true }), true)).toMatchObject({ addressed: 'mention', meta: { mentioned: true, muted: true } })
    expect(larkTrigger(line({ addressed_to_me: true }), false)).toMatchObject({ addressed: 'mention' })
    // A bot's reply to the person addresses them too, though lark-desktop's addressed_to_me leaves it out.
    const reply = larkTrigger(line({ sender_is_bot: true, reply_to: 'm-0', reply_to_me: true, addressed_to_me: false }), true)!
    expect([reply.addressed, reply.human, reply.reach, larkScope(reply.meta)]).toEqual(['mention', false, 'replies to a message of the person',
      { listened: true, observed: false, row: 'mentions' }])
    // A bot's plain reply goes to Jev, which leaves it out below the threshold even in a muted chat; a person's reply skips Jev.
    expect([botReply(reply), needsJev(reply), larkScope(withJev(reply, 0.2, 50).meta)]).toEqual([true, true, { listened: false, reason: 'lark_desktop_jev' }])
    const person = larkTrigger(line({ reply_to: 'm-0', reply_to_me: true }), false)!
    expect([botReply(person), needsJev(person)]).toEqual([false, false])
    // A bot that mentions the person is no plain reply.
    expect(needsJev(larkTrigger(line({ sender_is_bot: true, reply_to_me: true, is_at_me: true }), false)!)).toBe(false)
  })
  it('shows models who sent a message, that it is a bot, and how it reached the person', () => {
    const card = triggerMessage(larkTrigger(line({ sender_is_bot: true, reply_to: 'm-0', reply_to_me: true }), false)!, {})
    expect(card).toMatchObject({ from: 'user-1', from_name: 'Ada', bot: true, reached_by: 'replies to a message of the person' })
    expect(triggerMessage(larkTrigger(line({ chat_kind: 'direct' }), false)!, {})).not.toHaveProperty('bot')
    const quoted = withQuote(larkTrigger(line({ reply_to: 'm-0', reply_to_me: true }), false)!, { message_id: 'm-0', chat_id: 'chat-1', sender_name: 'Me', text: 'tell me  what\nto try' })
    expect(triggerMessage(quoted, {})).toMatchObject({ replies_to: { from: 'Me', preview: 'tell me what to try' } })
    expect(larkTrigger(line(), false)).not.toHaveProperty('addressed')
    expect(larkTrigger(line({ sender_is_bot: true }), false)).toMatchObject({ human: false, meta: { senderIsBot: true } })
    const unknown = larkTrigger(line({ sender_is_bot: null }), false)!
    expect(unknown).toMatchObject({ human: false, meta: { senderIsBot: null } })
    expect(triggerMessage(unknown, {})).toMatchObject({ sender_identity: 'unknown' })
    expect(triggerMessage(unknown, {})).not.toHaveProperty('bot')
  })
  it('leave out a recalled message and one an agent sent as the person', () => {
    expect(larkTrigger(line({ recalled: true }), false)).toBeUndefined()
    expect(larkTrigger(line({ text: `done ${AGENT_MARK}\n` }), false)).toBeUndefined()
  })
  it('take an urgent call to the person as addressing them, even in a muted chat, as a new Trigger of the same message', () => {
    const urgent = larkTrigger(line({ urgent: true, urgent_to_me: true, urgent_type: 'phone', urgent_at: 5 }), true)!
    expect(urgent).toMatchObject({ id: larkTriggerId('m-1', 5), addressed: 'mention', meta: { mentioned: true, muted: true, urgent: true, urgentType: 'phone' } })
    expect(urgent.id).not.toBe(larkTriggerId('m-1'))
    expect([larkScope(urgent.meta), needsJev(urgent)]).toEqual([{ listened: true, observed: false, row: 'mentions' }, false])
    // Marked urgent for someone else: it addresses no one here.
    expect(larkTrigger(line({ urgent: true }), false)).toMatchObject({ id: larkTriggerId('m-1'), meta: { mentioned: false } })
  })
  it('take whether the chat is muted from the message, and from the chat list only when the message does not say', () => {
    expect([larkTrigger(line({ muted: true }), false)!.meta.muted, larkTrigger(line({ muted: false }), true)!.meta.muted,
      larkTrigger(line({ muted: null }), true)!.meta.muted]).toEqual([true, false, true])
  })
  it('put a topic, or a reply chain from its first message, in one Thread', () => {
    expect(larkThreadId(line({ thread_id: 't-1', root_id: 'm-r', reply_to: 'm-0' }))).toBe('chat-1:t-1')
    expect(larkThreadId(line({ root_id: 'm-r', reply_to: 'm-0' }))).toBe('chat-1:m-r')
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
    expect(storedMessage({ message: { id: 'm-3', chat_id: 'chat-1', mentions: [{ id: 'u-9', name: 'Someone' }, 'Other'] } }).mentions).toEqual(['Someone', 'Other'])
  })
})

describe('acting for the person alone', () => {
  it('names an admission row for each part of what the Source receives', () => {
    expect(larkDesktopKind.policy!.rows!({}).map(row => row.id)).toEqual(['direct', 'mentions', 'chats'])
    const rows = new Set([larkScope({ direct: true }), larkScope({ mentioned: true }), larkScope({})].map(scope => scope.listened ? scope.row : ''))
    expect(rows).toEqual(new Set(['direct', 'mentions', 'chats']))
  })
  it('with no list, makes what reaches the person an inferred candidate, bots too, and leaves the rest of the chats alone', () => {
    const settings = SettingsSchema.parse({ eval: { mode: 'observe' }, sources: { 'lark-desktop': { enabled: true, config: {} } },
      policy: { rules: [], sources: { 'lark-desktop': { admission: { direct: { unlistedAddressed: 'inferred' }, mentions: { unlistedAddressed: 'inferred' } } } } } })
    const sources = new SourceRegistry(() => settings, new HealthBoard())
    sources.register(larkDesktopKind)
    const policy = settingsPolicy(settings, sources)
    const thread = { key: 'lark-desktop:x', ref: { source: 'lark-desktop', id: 'x' }, subscriptions: [], queued: [], decisions: [] } as never
    const gate = (overrides: Record<string, unknown>) => policy.gate(larkTrigger(line(overrides), false)!, thread, [])
    expect(gate({ chat_kind: 'direct', sender_is_bot: true })).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', row: 'direct' } })
    expect(gate({ reply_to: 'm-0', addressed_to_me: true })).toMatchObject({ admissible: true, strength: 'inferred', basis: { row: 'mentions' } })
    expect(gate({})).toMatchObject({ admissible: false })
    expect(anyoneAdmitted(settings)).toBe(true)
  })
})

describe('thread context for assessments', () => {
  const stored = (id: string, extra: Record<string, unknown> = {}) => ({ id, sender_id: 'u', sender_name: 'Someone', sent_at: 1000, text: `text ${id}`, ...extra })
  function fake(answers: Record<string, unknown>) {
    const calls: string[] = []
    const commands = { run: vi.fn(async (_cli: string, args: string[]) => { calls.push(args.join(' ')); return JSON.stringify(answers[args[0]!]) }) }
    return { commands: commands as never, calls }
  }
  const read = (trigger: Trigger, part: 'thread' | 'root' | 'parent', commands: never, cursor?: string) =>
    larkDesktopThreadContext.read(commands, trigger, part, cursor, { cli: 'lark-desktop' })
  it('reads the replied-to message and the first message of the chain', async () => {
    const { commands, calls } = fake({ message: { message: stored('m-0', { sender_is_bot: true }), context: [] } })
    const trigger = larkTrigger(line({ reply_to: 'm-0', root_id: 'm-r', reply_to_me: true }), false)!
    expect((await read(trigger, 'parent', commands)).messages).toEqual([{ id: 'm-0', from: 'Someone', at: '1970-01-01T00:00:01.000Z', text: 'text m-0', bot: true }])
    await read(trigger, 'root', commands)
    expect(calls).toEqual(['message m-0 --no-parent', 'message m-r --no-parent'])
    expect((await read(larkTrigger(line(), false)!, 'parent', commands)).status).toBe('no_parent')
  })
  it('reads a topic by pages, a reply chain up to its first message, and else the latest messages of the chat', async () => {
    const { commands, calls } = fake({ thread: { messages: [stored('t-1')], complete: false, older_than: 42 },
      message: { message: stored('m-1', { parent_id: 'm-0' }), context: [stored('m-0')] }, history: { messages: [stored('h-1')], complete: true } })
    expect(await read(larkTrigger(line({ thread_id: 't-1' }), false)!, 'thread', commands)).toMatchObject({ status: 'available', next: '42', messages: [{ id: 't-1' }] })
    await read(larkTrigger(line({ thread_id: 't-1' }), false)!, 'thread', commands, '42')
    expect((await read(larkTrigger(line({ reply_to: 'm-0' }), false)!, 'thread', commands)).messages.map(item => item.id)).toEqual(['m-0', 'm-1'])
    expect(await read(larkTrigger(line(), false)!, 'thread', commands)).toMatchObject({ status: 'chat_recent', next: undefined })
    expect(calls).toEqual(['thread t-1 --limit 20', 'thread t-1 --limit 20 --before-position 42', 'message m-1 --chain 10', 'history chat-1 --limit 20'])
  })
})

describe('the Channel', () => {
  const outgoing = (address: Record<string, string>) => ({ id: 'out-1', kind: 'reply' as const, text: 'Done', channel: { source: 'lark-desktop', thread: 'lark-desktop:x', address } })
  const host = (run: (cli: string, args: string[]) => Promise<string>) => ({ commands: { run: vi.fn(run) } }) as never
  it('replies in the person\'s name under the message, once per outgoing id, in its topic when it has one', async () => {
    const seen: string[][] = []
    const ok = host(async (_cli, args) => { seen.push(args); return JSON.stringify({ message_id: 'sent-1' }) })
    expect(await sendLarkDesktop(ok, outgoing({ chatId: 'c', messageId: 'm-1' }))).toBe('sent')
    expect(await sendLarkDesktop(ok, outgoing({ chatId: 'c', messageId: 'm-1', topic: 'true' }))).toBe('sent')
    expect(seen).toEqual([['reply', 'm-1', '--consumer', 'dsh-superagent', '--text', 'Done', '--idempotency-key', 'out-1', '--yes'],
      ['reply', 'm-1', '--consumer', 'dsh-superagent', '--in-thread', '--text', 'Done', '--idempotency-key', 'out-1', '--yes']])
  })
  it('drops a reply whose message is gone, and retries one without a message id or after another failure', async () => {
    expect(await sendLarkDesktop(host(async () => { throw new CliError('{"error": "message_not_found"}') }), outgoing({ chatId: 'c', messageId: 'm-1' }))).toBe('gone')
    expect(await sendLarkDesktop(host(async () => ''), outgoing({ chatId: 'c' }))).toBe('gone')
    await expect(sendLarkDesktop(host(async () => '{}'), outgoing({ chatId: 'c', messageId: 'm-1' }))).rejects.toThrow('without a message id')
    await expect(sendLarkDesktop(host(async () => { throw new CliError('timed out') }), outgoing({ chatId: 'c', messageId: 'm-1' }))).rejects.toThrow('timed out')
  })
  it('splits a text into messages on --- lines, each a reply or, after [单发], a message of its own, with its mentions', () => {
    expect(larkParts('Hi @[Ada](1234567), done\n---\n[单发]\n1\n---\n@[Bo] and @[Ada](1234567)')).toEqual([
      { text: 'Hi @Ada, done', standalone: false, mentions: ['1234567:Ada'] }, { text: '1', standalone: true, mentions: [] },
      { text: '@Bo and @Ada', standalone: false, mentions: ['Bo', '1234567:Ada'] }])
    expect(larkParts('plain')).toEqual([{ text: 'plain', standalone: false, mentions: [] }])
  })
  it('sends separate messages with stable keys and keeps a standalone message in its topic', async () => {
    const seen: string[][] = []
    const ok = host(async (_cli, args) => { seen.push(args); return JSON.stringify({ message_id: `sent-${seen.length}` }) })
    const message = { ...outgoing({ chatId: 'c', messageId: 'm-1' }), text: '[单发] 1\n---\n2 @[Ada](1234567)' }
    expect(await sendLarkDesktop(ok, message)).toBe('sent')
    expect(seen).toEqual([['send', 'c', '--text', '1', '--idempotency-key', 'out-1-1', '--yes'],
      ['reply', 'm-1', '--consumer', 'dsh-superagent', '--text', '2 @Ada', '--mention', '1234567:Ada', '--idempotency-key', 'out-1-2', '--yes']])
    seen.length = 0
    await sendLarkDesktop(ok, { ...outgoing({ chatId: 'c', messageId: 'm-1', topic: 'true' }), text: '[单发] 1' })
    expect(seen[0]!.slice(0, 2)).toEqual(['reply', 'm-1'])
  })
  it.each(['mention_not_found', 'mention_ambiguous'])('does not send a plain-text mention when %s', async code => {
    const seen: string[][] = []
    const fail = host(async (_cli, args) => { seen.push(args); throw new CliError(JSON.stringify({ error: code })) })
    await expect(sendLarkDesktop(fail, { ...outgoing({ chatId: 'c', messageId: 'm-1' }), text: 'Hi @[Nobody]' })).rejects.toThrow(code)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('--mention')
  })
  it('does not silently turn a standalone message into a reply when its chat is missing', async () => {
    const send = vi.fn(async () => '{"message_id":"sent-1"}')
    await expect(sendLarkDesktop(host(send), { ...outgoing({ messageId: 'm-1' }), text: '[单发] hello' })).rejects.toThrow('无法单独发送')
    expect(send).not.toHaveBeenCalled()
  })
  it('does not discard an entire batch when an earlier part was sent before the target disappeared', async () => {
    let calls = 0
    const fail = host(async () => { if (calls++) throw new CliError('{"error": "message_not_found"}'); return '{"message_id":"sent-1"}' })
    await expect(sendLarkDesktop(fail, { ...outgoing({ chatId: 'c', messageId: 'm-1' }), text: 'first\n---\nsecond' })).rejects.toThrow('message_not_found')
  })
  it('gives every message an address under the message itself', () => {
    expect(larkTrigger(line({ thread_id: 't-1' }), false)!.channel).toEqual({ source: 'lark-desktop', thread: 'lark-desktop:chat-1:t-1', address: { chatId: 'chat-1', messageId: 'm-1', topic: 'true' } })
  })
})

describe('desktop notifications', () => {
  const ticket = (overrides: Record<string, unknown> = {}) => ({ id: 't-1', title: 'Answer Ada', updatedAt: new Date(0).toISOString(),
    assignments: [{ id: 'a-1', state: 'ended', report: { state: 'blocked', summary: 'needs a token' } }], inputs: [], undelivered: [], ...overrides }) as never
  function setup(tickets: unknown[]) {
    const state = new Map<string, unknown>()
    const shown: DesktopNotice[] = []
    const failures: { id: string; ticketId?: string; error: string }[] = []
    const ctx = { state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) }, keys: () => [] },
      tickets: { open: () => tickets, get: (id: string) => (tickets as { id: string }[]).find(item => item.id === id) },
      report: vi.fn(), atomic: (work: () => unknown) => work(), outgoingFailures: () => failures }
    const config = { notify: true, notifier: 'terminal-notifier', panelUrl: 'http://127.0.0.1:3082/' }
    const notifier = new DesktopNotifier((notice, _config, started) => { shown.push(notice); started() })
    notifier.use(ctx as never, config)
    return { notifier, shown, ctx, config, state, failures }
  }
  it('reports an actual failure to start the notification program', async () => {
    const error = await new Promise<Error>((resolve, reject) => showDesktop({ key: 'test', title: 'test', message: 'test' },
      { notify: true, notifier: '/nonexistent-notifier-for-test', panelUrl: '' }, () => reject(new Error('unexpected start')), resolve))
    expect(error).toMatchObject({ code: 'ENOENT' })
  })
  it('keeps an unshown notice in SQLite across a notifier failure and a database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lark-notice-'))
    const path = join(directory, 'state.sqlite')
    const config = { notify: true, notifier: 'terminal-notifier', panelUrl: '' }
    const contexts = (store: Store) => ({ state: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value), keys: () => [] },
      tickets: { open: () => [ticket()], get: () => ticket() }, report: vi.fn(), atomic: (work: () => unknown) => store.atomic(work), outgoingFailures: () => [] })
    let store = new Store(path)
    try {
      let ctx = contexts(store)
      const bad = new DesktopNotifier((_notice, _config, _started, failed) => failed(new Error('ENOENT')))
      bad.use(ctx as never, config); bad.check()
      expect(Object.keys(store.get(KV.larkDesktop.pendingNotices) ?? {})).toHaveLength(1)
      expect(ctx.report).toHaveBeenCalledWith('lark-desktop-notifications', expect.objectContaining({ state: 'error' }))
      store.close(); store = new Store(path); ctx = contexts(store)
      const shown: DesktopNotice[] = []
      const recovered = new DesktopNotifier((notice, _config, started) => { shown.push(notice); started() })
      recovered.use(ctx as never, config); recovered.check(); recovered.check()
      expect(shown).toHaveLength(1)
      expect(store.get(KV.larkDesktop.pendingNotices)).toEqual({})
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('announces a failed outbound message even when its ticket is no longer open', () => {
    const { notifier, shown, failures } = setup([])
    failures.push({ id: 'out-1', error: '结果未确认' })
    notifier.check(); notifier.check()
    expect(shown).toEqual([expect.objectContaining({ title: '飞书消息未确认', message: '结果未确认' })])
  })
  it('does not let an acknowledgement suppress a later ready report, but a matching result reply does', () => {
    const reportAt = new Date(1000).toISOString()
    const ready = ticket({ updatedAt: reportAt, assignments: [{ id: 'a-1', state: 'ended', report: { state: 'ready', summary: 'done', at: reportAt } }] })
    const first = setup([ready])
    const message = { id: 'out-1', kind: 'acknowledgement' as const, text: '收到', ticketId: 't-1', channel: { source: 'lark-desktop', thread: 'x', address: {} } }
    first.notifier.replied(message, ['收到']); first.notifier.check(1000 + REVIEW_GRACE_MS)
    expect(first.shown.map(item => item.title)).toEqual(['我已替你处理：Answer Ada', '做好了，等你看：Answer Ada'])
    const second = setup([ready])
    second.notifier.replied({ ...message, kind: 'reply', resultOf: { assignmentId: 'a-1', reportedAt: reportAt } }, ['完成'])
    second.notifier.check(1000 + REVIEW_GRACE_MS)
    expect(second.shown.map(item => item.title)).toEqual(['我已替你处理：Answer Ada'])
  })
  it('keeps deduplication for all open tickets even when there are more than 500', () => {
    const tickets = Array.from({ length: 501 }, (_, index) => ticket({ id: `t-${index}` }))
    const { notifier, shown } = setup(tickets)
    notifier.check(); notifier.check()
    expect(shown).toHaveLength(501)
  })
  it('links a notice to its ticket on the panel', () => {
    expect([ticketLink('http://127.0.0.1:3082/', 't-1'), ticketLink('', 't-1')]).toEqual(['http://127.0.0.1:3082/#superagent=execution/t-1', undefined])
  })
  it('announces a reply in the person\'s name once, and a ticket waiting for them once per report', () => {
    const { notifier, shown } = setup([ticket()])
    const message = { id: 'out-1', kind: 'reply' as const, text: '好', ticketId: 't-1', channel: { source: 'lark-desktop', thread: 'x', address: {} } }
    notifier.replied(message, ['好']); notifier.replied(message, ['好'])
    notifier.check(); notifier.check()
    expect(shown.map(item => [item.title, item.message])).toEqual([['我已替你处理：Answer Ada', '回复：好'], ['卡住了，需要你：Answer Ada', 'needs a token']])
  })
  it('announces a ticket ready for review only after a grace and when no reply announced it', () => {
    const ready = ticket({ updatedAt: new Date(1000).toISOString(), assignments: [{ id: 'a-1', state: 'ended', report: { state: 'ready', summary: 'MR approved' } }] })
    const { notifier, shown } = setup([ready])
    notifier.check(1000 + REVIEW_GRACE_MS - 1)
    expect(shown).toEqual([])
    notifier.check(1000 + REVIEW_GRACE_MS)
    expect(shown.map(item => item.title)).toEqual(['做好了，等你看：Answer Ada'])
  })
})

describe('Jev, layer one', () => {
  it('asks only about messages that neither address the person nor come from a muted chat', () => {
    expect([needsJev(larkTrigger(line(), false)!), needsJev(larkTrigger(line({ chat_kind: 'direct' }), false)!),
      needsJev(larkTrigger(line({ is_at_me: true }), false)!), needsJev(larkTrigger(line(), true)!)]).toEqual([true, false, false, false])
  })
  it('keeps its score, and leaves out a message below the threshold only when it filters', () => {
    const trigger = larkTrigger(line(), false)!
    expect(withJev(trigger, 0.1234).meta).toMatchObject({ jev: 0.123 })
    expect(larkScope(withJev(trigger, 0.1234).meta)).toMatchObject({ listened: true })
    expect(larkScope(withJev(trigger, 0.2, 50).meta)).toEqual({ listened: false, reason: 'lark_desktop_jev' })
    expect(larkScope(withJev(trigger, 0.8, 50).meta)).toMatchObject({ listened: true })
  })
  it('asks one question per message about whether the person needs it, with the messages as the state', () => {
    const { state, questions } = jevBatch([line(), line({ message_id: 'm-2', sender_is_bot: true, text: 'x'.repeat(5000) })])
    expect(Object.keys(questions)).toEqual(['m0', 'm1'])
    expect(questions.m1).toMatchObject({ type: 'noul', instructions: expect.stringContaining('第 2 条') })
    expect((state as { messages: { bot: boolean; text: string }[] }).messages.map(item => [item.bot, item.text.length])).toEqual([[false, 18], [true, 1000]])
  })
  it('asks once for a batch, and lets every message of a failed batch or a missing answer through unscored', async () => {
    const ask = vi.fn<JevAsk>(async (_state, questions) => Object.fromEntries(Object.keys(questions).slice(0, 1).map(id => [id, 0.9])))
    const failed = vi.fn()
    const batcher = new JevBatcher(ask, new AbortController().signal, failed)
    const scores = Promise.all([batcher.score(line()), batcher.score(line({ message_id: 'm-2' }))])
    await batcher.flush()
    expect(await scores).toEqual([0.9, undefined])
    expect(ask).toHaveBeenCalledTimes(1)
    const broken = new JevBatcher(async () => { throw new Error('offline') }, new AbortController().signal, failed)
    const lost = broken.score(line()); await broken.flush()
    expect([await lost, failed.mock.calls.at(-1)?.[0]?.message]).toEqual([undefined, 'offline'])
  })
  it('sends the key to Jev, and names a missing key or a refusal', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({ answers: { m0: { type: 'noul', noul: 0.7 }, m1: {} } }),
      { status: (init?.headers as Record<string, string>).authorization === 'Bearer k' ? 200 : 403 }))
    const signal = new AbortController().signal
    expect(await httpJev(async () => 'k', fetcher as typeof fetch)({}, {}, signal)).toEqual({ m0: 0.7 })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: 'jev-latest', state: {}, questions: {} })
    await expect(httpJev(async () => undefined, fetcher as typeof fetch)({}, {}, signal)).rejects.toThrow('no TYPESAFE_API_KEY')
    await expect(httpJev(async () => 'wrong', fetcher as typeof fetch)({}, {}, signal)).rejects.toThrow('HTTP 403')
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
    // As lark-desktop returns one message: whom it mentions comes as objects, unlike a watch line's names.
    const stored = JSON.stringify({ message: { id: 'm-expired', chat_id: 'chat-open', chat_kind: 'group', sender_id: 'user-2', sent_at: 1, text: 'read again', parent_id: 'm-root',
      mentions: [{ id: 'u-9', name: 'Someone' }] } })
    writeFileSync(path, `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1" in
  chats) echo '${chats}' ;;
  message) echo '${stored}' | sed "s/m-expired/$2/" ;;
  watch) echo 'LARK_DESKTOP_READY' >&2; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
    return path
  }
  function source(path: string, config: Record<string, unknown> = {}) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { 'lark-desktop': { enabled: true, config: { cli: path, ...config } } } }))
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
  it('takes in what reaches the person, leaves a muted chat out, rereads an expired body, and keeps a line that fails for later', async () => {
    const lines = [line({ message_id: 'm-dm', chat_id: 'dm-1', chat_kind: 'direct' }), line({ message_id: 'm-at', chat_id: 'chat-muted', is_at_me: true }),
      line({ message_id: 'm-muted', chat_id: 'chat-muted' }), line({ message_id: 'm-open', chat_id: 'chat-open' }),
      line({ message_id: 'm-mine', chat_id: 'chat-open', text: `on it ${AGENT_MARK}` }), { message_id: 'm-expired', body_expired: true },
      // The muted message again, once someone urgently called the person on it.
      line({ message_id: 'm-muted', chat_id: 'chat-muted', urgent: true, urgent_to_me: true, addressed_to_me: true, urgent_type: 'app', urgent_at: 7 }),
      line({ message_id: 'm-re', chat_id: 'chat-open', reply_to: 'm-root', reply_to_me: true }),
      // A line its intake cannot take in: it has no chat.
      { message_id: 'm-bad', text: 'no chat' },
      { event: 'stale_lamp', message_id: 'm-open' }, { event: 'problem', kind: 'push_missing', detail: 'no push for a while' }]
    writeFileSync(join(dir, 'events'), lines.map(item => JSON.stringify(item)).join('\n') + '\n')
    const { ctx, health, store } = source(cli())
    // A line kept from an earlier run, which the watch takes in again once it subscribes.
    store.set(KV.larkDesktop.parked, { 'm-seeded': { line: JSON.stringify({ message_id: 'm-seeded', body_expired: true }), tries: 1, error: 'earlier', at: '' } })
    running = runLarkDesktop(ctx, controller.signal)
    await vi.waitFor(() => expect(health['lark-desktop']).toMatchObject({ state: 'error', detail: expect.stringContaining('push_missing') }), until)
    await vi.waitFor(() => expect(store.triggers.get(larkTriggerId('m-seeded'))).toBeDefined(), until)
    expect(Object.keys(store.get(KV.larkDesktop.parked) ?? {})).toEqual(['m-bad'])
    expect(store.get(KV.larkDesktop.parked)?.['m-bad']).toMatchObject({ tries: 1 })
    const got = (id: string) => store.triggers.get(larkTriggerId(id))
    expect([got('m-dm')?.addressed, got('m-at')?.addressed, got('m-open')?.addressed]).toEqual(['direct', 'mention', undefined])
    expect(store.triggers.disposition(larkTriggerId('m-muted'))?.filtered).toMatchObject({ code: 'lark_desktop_muted' })
    expect(store.triggers.get(larkTriggerId('m-muted', 7))).toMatchObject({ addressed: 'mention', meta: { urgent: true, urgentType: 'app' } })
    expect(store.triggers.disposition(larkTriggerId('m-muted', 7))?.filtered).toBeUndefined()
    expect(got('m-open')?.meta.muted).toBe(false)
    expect(got('m-mine')).toBeUndefined()
    expect(got('m-expired')).toMatchObject({ text: 'read again', threads: [{ id: 'chat-open:m-root' }] })
    // Read-only: it lists the chats, subscribes without status emoji, and reads one message; it writes nothing.
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
    // A reply to the person carries the message it answers.
    expect(got('m-re')).toMatchObject({ quoted: { from: 'user-2', text: 'read again' } })
    expect(calls.sort()).toEqual(['chats --all', 'watch dsh-superagent --scope others --no-ack', 'message m-expired --no-parent', 'message m-root --no-parent',
      'message m-seeded --no-parent'].sort())
    controller.abort(); await running; store.close()
  }, 20_000)
  it('scores the chat messages that address no one with Jev, and leaves out the low ones only while it filters', async () => {
    writeFileSync(join(dir, 'events'), [line({ message_id: 'm-dm', chat_id: 'dm-1', chat_kind: 'direct' }), line({ message_id: 'm-low', chat_id: 'chat-open' }),
      line({ message_id: 'm-high', chat_id: 'chat-open', text: 'the build is red' })].map(item => JSON.stringify(item)).join('\n') + '\n')
    const asked: string[] = []
    const jev: JevAsk = async state => {
      const texts = (state as { messages: { text: string }[] }).messages.map(item => item.text)
      asked.push(...texts)
      return Object.fromEntries(texts.map((text, index) => [`m${index}`, text.includes('red') ? 0.9 : 0.1]))
    }
    const { ctx, store } = source(cli(), { jev: 'filter', jevMinimum: 50 })
    running = runLarkDesktop(ctx, controller.signal, { jev })
    await vi.waitFor(() => expect(store.triggers.get(larkTriggerId('m-high'))).toBeDefined(), until)
    expect(store.triggers.get(larkTriggerId('m-high'))?.meta).toMatchObject({ jev: 0.9 })
    expect(store.triggers.disposition(larkTriggerId('m-low'))?.filtered).toMatchObject({ code: 'lark_desktop_jev' })
    // The direct message never went to Jev.
    expect(store.triggers.get(larkTriggerId('m-dm'))?.meta).not.toHaveProperty('jev')
    expect(asked).toEqual(['please take a look', 'the build is red'])
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reports a lark-desktop it cannot find, and waits while the Source is off', async () => {
    const check = vi.spyOn(desktop, 'check').mockImplementation(() => {})
    const { ctx, health, store } = source(join(dir, 'missing'))
    running = runLarkDesktop(ctx, controller.signal)
    await vi.waitFor(() => expect(health['lark-desktop']).toMatchObject({ state: 'error', detail: expect.stringContaining('is not an executable file') }), until)
    expect(check).toHaveBeenCalled()
    check.mockRestore()
    store.saveSettings(SettingsSchema.parse({ sources: { 'lark-desktop': { enabled: false, config: {} } } }))
    await vi.waitFor(() => expect(health['lark-desktop']).toMatchObject({ state: 'paused' }), { timeout: 15_000 })
    expect(existsSync(join(dir, 'calls'))).toBe(false)
    controller.abort(); await running; store.close()
  }, 25_000)
})
