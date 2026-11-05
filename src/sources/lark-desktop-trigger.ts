/**
 * lark-desktop messages as Triggers. The lark-desktop CLI reads the person's own Feishu or Lark desktop client, so this
 * Source sees what reaches that person: direct messages, mentions and replies, and the chats they did not mute.
 */
import { z } from 'zod'
import { key, type ScopeResult, type Trigger } from '../core/index.ts'

export const SOURCE = 'lark-desktop'
/** Messages that an agent sent through lark-desktop as the person end with this mark; they are never new work. */
export const AGENT_MARK = '🤖'

/** One message as `lark-desktop watch` prints it, or as `lark-desktop message` returns it once normalized by `storedMessage`. */
export const WatchedMessageSchema = z.looseObject({
  message_id: z.string().min(1), chat_id: z.string().min(1), chat_name: z.string().nullish(),
  chat_kind: z.string().nullish(), sender_id: z.string().nullish(), sender_name: z.string().nullish(),
  sender_is_bot: z.boolean().nullish(), sent_at: z.number().nullish(), text: z.string().nullish(),
  thread_id: z.string().nullish(), reply_to: z.string().nullish(), is_at_me: z.boolean().nullish(),
  addressed_to_me: z.boolean().nullish(), mentions: z.array(z.string()).nullish(), recalled: z.boolean().nullish(),
  media: z.array(z.unknown()).nullish(),
})
export type WatchedMessage = z.infer<typeof WatchedMessageSchema>
/** A line of `lark-desktop watch` for a message whose body expired before it was read; `lark-desktop message` reads it again. */
export const ExpiredLineSchema = z.looseObject({ message_id: z.string().min(1), body_expired: z.literal(true) })
/** A line of `lark-desktop watch` that is no message: a problem the receiving process found, or a status emoji left too long. */
export const NoticeLineSchema = z.looseObject({ event: z.string(), kind: z.string().nullish(), detail: z.unknown().optional() })

/** `lark-desktop message <id> --no-parent` names the fields as the client stores them; this gives them the watch line's names. */
export function storedMessage(output: unknown): WatchedMessage {
  const { message } = z.looseObject({ message: z.looseObject({ id: z.string(), parent_id: z.string().nullish() }) }).parse(output)
  const { id, parent_id: parent, ...rest } = message
  return WatchedMessageSchema.parse({ ...rest, message_id: id, ...parent ? { reply_to: parent } : {} })
}

/** A Thread is a topic, or a message and the direct replies to it, in one chat. */
export const larkThreadId = (message: Pick<WatchedMessage, 'chat_id' | 'thread_id' | 'reply_to' | 'message_id'>): string =>
  `${message.chat_id}:${message.thread_id || message.reply_to || message.message_id}`
export const larkTriggerId = (messageId: string): string => key(SOURCE, messageId)

/**
 * The Trigger of one message, or none for a recalled message and one an agent sent as the person. `muted` says whether the
 * person muted the chat when the message arrived; the Source's scope reads it from `meta`.
 */
export function larkTrigger(message: WatchedMessage, muted: boolean, now: () => number = Date.now): Trigger | undefined {
  const text = message.text ?? ''
  if (message.recalled || text.trimEnd().endsWith(AGENT_MARK)) return undefined
  const direct = message.chat_kind === 'direct'
  const mentioned = !direct && (message.is_at_me === true || message.addressed_to_me === true)
  return {
    id: larkTriggerId(message.message_id), source: SOURCE, threads: [{ source: SOURCE, id: larkThreadId(message) }],
    actor: { source: SOURCE, id: message.sender_id ?? '' },
    human: !!message.sender_id && message.sender_is_bot !== true,
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: new Date(message.sent_at ?? now()).toISOString(), text,
    meta: {
      chatId: message.chat_id, messageId: message.message_id, direct, mentioned, muted,
      ...(message.chat_name ? { chatName: message.chat_name } : {}), ...(message.sender_name ? { senderName: message.sender_name } : {}),
      ...(message.thread_id ? { threadId: message.thread_id } : {}), ...(message.reply_to ? { replyTo: message.reply_to } : {}),
      ...(message.media?.length ? { media: true } : {}),
    },
  }
}
/** Whether a message goes to Jev: one that neither addresses the person nor comes from a muted chat, which the scope leaves out anyway. */
export const needsJev = (trigger: Trigger): boolean => trigger.meta.direct !== true && trigger.meta.mentioned !== true && trigger.meta.muted !== true
/**
 * Records Jev's probability that the person needs a message, and with `minimum` (a percentage) whether it falls below it,
 * which the scope then leaves out. The verdict is kept in `meta` so a later change of the threshold does not change what was received.
 */
export function withJev(trigger: Trigger, score: number, minimum?: number): Trigger {
  const dropped = minimum !== undefined && score * 100 < minimum
  return { ...trigger, meta: { ...trigger.meta, jev: Math.round(score * 1000) / 1000, ...(dropped ? { jevDropped: true } : {}) } }
}

/**
 * What the Source receives: every direct message and every message that mentions or replies to the person, and the other
 * messages of a chat only while the person has not muted it and Jev, when it filters, did not judge them unneeded.
 */
export function larkScope(meta: Record<string, unknown>): ScopeResult {
  if (meta.direct === true) return { listened: true, observed: true, row: 'direct' }
  if (meta.mentioned === true) return { listened: true, observed: false, row: 'mentions' }
  if (meta.muted === true) return { listened: false, reason: 'lark_desktop_muted' }
  if (meta.jevDropped === true) return { listened: false, reason: 'lark_desktop_jev' }
  return { listened: true, observed: true, row: 'chats' }
}
