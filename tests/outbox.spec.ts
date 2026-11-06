/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { larkDesktopKind } from '../src/sources/lark-desktop.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('does not resend a lark message when the remote write may have succeeded before an error', async () => {
  h.runtime.sources.register(larkDesktopKind)
  const send = vi.spyOn(h.runtime.sources, 'send').mockRejectedValue(new Error('send_unconfirmed'))
  h.runtime.outbox.send({ id: 'uncertain', channel: { source: 'lark-desktop', thread: 'lark-desktop:x', address: { messageId: 'm-1' } }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect(send).toHaveBeenCalledTimes(1)
  expect(h.runtime.store.receipts.get('uncertain')).toMatchObject({ status: 'pending', deliveryAttempt: expect.any(String) })
  expect(h.runtime.store.read.failingReplies()).toEqual([expect.objectContaining({ id: 'uncertain', error: expect.stringContaining('暂停自动重发') })])
  await at(1_000_000)
  expect(send).toHaveBeenCalledTimes(1)
  h.runtime.outbox.withdraw('uncertain')
  expect(h.runtime.store.receipts.get('uncertain')).toBeDefined()
})

it('does not allow resolution while a previously failing delivery is still running', async () => {
  h.runtime.sources.register(larkDesktopKind)
  await h.runtime.settings.pause(true, 'panel')
  let finish!: (result: 'sent') => void
  const pending = new Promise<'sent'>(resolve => { finish = resolve })
  const send = vi.spyOn(h.runtime.sources, 'send').mockImplementation(() => pending)
  h.runtime.outbox.send({ id: 'in-flight', channel: { source: 'lark-desktop', thread: 'lark-desktop:x', address: { messageId: 'm-1' } }, text: 'Done', kind: 'reply' })
  h.runtime.store.db.prepare("UPDATE effect SET attempts = 1, error = 'previous failure' WHERE kind = 'reply' AND key = ?").run('in-flight')
  try {
    await h.runtime.settings.pause(false, 'panel')
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(h.runtime.store.read.failingReplies()).toContainEqual(expect.objectContaining({ id: 'in-flight', held: false }))
    expect(h.runtime.outbox.resolveUncertain('in-flight')).toBe(false)
  } finally { finish('sent'); await h.runtime.sendReplies() }
  expect(h.runtime.outbox.status('in-flight')).toBe('sent')
})

it('drops an old unsent owner question and holds one with an uncertain send result', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', 'Fix this'))
  ticket.attention = { id: 'old-question', question: 'Please enable access' }
  h.runtime.store.tickets.save(ticket)
  h.runtime.sources.register(larkDesktopKind)
  await h.runtime.settings.pause(true, 'panel')
  const send = vi.spyOn(h.runtime.sources, 'send').mockResolvedValue('sent')
  const channel = { source: 'lark-desktop', thread: 'lark-desktop:alert', address: { chatId: 'alert', messageId: 'message' } }
  const id = key('attention-reply', 'old-question')
  h.runtime.outbox.send({ id, channel, text: 'Please enable access', kind: 'reply', ticketId: ticket.id })
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(id)).toMatchObject({ status: 'dropped', dropped: { reason: 'ownerAttention' } })
  expect(send).not.toHaveBeenCalled()

  ticket.attention = { id: 'uncertain-question', question: 'Please enable access' }
  h.runtime.store.tickets.save(ticket)
  await h.runtime.settings.pause(true, 'panel')
  const uncertain = key('attention-reply', 'uncertain-question')
  h.runtime.outbox.send({ id: uncertain, channel, text: 'Please enable access', kind: 'reply', ticketId: ticket.id })
  h.runtime.store.receipts.beginDelivery(uncertain)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(uncertain)).toMatchObject({ status: 'pending', deliveryAttempt: expect.any(String) })
  expect(send).not.toHaveBeenCalled()
})

it('enforces a matched rule against the originating chat and keeps the result for the owner', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('1', 'Investigate the alert'))
  const channel = { source: 'lark-desktop', thread: 'lark-desktop:alert', address: { chatId: 'alert', messageId: 'message' } }
  h.runtime.store.triggers.save({ ...trigger, source: 'lark-desktop', channel })
  ticket.channels = [channel]
  ticket.mandate.basis.rules = ['copy']
  h.runtime.store.tickets.save(ticket)
  const settings = h.runtime.store.settings()
  const quiet = { ...settings, policy: { ...settings.policy, rules: settings.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, noSourceReply: true } : rule) } }
  h.runtime.store.saveSettings(quiet)
  h.runtime.sources.register(larkDesktopKind)
  await h.runtime.settings.pause(true, 'panel')
  const send = vi.spyOn(h.runtime.sources, 'send').mockResolvedValue('sent')
  h.runtime.outbox.send({ id: 'quiet-result', channel, text: 'Finished the investigation', kind: 'reply', ticketId: ticket.id })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), policy: settings.policy })
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get('quiet-result')).toMatchObject({ status: 'dropped', dropped: { reason: 'internalOnly' } })
  expect(h.runtime.store.get(KV.larkDesktop.pendingNotices)?.['internal-result:quiet-result']).toMatchObject({ ticketId: ticket.id })
  expect(send).not.toHaveBeenCalled()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), policy: quiet.policy })
  h.runtime.outbox.send({ id: 'other-chat', channel: { ...channel, thread: 'lark-desktop:colleague', address: { chatId: 'colleague', messageId: 'other' } },
    text: 'A permitted answer', kind: 'reply', ticketId: ticket.id })
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(send).toHaveBeenCalledOnce()
  expect(h.runtime.outbox.status('other-chat')).toBe('sent')
  const onlyOwner = { ...quiet.policy, rules: quiet.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, noExternalReply: true } : rule) }
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), policy: onlyOwner })
  h.runtime.outbox.send({ id: 'owner-only', channel: { ...channel, thread: 'lark-desktop:colleague',
    address: { chatId: 'colleague', messageId: 'other' } }, text: 'Question for the owner', kind: 'reply', ticketId: ticket.id })
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(send).toHaveBeenCalledOnce()
  expect(h.runtime.store.receipts.get('owner-only')).toMatchObject({ status: 'dropped', dropped: { reason: 'internalOnly' } })
  expect(h.runtime.store.get(KV.larkDesktop.pendingNotices)?.['internal-result:owner-only']).toMatchObject({ ticketId: ticket.id })
})

it('delivers an owner answer from the panel only to the worker', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', 'Investigate'))
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Needs access', question: 'Have you enabled access?', questionTo: 'owner' })
  const attentionId = h.runtime.store.tickets.get(ticket.id)!.attention!.id
  vi.mocked(Commands.prototype.lark).mockClear()
  const result = await h.api('POST', `tickets/${ticket.id}/answer`, { attentionId, text: 'Yes, enabled' })
  expect(result).toEqual({ status: 200, body: { answered: true } })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  expect(h.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === sessionId && delivery.text.includes('Yes, enabled'))).toBe(true)
  expect(Commands.prototype.lark).not.toHaveBeenCalled()
  expect((await h.api('POST', `tickets/${ticket.id}/answer`, { attentionId, text: 'Different answer' })).status).toBe(400)
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})
