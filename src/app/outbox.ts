/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import { key, type OutboundMessage, type Outbox as OutboxPort, type ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Held, Later, type Effects } from './effects.ts'
import type { Receipt, Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'read' | 'tickets' | 'triggers' | 'settings' | 'get' | 'set'>
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
    store.atomic(() => {
      const secured = this.outboundRestricted(message) ? { ...message, outboundRestricted: true as const } : message
      if (store.receipts.add(secured)) effects.enqueue('reply', message.id, {})
    })
  }
  private outboundRestricted(message: OutboundMessage): boolean {
    const { store } = this.host
    const ticket = message.ticketId ? store.tickets.get(message.ticketId) : undefined
    const rules = ticket?.mandate.basis.rules ?? []
    if (!ticket) return false
    const matched = store.settings().policy.rules.filter(rule => rules.includes(rule.id))
    if (matched.some(rule => rule.noExternalReply)) return true
    if (!matched.some(rule => rule.noSourceReply)) return false
    const origin = store.triggers.get(ticket.origin.triggerId)?.channel ?? ticket.channels[0]
    if (!origin) return message.channel.source === ticket.mandate.actor.source
    if (message.channel.source !== origin.source) return false
    if (origin.source !== 'lark-desktop') return message.channel.thread === origin.thread
    const chat = message.channel.address.chatId, originalChat = origin.address.chatId
    return !chat || !originalChat || chat === originalChat
  }
  private recipientKnown(message: OutboundMessage): boolean {
    if (message.channel.source !== 'lark-desktop' || !message.ticketId) return true
    const { store } = this.host
    const ticket = store.tickets.get(message.ticketId)
    if (!ticket || !message.channel.address.messageId) return false
    const ids = new Set([ticket.origin.triggerId, ...(ticket.origin.triggerIds ?? []),
      ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])
    const target = [...ids].map(id => store.triggers.get(id)).find(trigger => trigger?.channel?.source === 'lark-desktop'
      && trigger.channel.address.chatId === message.channel.address.chatId && trigger.channel.address.messageId === message.channel.address.messageId)
    return typeof target?.meta.senderIsBot === 'boolean'
  }
  private keepForOwner(receipt: Receipt, reason: 'internalOnly' | 'recipientUnknown'): void {
    const { store } = this.host
    store.atomic(() => {
      if (receipt.ticketId && (receipt.kind !== 'acknowledgement' || reason === 'recipientUnknown')) {
        const ticket = store.tickets.get(receipt.ticketId)
        const noticeKey = `internal-result:${receipt.id}`
        if (!store.get(KV.larkDesktop.notified)?.[noticeKey]) {
          const pending = store.get(KV.larkDesktop.pendingNotices) ?? {}
          const title = reason === 'recipientUnknown' ? '收件人身份未确认' : receipt.kind === 'notice' ? '任务更新' : '任务结果'
          const message = reason === 'recipientUnknown' ? '原消息没有记录发件人身份，回复没有发送。打开任务查看。'
            : receipt.text.replace(/\s+/g, ' ').trim().slice(0, 180)
          pending[noticeKey] = { key: noticeKey, title: ticket ? `${title}：${ticket.title}` : title, message, ticketId: receipt.ticketId }
          store.set(KV.larkDesktop.pendingNotices, pending)
        }
      }
      store.receipts.settle(receipt, reason)
    })
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
    const attention = receipt.ticketId ? store.tickets.get(receipt.ticketId)?.attention : undefined
    if (guarded && attention && receipt.id === key('attention-reply', attention.id)) {
      const asker = attention.target === 'requester' && attention.triggerId ? store.triggers.get(attention.triggerId) : undefined
      if (!asker?.human || asker.meta.senderIsBot !== false || !asker.channel || asker.channel.thread !== receipt.channel.thread
        || asker.channel.source !== receipt.channel.source || asker.channel.address.chatId !== receipt.channel.address.chatId
        || asker.channel.address.messageId !== receipt.channel.address.messageId) {
        store.receipts.settle(receipt, 'ownerAttention')
        return
      }
    }
    if (receipt.outboundRestricted || this.outboundRestricted(receipt)) { this.keepForOwner(receipt, 'internalOnly'); return }
    if (!this.recipientKnown(receipt)) { this.keepForOwner(receipt, 'recipientUnknown'); return }
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
