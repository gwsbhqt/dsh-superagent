/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Held, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'read'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  /** Records that a person handled an uncertain message without sending it again. */
  resolveUncertain(id: string): boolean {
    const { store, effects } = this.host
    return store.atomic(() => {
      const receipt = store.receipts.get(id)
      if (receipt?.status !== 'pending' || receipt.channel.source !== 'lark-desktop' || !receipt.deliveryAttempt
        || !store.read.failingReplies().some(item => item.id === id && item.held)) return false
      store.receipts.settle(receipt, 'personResolved')
      effects.cancel('reply', id)
      return true
    })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    const guarded = receipt.channel.source === 'lark-desktop'
    if (guarded && receipt.deliveryAttempt) throw new Held('飞书消息上次发送时结果未确认，已暂停自动重发；请先查看飞书，确认每条消息的实际情况。')
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    if (guarded) store.receipts.beginDelivery(id)
    let result: 'sent' | 'gone' | 'waiting'
    try { result = await sources.send(receipt, commands) }
    catch (error) {
      if (!guarded) throw error
      throw new Held(`飞书消息发送未完成，可能已经发出部分或全部；已暂停自动重发，请先查看飞书。原因：${String(error)}`)
    }
    if (result === 'waiting') {
      if (guarded) store.receipts.clearDelivery(id)
      throw new Later('The Source is not installed')
    }
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
