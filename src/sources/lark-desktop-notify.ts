/**
 * Desktop notifications of the lark-desktop Source: the person hears when a reply went out in their name, and when a ticket
 * needs them, and a click opens that ticket on the panel. Each is shown once, by a key kept in `KV.larkDesktop.notified`.
 */
import { spawn } from 'node:child_process'
import { latestAssignment, ticketStage, type OutboundMessage, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

export interface NotifyConfig { notify: boolean; notifier: string; panelUrl: string }
export interface DesktopNotice { key: string; title: string; message: string; ticketId?: string | undefined }
/** Shows a notice; `failed` hears why the notifier could not start. */
export type Show = (notice: DesktopNotice, config: NotifyConfig, failed: (error: Error) => void) => void
/** How long a ticket waits in review before it is announced, so a reply that goes out right after the report announces it instead. */
export const REVIEW_GRACE_MS = 120_000
/** How many notice keys are kept. */
const KEPT = 500

/** The panel's address that opens a ticket, which the panel reads from its hash; none without a panel address. */
export const ticketLink = (panelUrl: string, ticketId?: string): string | undefined =>
  panelUrl && ticketId ? `${panelUrl.replace(/#.*$/, '')}#superagent=execution/${encodeURIComponent(ticketId)}` : undefined
const line = (text: string, chars: number): string => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat }

/** terminal-notifier, started detached: it stays up until the notice is dismissed, and the Source must not wait for it. */
export const showDesktop: Show = (notice, config, failed) => {
  const url = ticketLink(config.panelUrl, notice.ticketId)
  const child = spawn(config.notifier, ['-title', notice.title, '-message', notice.message, '-group', notice.key, ...url ? ['-open', url] : []],
    { detached: true, stdio: 'ignore' })
  child.on('error', failed)
  child.unref()
}

/** What a ticket waiting for the person is announced as, by why it waits. */
function attention(ticket: Ticket): DesktopNotice | undefined {
  const stage = ticketStage(ticket)
  if (stage.stage !== 'person') return undefined
  const assignment = latestAssignment(ticket)
  const summary = line(assignment?.report?.summary ?? '', 180)
  const round = ticket.attention?.id ?? assignment?.id ?? ''
  const notice = (title: string, message: string) => ({ key: `${stage.action}:${ticket.id}:${round}`, title: `${title}：${ticket.title}`,
    message: message || ticket.title, ticketId: ticket.id })
  switch (stage.action) {
    case 'answer': return notice('有事要问你', line(ticket.attention?.question ?? '', 180))
    case 'blocked': return notice('卡住了，需要你', summary)
    case 'failed': return notice('没做成', summary)
    case 'delivery': return notice('消息没送出', line(ticket.delivery?.error ?? '', 180))
    case 'review': return notice('做好了，等你看', summary)
    default: return undefined
  }
}

/** Shows each desktop notice once: a reply that went out in the person's name, and an open ticket that waits for them. */
export class DesktopNotifier {
  private ctx: Pick<SourceContext, 'state' | 'tickets' | 'report'> | undefined
  private config: NotifyConfig | undefined
  constructor(private readonly show: Show = showDesktop) {}
  /** Starts notifying with the Source's current configuration. */
  use(ctx: Pick<SourceContext, 'state' | 'tickets' | 'report'>, config: NotifyConfig): void { this.ctx = ctx; this.config = config }
  private seen(key: string): boolean { return !!this.ctx?.state.get(KV.larkDesktop.notified)?.[key] }
  private mark(key: string): void {
    if (!this.ctx) return
    const notified = { ...this.ctx.state.get(KV.larkDesktop.notified), [key]: new Date().toISOString() }
    this.ctx.state.set(KV.larkDesktop.notified, Object.fromEntries(Object.entries(notified).sort((a, b) => b[1].localeCompare(a[1])).slice(0, KEPT)))
  }
  private once(notice: DesktopNotice): void {
    const { ctx, config } = this
    if (!ctx || !config?.notify || this.seen(notice.key)) return
    this.mark(notice.key)
    this.show(notice, config, error => { ctx.report('lark-desktop', { state: 'error', detail: `The desktop notification could not be shown: ${error.message}` }) })
  }
  /** A reply went out in the person's name; `note` says what of it could not be done as written. */
  replied(message: OutboundMessage, texts: string[], note?: string): void {
    if (!this.ctx) return
    const ticket = message.ticketId ? this.ctx.tickets.get(message.ticketId) : undefined
    if (ticket) this.mark(`replied-ticket:${ticket.id}`)
    this.once({ key: `replied:${message.id}`, title: ticket ? `我已替你处理：${ticket.title}` : '我已替你回复了一条消息',
      message: line([note, `回复：${texts.join(' / ')}`].filter(Boolean).join(' '), 200), ticketId: ticket?.id })
  }
  /** Announces each open ticket that waits for the person, once per question or report; a ticket in review only once it was not answered by a reply. */
  check(now = Date.now()): void {
    for (const ticket of this.ctx?.tickets.open() ?? []) {
      const notice = attention(ticket)
      if (!notice) continue
      if (notice.key.startsWith('review:') && (this.seen(`replied-ticket:${ticket.id}`) || now - Date.parse(ticket.updatedAt) < REVIEW_GRACE_MS)) continue
      this.once(notice)
    }
  }
}
/** The notifier the Source configures when it runs and its Channel announces replies through. */
export const desktop = new DesktopNotifier()
