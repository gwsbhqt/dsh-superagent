/**
 * Thread context of the lark-desktop Source for assessments: the replied-to message, the topic's or reply chain's first
 * message, and the messages of the topic, the reply chain, or the chat, read through the lark-desktop CLI.
 */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'

/** Messages one page of a topic or a chat reads, and the replies a reply chain walks up. */
const PAGE = 20, CHAIN = 10
/** One message as lark-desktop's reads return it, with the client's field names. */
const ClientMessageSchema = z.looseObject({ id: z.string(), sender_id: z.string().nullish(), sender_name: z.string().nullish(),
  sender_is_bot: z.boolean().nullish(), sent_at: z.number().nullish(), text: z.string().nullish(), parent_id: z.string().nullish(),
  recalled: z.boolean().nullish() })
const OneSchema = z.looseObject({ message: ClientMessageSchema, context: z.array(ClientMessageSchema).default([]) })
const PageSchema = z.looseObject({ messages: z.array(ClientMessageSchema).default([]), complete: z.boolean().nullish(),
  older_than: z.number().nullish() })

/** A lark-desktop message as assessments read it. */
export function larkView(message: z.infer<typeof ClientMessageSchema>): ContextMessage {
  return { id: message.id, from: message.sender_name || message.sender_id || '', at: new Date(message.sent_at ?? 0).toISOString(),
    text: message.recalled ? '' : message.text ?? '', ...message.sender_is_bot ? { bot: true } : {}, ...message.recalled ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {} }
}
const read = async (commands: Commands, cli: string, args: string[]): Promise<unknown> => JSON.parse(await commands.run(cli, args))
const one = async (commands: Commands, cli: string, id: string, status: string): Promise<ContextPart> => {
  const message = larkView(OneSchema.parse(await read(commands, cli, ['message', id, '--no-parent'])).message)
  return { messages: [message], body: { status, message }, status }
}
const none = (status: string): ContextPart => ({ messages: [], body: { status, messages: [] }, status })
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** Reads the topic of a message, else the reply chain it ends, else the latest messages of its chat. */
async function thread(commands: Commands, cli: string, trigger: Trigger, cursor: string | undefined): Promise<ContextPart> {
  const { threadId, replyTo, messageId, chatId } = trigger.meta
  const before = cursor ? ['--before-position', cursor] : []
  if (text(threadId) || !text(replyTo)) {
    const args = text(threadId) ? ['thread', String(threadId), '--limit', String(PAGE), ...before] : ['history', String(chatId), '--limit', String(PAGE), ...before]
    const page = PageSchema.parse(await read(commands, cli, args))
    const status = text(threadId) ? 'available' : 'chat_recent'
    const messages = page.messages.map(larkView)
    const next = page.complete === false && page.older_than !== null && page.older_than !== undefined ? String(page.older_than) : undefined
    return { messages, next, body: { status, messages, ...next ? { next } : {} }, status }
  }
  // A reply chain outside a topic has no page of its own: walk up from the message to the first one.
  const chain = OneSchema.parse(await read(commands, cli, ['message', String(messageId), '--chain', String(CHAIN)]))
  const messages = [...chain.context, chain.message].map(larkView)
  return { messages, body: { status: 'reply_chain', messages }, status: 'reply_chain' }
}

export const larkDesktopThreadContext: ThreadContext<{ cli: string }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    if (part === 'parent') return text(trigger.meta.replyTo) ? one(commands, config.cli, String(trigger.meta.replyTo), 'available') : none('no_parent')
    if (part === 'root') {
      const root = text(trigger.meta.rootId) ?? text(trigger.meta.threadId)
      return root && root !== trigger.meta.messageId ? one(commands, config.cli, root, 'available') : none('no_root')
    }
    return thread(commands, config.cli, trigger, cursor)
  },
}
