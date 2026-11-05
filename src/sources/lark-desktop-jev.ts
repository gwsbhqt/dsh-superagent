/**
 * Layer one of the lark-desktop Source: Jev, a small model that answers a batch of yes-or-no questions in one request,
 * scores whether each unaddressed message needs the person. Direct messages, mentions and replies never reach it.
 * Any failure leaves the messages unscored, so they go on as if Jev were off: it may let noise through, never drop work.
 */
import type { WatchedMessage } from './lark-desktop-trigger.ts'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
/** The credential reference that holds the Jev key, as DeepSeek Harness's credentials file names it under `refs`. */
export const JEV_KEY_REF = 'TYPESAFE_API_KEY'
/** How long the batcher collects messages before it asks, how many it asks at most at once, and how long one request may take. */
export const JEV_WINDOW_MS = 3000, JEV_BATCH = 20, JEV_TIMEOUT_MS = 8000
/** The longest part of one message the question shows Jev. */
const TEXT_CHARS = 1000

export interface NoulQuestion { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
/** Asks Jev one batch and returns each question's probability by its key; throws when the request fails. */
export type JevAsk = (state: unknown, questions: Record<string, NoulQuestion>, signal: AbortSignal) => Promise<Record<string, number>>

/** The state and the questions of one batch: one question per message, keyed `m<index>`. */
export function jevBatch(messages: readonly WatchedMessage[]): { state: unknown; questions: Record<string, NoulQuestion> } {
  const state = { recipient: '收到这些飞书消息的人本人', messages: messages.map(message => ({ chat: message.chat_name ?? '', from: message.sender_name ?? '',
    bot: message.sender_is_bot === true, ...(message.reply_to_me === true ? { replies_to_recipient: true } : {}),
    text: (message.text ?? '').slice(0, TEXT_CHARS) })) }
  const questions = Object.fromEntries(messages.map((_, index) => [`m${index}`, {
    type: 'noul' as const,
    instructions: `上面 messages 数组里第 ${index + 1} 条消息，需要收件人本人处理或知道吗？`,
    criteria: {
      true: '有人请他做事、问他问题、等他决定或回复；和他负责的系统、代码或线上告警有关；他需要知道的变更、事故或安排',
      false: '寒暄、表情、客套；和他无关的闲聊或广播；没有信息的测试消息；机器人回复他时的状态播报，如“任务进行中”“任务已完成”，本身没有新内容',
    },
  }]))
  return { state, questions }
}

/** Jev over HTTP with the key `key` returns; throws when there is no key or the answer is not one. */
export function httpJev(key: () => Promise<string | undefined>, fetcher: typeof fetch = fetch): JevAsk {
  return async (state, questions, signal) => {
    const apiKey = await key()
    if (!apiKey) throw new Error(`no ${JEV_KEY_REF} in the credentials`)
    const response = await fetcher(JEV_URL, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(JEV_TIMEOUT_MS)]),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`Jev answered HTTP ${response.status}`)
    const answers = (JSON.parse(text) as { answers?: Record<string, { noul?: unknown }> }).answers
    if (!answers || typeof answers !== 'object') throw new Error('Jev answered without answers')
    return Object.fromEntries(Object.entries(answers).flatMap(([id, answer]) => typeof answer?.noul === 'number' ? [[id, answer.noul]] : []))
  }
}

/**
 * Collects messages for up to `JEV_WINDOW_MS` or `JEV_BATCH` of them and asks Jev once. `score` resolves each message's
 * probability, or undefined when the batch failed or Jev left that question out; `failed` hears why a batch failed.
 */
export class JevBatcher {
  private pending: { message: WatchedMessage; resolve(score: number | undefined): void }[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly ask: JevAsk, private readonly signal: AbortSignal, private readonly failed: (error: unknown) => void = () => {}) {}
  score(message: WatchedMessage): Promise<number | undefined> {
    return new Promise(resolve => {
      this.pending.push({ message, resolve })
      if (this.pending.length >= JEV_BATCH) void this.flush()
      else this.timer ??= setTimeout(() => { void this.flush() }, JEV_WINDOW_MS)
    })
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    const batch = this.pending; this.pending = []
    if (!batch.length) return
    let scores: Record<string, number> = {}
    try {
      const { state, questions } = jevBatch(batch.map(item => item.message))
      scores = await this.ask(state, questions, this.signal)
    } catch (error) { this.failed(error) }
    batch.forEach((item, index) => { item.resolve(scores[`m${index}`]) })
  }
}
