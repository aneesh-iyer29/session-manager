/**
 * Pure text for the menu bar glance menu. Native menus only take strings, so
 * usage is drawn with ten block glyphs; tabular digits keep the columns close
 * enough to read at a glance. No Electron imports, fully unit-tested.
 */
import type { Account, AppState, CodexState, UsageWindow } from '../shared/types'

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

export function shortName(acc: Pick<Account, 'alias' | 'email' | 'id'>): string {
  return acc.alias || acc.email.split('@')[0] || acc.id
}

export function windowLine(w: UsageWindow, now: Date): string {
  const label = w.label.padEnd(12, ' ')
  const pct = `${Math.round(w.pct)}%`.padStart(4, ' ')
  const reset = countdown(w.resetsAt, now)
  return `${label} ${bar(w.pct)} ${pct}${reset ? `  ·  ${reset}` : ''}`
}

/** Header for one account: name, plan, and the flags that matter at a glance. */
export function accountHeader(acc: Account): string {
  const flags = [acc.active ? 'ACTIVE' : '', acc.disabled ? 'held out' : '', acc.tokenStatus === 'dead' ? 'needs login' : '']
    .filter(Boolean)
    .join(' · ')
  const plan = acc.plan ? acc.plan.charAt(0).toUpperCase() + acc.plan.slice(1) : ''
  return [shortName(acc), plan, flags].filter(Boolean).join('  ·  ')
}

/** Gating windows first (5-hour, weekly, model), in a stable order. */
export function orderedWindows(acc: Pick<Account, 'usage'>): UsageWindow[] {
  const windows = acc.usage?.windows ?? []
  const rank = (w: UsageWindow): number => (w.key === 'five_hour' ? 0 : w.key === 'seven_day' ? 1 : 2)
  return [...windows].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
}

export function codexHeader(codex: CodexState): string {
  if (!codex.configured) return 'Codex  ·  not configured'
  if (codex.mode === 'apikey') return 'Codex  ·  API key (no quota)'
  const plan = codex.plan ? codex.plan.charAt(0).toUpperCase() + codex.plan.slice(1) : ''
  return ['Codex', plan, codex.email ?? ''].filter(Boolean).join('  ·  ')
}

export function statusLine(state: AppState, now: Date): string {
  const s = state.settings
  const armed = !s.autoswapEnabled ? 'Auto-swap off' : s.dryRun ? 'Auto-swap dry run' : 'Auto-swap armed'
  const polled = state.polling.lastPollAt ? `polled ${agoShort(state.polling.lastPollAt, now)}` : 'not polled yet'
  return `${armed}  ·  ${polled}`
}

function agoShort(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}
