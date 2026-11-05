/**
 * The lark-desktop Source's Channel: it speaks in the person's own name through the lark-desktop CLI, which ends each message
 * with the agent's mark (🤖) so people and this Source tell it from the person's own. An outgoing text may hold several
 * messages, separated by a line of `---`; each is a reply to the message a Thread started from, or, after a first line
 * `[单发]`, a message of its own in that chat. `@[name](user id)` or `@[name]` mentions someone.
 */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, SourceChannel } from './kind.ts'
import { desktop } from './lark-desktop-notify.ts'

/** The CLI the Channel calls; a Channel has no Source configuration, so it is found on the host's PATH. */
export const CHANNEL_CLI = 'lark-desktop'
/** The name lark-desktop records the reply's claim under, so no other subscriber of the person answers the same message. */
export const CHANNEL_CONSUMER = 'dsh-superagent'
/** The first line that makes a part a message of its own rather than a reply. */
export const STANDALONE = '[单发]'
const SentSchema = z.looseObject({ message_id: z.string().min(1) })
/** Errors after which the message can never go to that address: the message it answers or its chat is gone. */
const GONE = /message_not_found|wrong_chat|chat_not_found|not a member|取不到/
/** lark-desktop could not tell whom a name means. */
const UNKNOWN_NAME = /mention_not_found|mention_ambiguous/

export interface LarkPart { text: string; standalone: boolean; mentions: string[] }
/** The messages an outgoing text holds, with their mentions as lark-desktop takes them: `id:name`, or a name it looks up in the chat. */
export function larkParts(text: string): LarkPart[] {
  return text.split(/\n[ \t]*-{3,}[ \t]*\n/).map(raw => raw.trim()).filter(Boolean).map(raw => {
    const standalone = raw.startsWith(STANDALONE)
    const mentions: string[] = []
    const body = (standalone ? raw.slice(STANDALONE.length) : raw).trim().replace(/@\[([^\]\n]+)\](?:\((\d{6,})\))?/g, (_whole, name: string, id?: string) => {
      mentions.push(id ? `${id}:${name.trim()}` : name.trim())
      return `@${name.trim()}`
    })
    return { text: body, standalone, mentions: [...new Set(mentions)] }
  }).filter(part => part.text)
}

/** Sends the messages of one outgoing text, each once by its own idempotency key; only returned message ids count as sent. */
export async function sendLarkDesktop(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { chatId, messageId, topic } = message.channel.address
  if (!messageId) return 'gone'
  const parts = larkParts(message.text)
  if (!parts.length) return 'gone'
  const unnamed = new Set<string>()
  for (const [index, part] of parts.entries()) {
    // A text of one message keeps the outgoing id as its key, so a reply queued before parts existed is not sent twice.
    const key = parts.length === 1 ? message.id : `${message.id}-${index + 1}`
    // A topic has no main chat to post into: a message of its own goes into the topic, as a reply there.
    const target = part.standalone && topic !== 'true' && chatId ? ['send', chatId] : ['reply', messageId, '--consumer', CHANNEL_CONSUMER,
      ...topic === 'true' ? ['--in-thread'] : []]
    const send = (mentions: string[]) => host.commands.run(CHANNEL_CLI, [...target, '--text', part.text,
      ...mentions.flatMap(item => ['--mention', item]), '--idempotency-key', key, '--yes'])
    let output: string
    try { output = await send(part.mentions) }
    catch (error) {
      if (error instanceof CliError && GONE.test(error.message)) return 'gone'
      if (!(error instanceof CliError && UNKNOWN_NAME.test(error.message))) throw error
      // A name no member of the chat goes by stays plain text rather than holding the message back for good.
      for (const item of part.mentions) if (!item.includes(':')) unnamed.add(item)
      output = await send(part.mentions.filter(item => item.includes(':')))
    }
    if (!SentSchema.safeParse(JSON.parse(output)).success) throw new Error('lark-desktop answered without a message id, so the message may not have gone out')
  }
  desktop.replied(message, parts.map(part => part.text), unnamed.size ? `没找到 ${[...unnamed].map(name => `@${name}`).join('、')}，按普通文字发出。` : undefined)
  return 'sent'
}

export const larkDesktopChannel: SourceChannel<unknown> = {
  send: sendLarkDesktop,
  link: (): ChannelLink => ({ url: '', label: { zh: '飞书', en: 'Lark' } }),
}
