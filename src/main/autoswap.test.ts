import { describe, expect, it } from 'vitest'

import type { Settings, Usage } from '../shared/types'
import {
  bindingWindow,
  closestToLine,
  decide,
  gatingWindows,
  headroom,
  nearLimit,
  options,
  overallHeadroom,
  sessionHeadroom,
  weeklyHeadroom,
  weeklyReset,
  type PolicyAccount,
} from './autoswap'

const NOW = new Date('2026-09-04T18:00:00Z')
const SETTINGS: Partial<Settings> = { fiveHourThreshold: 90, threshold: 90, warnPct: 80, margin: 10, cooldownSeconds: 300, strategy: 'best' }
/** A session line with a real buffer and weekly lines run nearly dry. */
const TIGHT: Partial<Settings> = { ...SETTINGS, threshold: 98 }
const OPTS = options(SETTINGS)
const TIGHT_OPTS = options(TIGHT)

function makeUsage(opts: {
  five?: number | null
  week?: number | null
  fable?: number | null
  ok?: boolean
  weekReset?: string | null
  fableReset?: string | null
} = {}): Usage {
  const { five = 10, week = 20, fable = null, ok = true, weekReset = '2026-09-08T10:00:00Z', fableReset = '2026-09-07T10:00:00Z' } = opts
  const windows = []
  if (five !== null) windows.push({ key: 'five_hour', label: '5-hour', pct: five, resetsAt: null })
  if (week !== null) windows.push({ key: 'seven_day', label: 'Weekly', pct: week, resetsAt: weekReset })
  if (fable !== null) windows.push({ key: 'model:fable', label: 'Fable weekly', pct: fable, resetsAt: fableReset })
  return { fetchedAt: '2026-09-04T18:00:00Z', ok, error: ok ? null : 'boom', windows, plan: 'max' }
}

const acct = (id: string, usage: Usage | null, active = false, disabled = false): PolicyAccount => ({ id, active, disabled, usage })

describe('gating windows and headroom', () => {
  it('includes the Fable window but not other models', () => {
    const usage = makeUsage({ five: 10, week: 20, fable: 80 })
    usage.windows.push({ key: 'model:other', label: 'Other', pct: 99, resetsAt: null })
    expect(gatingWindows(usage).map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'model:fable'])
    expect(gatingWindows(usage, 'Other').map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'model:other'])
    expect(bindingWindow(usage, options({ model: 'Other' }))?.key).toBe('model:other')
  })

  it('headroom is the 5-hour session unless a weekly window is past the warn line and tighter', () => {
    // The everyday case: a fresh session, weeks half used. The session is what you are working in.
    expect(bindingWindow(makeUsage({ five: 1, week: 32, fable: 53 }), OPTS)?.key).toBe('five_hour')
    expect(headroom(makeUsage({ five: 1, week: 32, fable: 53 }), OPTS)).toBe(99)
    // A weekly window past the warn line and higher than the session takes over.
    expect(bindingWindow(makeUsage({ five: 10, week: 20, fable: 85 }), OPTS)?.key).toBe('model:fable')
    expect(headroom(makeUsage({ five: 10, week: 20, fable: 85 }), OPTS)).toBe(15)
    // Past the warn line but the session is higher still: the session binds.
    expect(bindingWindow(makeUsage({ five: 88, week: 85 }), OPTS)?.key).toBe('five_hour')
    // Just under the warn line: the session binds however low it is.
    expect(bindingWindow(makeUsage({ five: 10, week: 79 }), OPTS)?.key).toBe('five_hour')
    // At the warn line exactly: the week binds.
    expect(bindingWindow(makeUsage({ five: 10, week: 80 }), OPTS)?.key).toBe('seven_day')
    // The tightest weekly window wins among those over the line.
    expect(bindingWindow(makeUsage({ five: 10, week: 82, fable: 90 }), OPTS)?.key).toBe('model:fable')
  })

  it('falls back to the highest window when there is no session window', () => {
    expect(bindingWindow(makeUsage({ five: null, week: 20, fable: 53 }), OPTS)?.key).toBe('model:fable')
    expect(headroom(makeUsage({ five: null, week: 20, fable: 53 }), OPTS)).toBe(47)
  })

  it('caps the takeover line at the weekly swap line', () => {
    // warn 95 above a weekly line of 90: a week at 92 is about to be swapped on, so it binds.
    const o = options({ warnPct: 95, threshold: 90, fiveHourThreshold: 90 })
    expect(bindingWindow(makeUsage({ five: 10, week: 92 }), o)?.key).toBe('seven_day')
  })

  it('handles unknown, stale and empty usage', () => {
    expect(headroom(null, OPTS)).toBeNull()
    expect(bindingWindow(undefined, OPTS)).toBeNull()
    // A failed poll keeps the last windows: stale numbers still count, empty ones do not.
    expect(headroom({ ...makeUsage({ five: 10, week: 20 }), ok: false }, OPTS)).toBe(90)
    expect(headroom({ ...makeUsage({ ok: false }), windows: [] }, OPTS)).toBeNull()
  })

  it('reads one axis at a time', () => {
    const usage = makeUsage({ five: 40, week: 70, fable: 85 })
    expect(sessionHeadroom(usage)).toBe(60)
    expect(weeklyHeadroom(usage)).toBe(15)
    expect(overallHeadroom(usage)).toBe(15)
    expect(sessionHeadroom(makeUsage({ five: null, week: 70 }))).toBe(30) // no session: overall
    expect(weeklyHeadroom(makeUsage({ five: 40, week: null }))).toBe(60) // no weekly: overall
    expect(sessionHeadroom(null)).toBeNull()
  })

  it('nearLimit and closestToLine use each window’s own swap line', () => {
    expect(nearLimit(makeUsage({ five: 90, week: 40 }), TIGHT_OPTS)?.key).toBe('five_hour')
    expect(nearLimit(makeUsage({ five: 89, week: 97 }), TIGHT_OPTS)).toBeNull()
    expect(nearLimit(makeUsage({ five: 89, week: 98 }), TIGHT_OPTS)?.key).toBe('seven_day')
    // Both over: the one furthest past its line.
    expect(nearLimit(makeUsage({ five: 91, week: 100 }), TIGHT_OPTS)?.key).toBe('seven_day')
    expect(nearLimit(makeUsage({ five: 99, week: 98 }), TIGHT_OPTS)?.key).toBe('five_hour')
    // Fewest points left before its line, whichever line that is.
    expect(closestToLine(makeUsage({ five: 82, week: 85 }), TIGHT_OPTS)?.key).toBe('five_hour') // 8 vs 13
    expect(closestToLine(makeUsage({ five: 50, week: 85 }), TIGHT_OPTS)?.key).toBe('seven_day')
    expect(closestToLine(null, TIGHT_OPTS)).toBeNull()
  })

  it('rounds headroom to one decimal', () => {
    expect(headroom(makeUsage({ five: 33.33, week: 1 }), OPTS)).toBe(66.7)
  })
})

describe('decide', () => {
  it('switches on a Fable-only hit even when the session is fine', () => {
    const d = decide(
      [acct('acc_1', makeUsage({ five: 30, week: 40, fable: 95 }), true), acct('acc_2', makeUsage({ five: 10, week: 20, fable: 15 }))],
      SETTINGS,
      NOW,
    )
    expect(d.action).toBe('switch')
    expect(d.targetId).toBe('acc_2')
    expect(d.reason).toContain('model:fable at 95% >= 90%')
    expect(d.reason).toContain('weekly headroom')
    expect(d.at).toBe(NOW.toISOString())
  })

  it('switches when the session reaches its own line while the weeks are far under theirs', () => {
    const d = decide([acct('acc_1', makeUsage({ five: 90, week: 40 }), true), acct('acc_2', makeUsage({ five: 5, week: 70 }))], TIGHT, NOW)
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_2'])
    expect(d.reason).toContain('five_hour at 90% >= 90%')
    expect(d.reason).toContain('95% session headroom')
  })

  it('does not swap on a weekly window under its line even when it is the binding window', () => {
    const d = decide([acct('acc_1', makeUsage({ five: 10, week: 95 }), true), acct('acc_2', makeUsage({ five: 0, week: 0 }))], TIGHT, NOW)
    expect(d.action).toBe('stay')
    expect(d.reason).toBe('seven_day at 95% < 98%')
  })

  it('stays when not near limit under the best strategy', () => {
    const d = decide([acct('acc_1', makeUsage({ five: 50, week: 60 }), true), acct('acc_2', makeUsage({ five: 0, week: 0 }))], SETTINGS, NOW)
    expect(d.action).toBe('stay')
    expect(d.targetId).toBeNull()
    expect(d.reason).toBe('five_hour at 50% < 90%')
  })

  it('compares targets on session headroom when the session hit', () => {
    const d = decide(
      [
        acct('acc_1', makeUsage({ five: 92, week: 40 }), true),
        acct('acc_2', makeUsage({ five: 0, week: 85 })), // fresh session; the week shows on its gauge but is not what we are out of
        acct('acc_3', makeUsage({ five: 60, week: 30 })),
      ],
      TIGHT,
      NOW,
    )
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_2'])
    expect(d.reason).toContain('acc_2 has 100% session headroom')
  })

  it('compares targets on weekly headroom when a weekly window hit', () => {
    const d = decide(
      [
        acct('acc_1', makeUsage({ five: 30, week: 98 }), true),
        acct('acc_2', makeUsage({ five: 0, week: 95 })), // weekly headroom 5, only 3 more than the active: under margin
        acct('acc_3', makeUsage({ five: 60, week: 50 })),
      ],
      TIGHT,
      NOW,
    )
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_3'])
    expect(d.reason).toContain('seven_day at 98% >= 98%')
    expect(d.reason).toContain('50% weekly headroom')
  })

  it('picks the greatest headroom and ignores disabled and unknown accounts', () => {
    const d = decide(
      [
        acct('acc_1', makeUsage({ five: 92, week: 10 }), true),
        acct('acc_2', makeUsage({ five: 40, week: 40 })), // session headroom 60
        acct('acc_3', makeUsage({ five: 0, week: 0 }), false, true), // best but disabled
        acct('acc_4', null), // never fetched
        acct('acc_5', { ...makeUsage({ ok: false }), windows: [] }), // fetch failed, nothing known
        acct('acc_6', makeUsage({ five: 20, week: 30 })), // session headroom 80
      ],
      SETTINGS,
      NOW,
    )
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_6'])
  })

  it('breaks ties on the other axis, then on id', () => {
    const tie = decide(
      [acct('acc_1', makeUsage({ five: 95, week: 10 }), true), acct('acc_2', makeUsage({ five: 0, week: 60 })), acct('acc_3', makeUsage({ five: 0, week: 20 }))],
      SETTINGS,
      NOW,
    )
    expect(tie.targetId).toBe('acc_3')
    const same = decide(
      [acct('acc_1', makeUsage({ five: 95, week: 10 }), true), acct('acc_9', makeUsage({ five: 0, week: 20 })), acct('acc_2', makeUsage({ five: 0, week: 20 }))],
      SETTINGS,
      NOW,
    )
    expect(same.targetId).toBe('acc_2')
  })

  it('applies margin hysteresis', () => {
    const accounts = [acct('acc_1', makeUsage({ five: 90, week: 10 }), true), acct('acc_2', makeUsage({ five: 85, week: 10 }))]
    const blocked = decide(accounts, SETTINGS, NOW)
    expect(blocked.action).toBe('blocked')
    expect(blocked.reason).toContain('10+ points more session headroom')
    const d = decide(accounts, { ...SETTINGS, margin: 5 }, NOW)
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_2'])
  })

  it('rejects candidates over any of their own lines and blocks when everyone is exhausted', () => {
    expect(decide([acct('acc_1', makeUsage({ five: 100, week: 10 }), true), acct('acc_2', makeUsage({ five: 90, week: 10 }))], SETTINGS, NOW).action).toBe('blocked')
    // A fresh session does not qualify an account whose week is over its line.
    expect(decide([acct('acc_1', makeUsage({ five: 100, week: 10 }), true), acct('acc_2', makeUsage({ five: 0, week: 98 }))], TIGHT, NOW).action).toBe('blocked')
    const d = decide(
      [acct('acc_1', makeUsage({ five: 99, week: 99 }), true), acct('acc_2', makeUsage({ five: 95, week: 10 })), acct('acc_3', makeUsage({ five: 10, week: 97 }))],
      SETTINGS,
      NOW,
    )
    expect(d.action).toBe('blocked')
    expect(d.targetId).toBeNull()
  })

  it('turns a switch into a stay during cooldown', () => {
    const accounts = [acct('acc_1', makeUsage({ five: 95, week: 10 }), true), acct('acc_2', makeUsage({ five: 5, week: 10 }))]
    const recent = new Date(NOW.getTime() - 100_000)
    const d = decide(accounts, SETTINGS, NOW, recent)
    expect(d.action).toBe('stay')
    expect(d.reason.startsWith('cooldown')).toBe(true)
    expect(d.targetId).toBe('acc_2')
    expect(decide(accounts, SETTINGS, NOW, new Date(NOW.getTime() - 301_000)).action).toBe('switch')
  })

  it('dry-run prefixes the reason and keeps the target', () => {
    const d = decide([acct('acc_1', makeUsage({ five: 95, week: 10 }), true), acct('acc_2', makeUsage({ five: 5, week: 10 }))], { ...SETTINGS, dryRun: true }, NOW)
    expect(d.action).toBe('stay')
    expect(d.targetId).toBe('acc_2')
    expect(d.reason.startsWith('dry-run:')).toBe(true)
  })

  it('consume_first prefers the soonest weekly reset, judged on weekly headroom', () => {
    const accounts = [
      acct('acc_1', makeUsage({ five: 10, week: 50, weekReset: '2026-09-10T00:00:00Z' }), true),
      acct('acc_2', makeUsage({ five: 10, week: 30, weekReset: '2026-09-09T00:00:00Z' })),
      acct('acc_3', makeUsage({ five: 10, week: 20, fable: 35, weekReset: '2026-09-09T12:00:00Z', fableReset: '2026-09-05T00:00:00Z' })),
    ]
    const d = decide(accounts, { ...SETTINGS, strategy: 'consume_first' }, NOW)
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_3'])
    expect(d.reason.startsWith('consume-first')).toBe(true)
    expect(d.reason).toContain('65% weekly headroom')
    expect(weeklyReset(accounts[2]!.usage)).toEqual(new Date('2026-09-05T00:00:00Z'))
  })

  it('consume_first respects margin and the lines, and still switches near limit', () => {
    const stay = decide(
      [
        acct('acc_1', makeUsage({ five: 10, week: 50 }), true),
        acct('acc_2', makeUsage({ five: 10, week: 45, weekReset: '2026-09-05T00:00:00Z' })), // +5 weekly only
        acct('acc_3', makeUsage({ five: 10, week: 92, weekReset: '2026-09-04T20:00:00Z' })), // over its line
      ],
      { ...SETTINGS, strategy: 'consume_first' },
      NOW,
    )
    expect(stay.action).toBe('stay')
    expect(stay.reason).toBe('five_hour at 10%; nothing to consume')
    const sw = decide([acct('acc_1', makeUsage({ five: 95, week: 50 }), true), acct('acc_2', makeUsage({ five: 10, week: 10 }))], { ...SETTINGS, strategy: 'consume_first' }, NOW)
    expect([sw.action, sw.targetId]).toEqual(['switch', 'acc_2'])
  })

  it('stays when the active usage is unknown or nobody is active', () => {
    expect(decide([acct('acc_1', null, true)], SETTINGS, NOW).action).toBe('stay')
    expect(decide([acct('acc_1', makeUsage())], SETTINGS, NOW).action).toBe('stay')
    expect(decide([], SETTINGS, NOW).action).toBe('stay')
  })
})
