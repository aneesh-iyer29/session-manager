/**
 * Pure content for the menu bar glance menu: the row model, the HTML that
 * paints it (rendered offscreen by trayRender.ts), and a text fallback for
 * when rendering fails. No Electron imports, fully unit-tested.
 */
import type { Account, AppState, CodexState, UsageWindow } from '../shared/types'

export type Tone = 'ok' | 'warn' | 'danger' | 'unknown'

export type MenuRow =
  | { kind: 'header'; title: string; right: string }
  | { kind: 'window'; label: string; right: string; pct: number | null; tone: Tone; estimated?: boolean }
  | { kind: 'status'; text: string }

/** Points. Width matches a comfortable NSMenu; heights give each row its own line. */
export const ROW_WIDTH = 340
export const ROW_HEIGHT: Record<MenuRow['kind'], number> = { header: 24, window: 34, status: 22 }

const FILLED = '▮'
const EMPTY = '▯'

export function bar(pct: number | null, segments = 10): string {
  if (pct === null || !Number.isFinite(pct)) return EMPTY.repeat(segments)
  const filled = Math.max(0, Math.min(segments, Math.round((pct / 100) * segments)))
  return FILLED.repeat(filled) + EMPTY.repeat(segments - filled)
}

/** "2d 3h", "4h 12m", "38m", "now"; empty when unknown. */
export function countdown(resetsAt: string | null, now: Date): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - now.getTime()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`
  return `${mins}m`
}

/**
 * "Resets in 3 hr 10 min" inside a day, "Resets Mon 10:00 AM" beyond it — the
 * phrasing Claude's own usage panel uses, so the menu reads as familiar.
 */
export function resetText(resetsAt: string | null, now: Date, locale = 'en-US'): string {
  if (!resetsAt) return ''
  const at = new Date(resetsAt)
  const ms = at.getTime() - now.getTime()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'Resets now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `Resets in ${minutes} min`
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `Resets in ${h} hr ${m} min` : `Resets in ${h} hr`
  }
  const day = at.toLocaleDateString(locale, { weekday: 'short' })
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  return `Resets ${day} ${time}`
}

export function shortName(acc: Pick<Account, 'alias' | 'email' | 'id'>): string {
  return acc.alias || acc.email.split('@')[0] || acc.id
}

export function tone(pct: number | null, threshold: number): Tone {
  if (pct === null || !Number.isFinite(pct)) return 'unknown'
  const headroom = 100 - pct
  if (pct >= threshold || headroom <= 10) return 'danger'
  if (headroom < 30) return 'warn'
  return 'ok'
}

function planName(plan: string | null): string {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : ''
}

/** Gating windows first (5-hour, weekly, model), in a stable order. */
export function orderedWindows(acc: Pick<Account, 'usage'>): UsageWindow[] {
  const windows = acc.usage?.windows ?? []
  const rank = (w: UsageWindow): number => (w.key === 'five_hour' ? 0 : w.key === 'seven_day' ? 1 : 2)
  return [...windows].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
}

function windowTitle(w: UsageWindow): string {
  if (w.key === 'five_hour') return '5-hour limit'
  if (w.key === 'seven_day') return 'Weekly · all models'
  return `Weekly · ${w.label.replace(/\s+weekly$/i, '')}`
}

export function accountRight(acc: Account): string {
  const flags = [acc.active ? 'Active' : '', acc.disabled ? 'Held out' : '', acc.tokenStatus === 'dead' ? 'Needs login' : ''].filter(Boolean)
  return [planName(acc.plan), ...flags].filter(Boolean).join(' · ')
}

export function codexHeader(codex: CodexState): { title: string; right: string } {
  if (!codex.configured) return { title: 'Codex', right: 'Not configured' }
  if (codex.mode === 'apikey') return { title: 'Codex', right: 'API key · no quota' }
  return { title: codex.email ? `Codex · ${codex.email}` : 'Codex', right: planName(codex.plan) }
}

export function statusLine(state: AppState, now: Date): string {
  const s = state.settings
  const armed = !s.autoswapEnabled ? 'Auto-swap off' : s.dryRun ? 'Auto-swap dry run' : 'Auto-swap armed'
  const polled = state.polling.lastPollAt ? `polled ${agoShort(state.polling.lastPollAt, now)}` : 'not polled yet'
  return `${armed} · ${polled}`
}

function agoShort(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

/** The whole glance menu as rows, in display order. */
export function menuRows(state: AppState, now: Date): MenuRow[] {
  const rows: MenuRow[] = []
  const s = state.settings
  /** Each window is coloured against its own swap line: the session's, or the weekly one. */
  const line = (key: string): number => (key === 'five_hour' ? s.fiveHourThreshold : s.threshold)
  if (state.accounts.length === 0) rows.push({ kind: 'status', text: 'No accounts yet · open Session Manager to add one' })
  for (const acc of state.accounts) {
    rows.push({ kind: 'header', title: shortName(acc), right: accountRight(acc) })
    const windows = orderedWindows(acc)
    if (windows.length === 0) rows.push({ kind: 'status', text: acc.usage?.error ?? 'Usage not fetched yet' })
    for (const w of windows) {
      rows.push({ kind: 'window', label: windowTitle(w), right: resetText(w.resetsAt, now), pct: w.pct, tone: tone(w.pct, line(w.key)), estimated: w.estimated === true })
    }
  }
  if (s.codexEnabled) {
    const h = codexHeader(state.codex)
    rows.push({ kind: 'header', title: h.title, right: h.right })
    if (state.codex.usage) {
      for (const w of orderedWindows({ usage: state.codex.usage })) {
        rows.push({ kind: 'window', label: windowTitle(w), right: resetText(w.resetsAt, now), pct: w.pct, tone: tone(w.pct, line(w.key)), estimated: w.estimated === true })
      }
    }
  }
  rows.push({ kind: 'status', text: statusLine(state, now) })
  return rows
}

/** Text-only rendering of a row, used when the image renderer is unavailable. */
export function rowText(row: MenuRow): string {
  if (row.kind === 'header') return row.right ? `${row.title}  ·  ${row.right}` : row.title
  if (row.kind === 'status') return row.text
  const pct = row.pct === null ? '  –' : `${Math.round(row.pct)}%`.padStart(4, ' ')
  return `${row.label.padEnd(20, ' ')} ${bar(row.pct)} ${pct}${row.right ? `  ·  ${row.right}` : ''}`
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * HTML for every row stacked at fixed heights. System font so it sits with
 * the native menu items; colours follow the menu's appearance; the bar is
 * the app's headroom colour. `zoom` renders at the retina scale.
 */
export function rowsHtml(rows: MenuRow[], dark: boolean, zoom = 2): string {
  const c = dark
    ? { text: '#f3f1ec', muted: '#a6a399', track: 'rgba(255,255,255,0.14)', ok: '#6fa583', warn: '#b5a06b', danger: '#c9736a', unknown: 'rgba(255,255,255,0.25)' }
    : { text: '#232323', muted: '#6c695f', track: 'rgba(0,0,0,0.09)', ok: '#3d6b51', warn: '#84754e', danger: '#96453c', unknown: 'rgba(0,0,0,0.2)' }
  const body = rows
    .map((row) => {
      const h = ROW_HEIGHT[row.kind]
      if (row.kind === 'header') {
        return `<div class="row header" style="height:${h}px"><span class="t">${esc(row.title)}</span><span class="r">${esc(row.right)}</span></div>`
      }
      if (row.kind === 'status') {
        return `<div class="row status" style="height:${h}px"><span class="r">${esc(row.text)}</span></div>`
      }
      const pct = row.pct === null ? 0 : Math.max(0, Math.min(100, row.pct))
      const pctText = row.pct === null ? '–' : `${row.estimated ? '≈' : ''}${Math.round(row.pct)}%`
      return (
        `<div class="row window" style="height:${h}px">` +
        `<div class="line"><span class="t">${esc(row.label)}</span><span class="r">${esc(row.right)}${row.right ? '&nbsp;&nbsp;' : ''}<b>${pctText}</b></span></div>` +
        `<div class="track"><div class="fill" style="width:${pct}%;background:${c[row.tone]}"></div></div></div>`
      )
    })
    .join('')
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html{zoom:${zoom}}html,body{margin:0;background:transparent}` +
    `body{width:${ROW_WIDTH}px;font:13px/1.2 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;color:${c.text};-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}` +
    `.row{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 2px;white-space:nowrap;overflow:hidden}` +
    `.header{align-items:flex-end;padding-bottom:5px}.header .t{font-weight:600}` +
    `.window{flex-direction:column;align-items:stretch;justify-content:center;gap:6px}` +
    `.line{display:flex;justify-content:space-between;align-items:baseline;gap:12px}` +
    `.t{overflow:hidden;text-overflow:ellipsis}.r{color:${c.muted};flex:none}.r b{color:${c.text};font-weight:600}` +
    `.status{justify-content:flex-start}.status .r{font-size:12px}` +
    `.track{height:4px;border-radius:2px;background:${c.track};overflow:hidden}.fill{height:100%;border-radius:2px}` +
    `</style></head><body>${body}</body></html>`
  )
}
