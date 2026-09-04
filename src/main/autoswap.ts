/**
 * The swap policy: pure functions over normalized usage, no I/O.
 *
 * An account is *gated* by its 5-hour window, its weekly window, and the
 * model-scoped weekly window (Fable by default) when the API reports one. The
 * policy only ever compares headroom (`100 - max gating pct`) so a Fable-only
 * exhaustion counts exactly like a global one.
 */
import type { Decision, Settings, Usage, UsageWindow } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

export interface PolicyAccount {
  id: string
  active: boolean
  disabled: boolean
  usage: Usage | null
}

/** The windows that can block an account: 5h, weekly, and `model:<model>` if present. */
export function gatingWindows(usage: Usage | null | undefined, model = 'Fable'): UsageWindow[] {
  if (!usage || !usage.ok) return []
  const keys = new Set(['five_hour', 'seven_day', `model:${model.toLowerCase()}`])
  return (usage.windows ?? []).filter(
    (w) => w && keys.has(w.key) && typeof w.pct === 'number' && Number.isFinite(w.pct),
  )
}

/** The gating window with the highest utilization, or `null` when unknown. */
function peak(usage: Usage | null | undefined, model: string): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const w of gatingWindows(usage, model)) {
    if (best === null || w.pct > best.pct) best = w
  }
  return best
}

/** Key of the gating window with the least headroom, or `null`. */
export function bindingWindow(usage: Usage | null | undefined, model = 'Fable'): UsageWindow | null {
  return peak(usage, model)
}

export function headroom(usage: Usage | null | undefined, model = 'Fable'): number | null {
  const p = peak(usage, model)
  return p === null ? null : Math.round((100 - p.pct) * 10) / 10
}

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : null
}

/** Soonest reset among the weekly-scale gating windows (used by `consume_first`). */
export function weeklyReset(usage: Usage | null | undefined, model = 'Fable'): Date | null {
  let soonest: Date | null = null
  for (const w of gatingWindows(usage, model)) {
    if (w.key === 'five_hour') continue
    const reset = parseIso(w.resetsAt)
    if (reset && (soonest === null || reset < soonest)) soonest = reset
  }
  return soonest
}

const pct0 = (n: number): string => Math.round(n).toString()

/**
 * Pick the next action for the poll loop. Rules are the numbered list in
 * ARCHITECTURE.md; `margin` is hysteresis so two near-equal accounts never
 * ping-pong.
 */
export function decide(
  accounts: PolicyAccount[],
  settings: Partial<Settings>,
  now: Date,
  lastSwitchAt: Date | null = null,
): Decision {
  const cfg: Settings = { ...DEFAULT_SETTINGS, ...settings }
  const at = now.toISOString()
  const threshold = cfg.threshold
  const margin = cfg.margin
  const model = cfg.model
  const stay = (reason: string, targetId: string | null = null): Decision => ({ action: 'stay', targetId, reason, at })

  const active = accounts.find((a) => a.active)
  if (!active) return stay('no active account')
  const activeHr = headroom(active.usage, model)
  const activePeak = peak(active.usage, model)
  if (activeHr === null || activePeak === null) return stay('active account usage unknown')

  const hr = (a: PolicyAccount): number => headroom(a.usage, model) ?? 0
  const candidates = accounts.filter(
    (a) =>
      !a.active &&
      !a.disabled &&
      headroom(a.usage, model) !== null &&
      100 - hr(a) < threshold && // below threshold itself
      hr(a) - activeHr >= margin, // hysteresis: must be meaningfully better
  )

  let decision: Decision
  if (activePeak.pct >= threshold) {
    if (candidates.length === 0) {
      return {
        action: 'blocked',
        targetId: null,
        reason: `${activePeak.key} at ${pct0(activePeak.pct)}% and no enabled account has ${pct0(margin)}+ points more headroom`,
        at,
      }
    }
    let best = candidates[0] as PolicyAccount
    for (const c of candidates) if (hr(c) > hr(best)) best = c
    decision = {
      action: 'switch',
      targetId: best.id,
      reason: `${activePeak.key} at ${pct0(activePeak.pct)}% >= ${pct0(threshold)}%; ${best.id} has ${pct0(hr(best))}% headroom`,
      at,
    }
  } else if (cfg.strategy === 'consume_first') {
    let soonest: { reset: Date; account: PolicyAccount } | null = null
    for (const a of candidates) {
      const reset = weeklyReset(a.usage, model)
      if (reset && (soonest === null || reset < soonest.reset)) soonest = { reset, account: a }
    }
    if (!soonest) return stay(`${activePeak.key} at ${pct0(activePeak.pct)}%; nothing to consume`)
    decision = {
      action: 'switch',
      targetId: soonest.account.id,
      reason: `consume-first: ${soonest.account.id} resets ${soonest.reset.toISOString()} with ${pct0(hr(soonest.account))}% headroom`,
      at,
    }
  } else {
    return stay(`${activePeak.key} at ${pct0(activePeak.pct)}% < ${pct0(threshold)}%`)
  }

  if (lastSwitchAt) {
    const elapsed = (now.getTime() - lastSwitchAt.getTime()) / 1000
    const remaining = cfg.cooldownSeconds - elapsed
    if (remaining > 0) return stay(`cooldown: ${Math.round(remaining)}s left`, decision.targetId)
  }
  if (cfg.dryRun) return stay('dry-run: ' + decision.reason, decision.targetId)
  return decision
}
