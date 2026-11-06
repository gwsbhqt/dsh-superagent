/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
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
