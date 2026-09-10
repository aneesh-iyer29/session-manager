/**
 * The swap policy: pure functions over normalized usage, no I/O.
 *
 * An account is *gated* by its 5-hour session window, its weekly window, and
 * the model-scoped weekly window (Fable by default) when the API reports one.
 *
 * The 5-hour session is the window that throttles a working session, so it is
 * the primary axis: an account's headroom is its session's headroom, and a
 * weekly window only takes over once it is past the warn line and closer to
 * its limit than the session is; that is the point at which the week runs out
 * before the session does. Each kind of window has its own swap line
 * (`fiveHourThreshold` for the session, `threshold` for the weekly windows) so
 * the session keeps a real buffer while the weeks can be run nearly dry.
 *
 * When the active account is over a line, targets are compared on the axis
 * that hit: session headroom when the session did, weekly headroom when a
 * weekly window did. Nothing else about "which account has more of what I am
 * out of" is meaningful.
 */
import type { Decision, Settings, Usage, UsageWindow } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

export interface PolicyAccount {
  id: string
  active: boolean
  disabled: boolean
  usage: Usage | null
}

/** The settings the pure policy reads. */
export interface PolicyOptions {
  model: string
  fiveHourThreshold: number
  threshold: number
  warnPct: number
}

export const FIVE_HOUR = 'five_hour'

export function options(settings: Partial<Settings>): PolicyOptions {
  const cfg: Settings = { ...DEFAULT_SETTINGS, ...settings }
  return { model: cfg.model, fiveHourThreshold: cfg.fiveHourThreshold, threshold: cfg.threshold, warnPct: cfg.warnPct }
}

/**
 * The windows that can block an account: 5h, weekly, and `model:<model>` if
 * present. A failed poll keeps the last known windows (with `ok: false`), and
 * those still count: stale numbers beat no numbers for both the gauge and the
 * policy, and `fetchedAt` tells the UI how old they are.
 */
export function gatingWindows(usage: Usage | null | undefined, model = 'Fable'): UsageWindow[] {
  if (!usage) return []
  const keys = new Set([FIVE_HOUR, 'seven_day', `model:${model.toLowerCase()}`])
  return (usage.windows ?? []).filter(
    (w) => w && keys.has(w.key) && typeof w.pct === 'number' && Number.isFinite(w.pct),
  )
}

/** The swap line for a window: the session has its own; every weekly-scale window shares `threshold`. */
export function swapLineFor(key: string, opts: Pick<PolicyOptions, 'fiveHourThreshold' | 'threshold'>): number {
  return key === FIVE_HOUR ? opts.fiveHourThreshold : opts.threshold
}

const round1 = (n: number): number => Math.round(n * 10) / 10

function highest(windows: UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const w of windows) if (best === null || w.pct > best.pct) best = w
  return best
}

/**
 * The window the account is really up against. The 5-hour session when the
 * account has one; a weekly window instead when it is past the warn line and
 * higher than the session. Without a session window (usage that did not report
 * one) the highest window wins.
 */
export function bindingWindow(usage: Usage | null | undefined, opts: PolicyOptions): UsageWindow | null {
  const windows = gatingWindows(usage, opts.model)
  const session = windows.find((w) => w.key === FIVE_HOUR)
  if (!session) return highest(windows)
  const gate = Math.min(opts.warnPct, opts.threshold)
  let binding = session
  for (const w of windows) {
    if (w.key !== FIVE_HOUR && w.pct >= gate && w.pct > binding.pct) binding = w
  }
  return binding
}

/** 100 - pct of the binding window, or `null` when usage is unknown. What the gauge shows. */
export function headroom(usage: Usage | null | undefined, opts: PolicyOptions): number | null {
  const b = bindingWindow(usage, opts)
  return b === null ? null : round1(100 - b.pct)
}

/** 100 - max pct over every gating window: runway over all limits at once. */
export function overallHeadroom(usage: Usage | null | undefined, model = 'Fable'): number | null {
  const h = highest(gatingWindows(usage, model))
  return h === null ? null : round1(100 - h.pct)
}

/** Headroom of the 5-hour session alone; the overall headroom when there is no session window. */
export function sessionHeadroom(usage: Usage | null | undefined, model = 'Fable'): number | null {
  const session = gatingWindows(usage, model).find((w) => w.key === FIVE_HOUR)
  return session ? round1(100 - session.pct) : overallHeadroom(usage, model)
}

/** Headroom of the tightest weekly-scale window; the overall headroom when there is none. */
export function weeklyHeadroom(usage: Usage | null | undefined, model = 'Fable'): number | null {
  const h = highest(gatingWindows(usage, model).filter((w) => w.key !== FIVE_HOUR))
  return h ? round1(100 - h.pct) : overallHeadroom(usage, model)
}

/**
 * The gating window at or past its own swap line, the one furthest past it
 * first; `null` when the account is under every line.
 */
export function nearLimit(usage: Usage | null | undefined, opts: PolicyOptions): UsageWindow | null {
  let worst: UsageWindow | null = null
  let worstOver = -Infinity
  for (const w of gatingWindows(usage, opts.model)) {
    const over = w.pct - swapLineFor(w.key, opts)
    if (over >= 0 && over > worstOver) {
      worst = w
      worstOver = over
    }
  }
  return worst
}

/**
 * The gating window that will reach its swap line first, measured in points
 * left before that line; `null` when usage is unknown. Drives the compact nudge
 * and the poll cadence, which care about the next swap, not the gauge.
 */
export function closestToLine(usage: Usage | null | undefined, opts: PolicyOptions): UsageWindow | null {
  let best: UsageWindow | null = null
  let bestLeft = Infinity
  for (const w of gatingWindows(usage, opts.model)) {
    const left = swapLineFor(w.key, opts) - w.pct
    if (left < bestLeft) {
      best = w
      bestLeft = left
    }
  }
  return best
}

/** Points left before `w` reaches its swap line (negative once past it). */
export function pointsToLine(w: UsageWindow, opts: PolicyOptions): number {
  return swapLineFor(w.key, opts) - w.pct
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
    if (w.key === FIVE_HOUR) continue
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
  const opts = options(cfg)
  const at = now.toISOString()
  const margin = cfg.margin
  const stay = (reason: string, targetId: string | null = null): Decision => ({ action: 'stay', targetId, reason, at })

  const active = accounts.find((a) => a.active)
  if (!active) return stay('no active account')
  const activeBinding = bindingWindow(active.usage, opts)
  if (activeBinding === null) return stay('active account usage unknown')
  const hit = nearLimit(active.usage, opts)

  // The axis targets are compared on: what the active account is out of. With
  // nothing hit, only consume_first switches, and that is about the week.
  const onSession = hit !== null && hit.key === FIVE_HOUR
  const primary = (a: PolicyAccount): number => (onSession ? sessionHeadroom : weeklyHeadroom)(a.usage, opts.model) ?? 0
  const secondary = (a: PolicyAccount): number => (onSession ? weeklyHeadroom : sessionHeadroom)(a.usage, opts.model) ?? 0
  const activePrimary = primary(active)
  const candidates = accounts.filter(
    (a) =>
      !a.active &&
      !a.disabled &&
      headroom(a.usage, opts) !== null &&
      nearLimit(a.usage, opts) === null && // under every line itself
      primary(a) - activePrimary >= margin, // hysteresis: must be meaningfully better
  )
  const beats = (a: PolicyAccount, b: PolicyAccount): boolean => {
    if (primary(a) !== primary(b)) return primary(a) > primary(b)
    if (secondary(a) !== secondary(b)) return secondary(a) > secondary(b)
    return a.id < b.id
  }

  let decision: Decision
  if (hit) {
    const line = pct0(swapLineFor(hit.key, opts))
    if (candidates.length === 0) {
      return {
        action: 'blocked',
        targetId: null,
        reason: `${hit.key} at ${pct0(hit.pct)}% (swap line ${line}%) and no enabled account has ${pct0(margin)}+ points more ${onSession ? 'session' : 'weekly'} headroom`,
        at,
      }
    }
    let best = candidates[0] as PolicyAccount
    for (const c of candidates) if (beats(c, best)) best = c
    decision = {
      action: 'switch',
      targetId: best.id,
      reason: `${hit.key} at ${pct0(hit.pct)}% >= ${line}%; ${best.id} has ${pct0(primary(best))}% ${onSession ? 'session' : 'weekly'} headroom`,
      at,
    }
  } else if (cfg.strategy === 'consume_first') {
    let soonest: { reset: Date; account: PolicyAccount } | null = null
    for (const a of candidates) {
      const reset = weeklyReset(a.usage, opts.model)
      if (reset && (soonest === null || reset < soonest.reset)) soonest = { reset, account: a }
    }
    if (!soonest) return stay(`${activeBinding.key} at ${pct0(activeBinding.pct)}%; nothing to consume`)
    decision = {
      action: 'switch',
      targetId: soonest.account.id,
      reason: `consume-first: ${soonest.account.id} resets ${soonest.reset.toISOString()} with ${pct0(primary(soonest.account))}% weekly headroom`,
      at,
    }
  } else {
    return stay(`${activeBinding.key} at ${pct0(activeBinding.pct)}% < ${pct0(swapLineFor(activeBinding.key, opts))}%`)
  }

  if (lastSwitchAt) {
    const elapsed = (now.getTime() - lastSwitchAt.getTime()) / 1000
    const remaining = cfg.cooldownSeconds - elapsed
    if (remaining > 0) return stay(`cooldown: ${Math.round(remaining)}s left`, decision.targetId)
  }
  if (cfg.dryRun) return stay('dry-run: ' + decision.reason, decision.targetId)
  return decision
}
