/**
 * Desktop notifications of the lark-desktop Source: the person hears when a reply went out in their name, and when a ticket
 * needs them, and a click opens that ticket on the panel. Each is shown once, by a key kept in `KV.larkDesktop.notified`.
 */
import { spawn } from 'node:child_process'
import { latestAssignment, ticketStage, type OutboundMessage, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

export interface NotifyConfig { notify: boolean; notifier: string; panelUrl: string }
export interface DesktopNotice { key: string; title: string; message: string; ticketId?: string | undefined; suppressReview?: string | undefined; reviewFor?: string | undefined }
/** Reports whether the notification program started; macOS controls whether it becomes visible. */
export type Show = (notice: DesktopNotice, config: NotifyConfig, started: () => void, failed: (error: Error) => void) => void
export const NOTIFY_HEALTH = 'lark-desktop-notifications'
/** How long a ticket waits in review before it is announced, so a reply that goes out right after the report announces it instead. */
export const REVIEW_GRACE_MS = 120_000
/** How many inactive notice keys are kept alongside those for open tickets. */
const KEPT = 500

/** The panel's address that opens a ticket, which the panel reads from its hash; none without a panel address. */
export const ticketLink = (panelUrl: string, ticketId?: string): string | undefined =>
  panelUrl && ticketId ? `${panelUrl.replace(/#.*$/, '')}#superagent=execution/${encodeURIComponent(ticketId)}` : undefined
const line = (text: string, chars: number): string => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat }

/** terminal-notifier, started detached: it stays up until the notice is dismissed, and the Source must not wait for it. */
export const showDesktop: Show = (notice, config, started, failed) => {
  const url = ticketLink(config.panelUrl, notice.ticketId)
  const child = spawn(config.notifier, ['-title', notice.title, '-message', notice.message, '-group', notice.key, ...url ? ['-open', url] : []],
    { detached: true, stdio: 'ignore' })
  child.once('error', failed)
  child.once('spawn', () => { child.unref(); started() })
}

/** What a ticket waiting for the person is announced as, by why it waits. */
function attention(ticket: Ticket): DesktopNotice | undefined {
  const stage = ticketStage(ticket)
  if (stage.stage !== 'person') return undefined
  const assignment = latestAssignment(ticket)
  const summary = line(assignment?.report?.summary ?? '', 180)
  const round = stage.action === 'delivery' ? ticket.delivery?.at : stage.action === 'answer' ? ticket.attention?.id : assignment?.report?.at ?? assignment?.id
  const reportKey = assignment?.report?.at ? `replied-report:${ticket.id}:${assignment.id}:${assignment.report.at}` : undefined
  const notice = (title: string, message: string) => ({ key: `${stage.action}:${ticket.id}:${round ?? ''}`, title: `${title}：${ticket.title}`,
    message: message || ticket.title, ticketId: ticket.id, ...stage.action === 'review' && reportKey ? { reviewFor: reportKey } : {} })
  switch (stage.action) {
    case 'answer': return notice('有事要问你', line(ticket.attention?.question ?? '', 180))
    case 'blocked': return notice('卡住了，需要你', summary)
    case 'failed': return notice('没做成', summary)
    case 'delivery': return notice('任务信息没交给执行会话', line(ticket.delivery?.error ?? '', 180))
    case 'review': return notice('做好了，等你看', summary)
    default: return undefined
  }
}

/** Shows each desktop notice once: a reply that went out in the person's name, and an open ticket that waits for them. */
export class DesktopNotifier {
  private ctx: Pick<SourceContext, 'state' | 'tickets' | 'report' | 'atomic' | 'outgoingFailures'> | undefined
  private config: NotifyConfig | undefined
  private sending = false
  constructor(private readonly show: Show = showDesktop) {}
  /** Starts notifying with the Source's current configuration. */
  use(ctx: Pick<SourceContext, 'state' | 'tickets' | 'report' | 'atomic' | 'outgoingFailures'>, config: NotifyConfig): void {
    if (this.ctx !== ctx || this.config?.notify !== config.notify) ctx.report(NOTIFY_HEALTH, { state: config.notify ? 'ready' : 'paused', detail: config.notify ? 'Desktop notifications enabled' : 'Desktop notifications off' })
    this.ctx = ctx; this.config = config
    this.flush()
  }
  private seen(key: string): boolean { return !!this.ctx?.state.get(KV.larkDesktop.notified)?.[key] }
  private mark(key: string): void {
    if (!this.ctx) return
    const active = new Set<string>()
    for (const ticket of this.ctx.tickets.open()) {
      const current = attention(ticket)
      if (current) { active.add(current.key); if (current.reviewFor) active.add(current.reviewFor) }
    }
    for (const failure of this.ctx.outgoingFailures()) active.add(`outgoing:${failure.id}`)
    const notified = { ...this.ctx.state.get(KV.larkDesktop.notified), [key]: new Date().toISOString() }
    const entries = Object.entries(notified).sort((a, b) => b[1].localeCompare(a[1]))
    this.ctx.state.set(KV.larkDesktop.notified, Object.fromEntries([...entries.filter(([id]) => active.has(id)), ...entries.filter(([id]) => !active.has(id)).slice(0, KEPT)]))
  }
  private once(notice: DesktopNotice): void {
    const { ctx, config } = this
    if (!ctx || !config?.notify || this.seen(notice.key)) return
    const pending = { ...ctx.state.get(KV.larkDesktop.pendingNotices), [notice.key]: notice }
    ctx.state.set(KV.larkDesktop.pendingNotices, pending)
    this.flush()
  }
  private flush(): void {
    const { ctx, config } = this
    if (!ctx || !config?.notify || this.sending) return
    const pending = { ...ctx.state.get(KV.larkDesktop.pendingNotices) }
    for (const notice of Object.values(pending)) {
      if (this.seen(notice.key) || (notice.reviewFor && this.seen(notice.reviewFor))) { delete pending[notice.key]; continue }
      ctx.state.set(KV.larkDesktop.pendingNotices, pending)
      this.sending = true
      this.show(notice, config, () => {
        ctx.atomic(() => {
          this.mark(notice.key)
          if (notice.suppressReview) this.mark(notice.suppressReview)
          const remaining = { ...ctx.state.get(KV.larkDesktop.pendingNotices) }; delete remaining[notice.key]
          ctx.state.set(KV.larkDesktop.pendingNotices, remaining)
        })
        this.sending = false
        ctx.report(NOTIFY_HEALTH, { state: 'ready', detail: 'Desktop notification program started' })
        this.flush()
      }, error => {
        this.sending = false
        ctx.report(NOTIFY_HEALTH, { state: 'error', detail: `The desktop notification could not start: ${error.message}` })
      })
      return
    }
    ctx.state.set(KV.larkDesktop.pendingNotices, pending)
  }
  /** A reply went out in the person's name. */
  replied(message: OutboundMessage, texts: string[]): void {
    if (!this.ctx) return
    const ticket = message.ticketId ? this.ctx.tickets.get(message.ticketId) : undefined
    const result = message.resultOf
    this.once({ key: `replied:${message.id}`, title: ticket ? `我已替你处理：${ticket.title}` : '我已替你回复了一条消息',
      message: line(`回复：${texts.join(' / ')}`, 200), ticketId: ticket?.id,
      ...ticket && result ? { suppressReview: `replied-report:${ticket.id}:${result.assignmentId}:${result.reportedAt}` } : {} })
  }
  /** Announces each open ticket that waits for the person, once per question or report; a ticket in review only once it was not answered by a reply. */
  check(now = Date.now()): void {
    this.flush()
    for (const failure of this.ctx?.outgoingFailures() ?? []) {
      const ticket = failure.ticketId ? this.ctx?.tickets.get(failure.ticketId) : undefined
      this.once({ key: `outgoing:${failure.id}`, title: ticket ? `飞书消息未确认：${ticket.title}` : '飞书消息未确认',
        message: line(failure.error, 180), ticketId: ticket?.id })
    }
    for (const ticket of this.ctx?.tickets.open() ?? []) {
      const notice = attention(ticket)
      if (!notice) continue
      if (notice.key.startsWith('review:') && ((notice.reviewFor && this.seen(notice.reviewFor)) || now - Date.parse(ticket.updatedAt) < REVIEW_GRACE_MS)) continue
      this.once(notice)
    }
  }
}
/** The notifier the Source configures when it runs and its Channel announces replies through. */
export const desktop = new DesktopNotifier()
