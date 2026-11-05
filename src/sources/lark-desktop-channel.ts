/**
 * The lark-desktop Source's Channel: it answers in the person's own name, as a reply to the message a Thread started from,
 * through the lark-desktop CLI, which ends the text with the agent's mark (🤖) so people and this Source tell it from the person's own.
 */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, SourceChannel } from './kind.ts'

/** The CLI the Channel calls; a Channel has no Source configuration, so it is found on the host's PATH. */
export const CHANNEL_CLI = 'lark-desktop'
/** The name lark-desktop records the reply's claim under, so no other subscriber of the person answers the same message. */
export const CHANNEL_CONSUMER = 'dsh-superagent'
const SentSchema = z.looseObject({ message_id: z.string().min(1) })
/** Errors after which the message can never go to that address: the message it answers or its chat is gone. */
const GONE = /message_not_found|wrong_chat|chat_not_found|not a member|取不到/

/** Replies once per message id, which lark-desktop keeps as the idempotency key; only a returned message id counts as sent. */
export async function sendLarkDesktop(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { messageId, topic } = message.channel.address
  if (!messageId) return 'gone'
  const args = ['reply', messageId, '--text', message.text, '--idempotency-key', message.id, '--consumer', CHANNEL_CONSUMER,
    ...topic === 'true' ? ['--in-thread'] : [], '--yes']
  let output: string
  try { output = await host.commands.run(CHANNEL_CLI, args) }
  catch (error) {
    if (error instanceof CliError && GONE.test(error.message)) return 'gone'
    throw error
  }
  const sent = SentSchema.safeParse(JSON.parse(output))
  if (!sent.success) throw new Error('lark-desktop answered without a message id, so the reply may not have gone out')
  return 'sent'
}

export const larkDesktopChannel: SourceChannel<unknown> = {
  send: sendLarkDesktop,
  link: (): ChannelLink => ({ url: '', label: { zh: '飞书', en: 'Lark' } }),
}
