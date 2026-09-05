import { describe, expect, it } from 'vitest'

import type { Settings, Usage } from '../shared/types'
import { bindingWindow, decide, gatingWindows, headroom, weeklyReset, type PolicyAccount } from './autoswap'

const NOW = new Date('2026-09-04T18:00:00Z')
const SETTINGS: Partial<Settings> = { threshold: 90, margin: 10, cooldownSeconds: 300, strategy: 'best' }

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
    expect(headroom(usage)).toBe(20)
    expect(bindingWindow(usage)?.key).toBe('model:fable')
    expect(headroom(null)).toBeNull()
    // A failed poll keeps the last windows: stale numbers still count, empty ones do not.
    expect(headroom({ ...makeUsage({ five: 10, week: 20 }), ok: false })).toBe(80)
    expect(headroom({ ...makeUsage({ ok: false }), windows: [] })).toBeNull()
    expect(gatingWindows(usage, 'Other').map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'model:other'])
  })

  it('rounds headroom to one decimal', () => {
    expect(headroom(makeUsage({ five: 33.33, week: 1 }))).toBe(66.7)
  })
})

describe('decide', () => {
  it('switches on a Fable-only hit even when global windows are fine', () => {
    const d = decide(
      [acct('acc_1', makeUsage({ five: 30, week: 40, fable: 95 }), true), acct('acc_2', makeUsage({ five: 10, week: 20, fable: 15 }))],
      SETTINGS,
      NOW,
    )
    expect(d.action).toBe('switch')
    expect(d.targetId).toBe('acc_2')
    expect(d.reason).toContain('model:fable')
    expect(d.at).toBe(NOW.toISOString())
  })

  it('stays when not near limit under the best strategy', () => {
    const d = decide([acct('acc_1', makeUsage({ five: 50, week: 60 }), true), acct('acc_2', makeUsage({ five: 0, week: 0 }))], SETTINGS, NOW)
    expect(d.action).toBe('stay')
    expect(d.targetId).toBeNull()
  })

  it('picks the greatest headroom and ignores disabled and unknown accounts', () => {
    const d = decide(
      [
        acct('acc_1', makeUsage({ five: 92, week: 10 }), true),
        acct('acc_2', makeUsage({ five: 5, week: 40 })), // headroom 60
        acct('acc_3', makeUsage({ five: 0, week: 0 }), false, true), // best but disabled
        acct('acc_4', null), // never fetched
        acct('acc_5', { ...makeUsage({ ok: false }), windows: [] }), // fetch failed, nothing known
        acct('acc_6', makeUsage({ five: 20, week: 30 })), // headroom 70
      ],
      SETTINGS,
      NOW,
    )
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_6'])
  })

  it('applies margin hysteresis', () => {
    const accounts = [acct('acc_1', makeUsage({ five: 90, week: 10 }), true), acct('acc_2', makeUsage({ five: 85, week: 10 }))]
    expect(decide(accounts, SETTINGS, NOW).action).toBe('blocked')
    const d = decide(accounts, { ...SETTINGS, margin: 5 }, NOW)
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_2'])
  })

  it('rejects candidates at or over threshold and blocks when everyone is exhausted', () => {
    expect(decide([acct('acc_1', makeUsage({ five: 100, week: 10 }), true), acct('acc_2', makeUsage({ five: 90, week: 10 }))], SETTINGS, NOW).action).toBe('blocked')
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

  it('consume_first prefers the soonest weekly reset', () => {
    const accounts = [
      acct('acc_1', makeUsage({ five: 10, week: 50, weekReset: '2026-09-10T00:00:00Z' }), true),
      acct('acc_2', makeUsage({ five: 10, week: 30, weekReset: '2026-09-09T00:00:00Z' })),
      acct('acc_3', makeUsage({ five: 10, week: 20, fable: 35, weekReset: '2026-09-09T12:00:00Z', fableReset: '2026-09-05T00:00:00Z' })),
    ]
    const d = decide(accounts, { ...SETTINGS, strategy: 'consume_first' }, NOW)
    expect([d.action, d.targetId]).toEqual(['switch', 'acc_3'])
    expect(d.reason.startsWith('consume-first')).toBe(true)
    expect(weeklyReset(accounts[2]!.usage)).toEqual(new Date('2026-09-05T00:00:00Z'))
  })

  it('consume_first respects margin and threshold, and still switches near limit', () => {
    const stay = decide(
      [
        acct('acc_1', makeUsage({ five: 10, week: 50 }), true),
        acct('acc_2', makeUsage({ five: 10, week: 45, weekReset: '2026-09-05T00:00:00Z' })), // +5 only
        acct('acc_3', makeUsage({ five: 10, week: 92, weekReset: '2026-09-04T20:00:00Z' })), // over
      ],
      { ...SETTINGS, strategy: 'consume_first' },
      NOW,
    )
    expect(stay.action).toBe('stay')
    const sw = decide([acct('acc_1', makeUsage({ five: 95, week: 50 }), true), acct('acc_2', makeUsage({ five: 10, week: 10 }))], { ...SETTINGS, strategy: 'consume_first' }, NOW)
    expect([sw.action, sw.targetId]).toEqual(['switch', 'acc_2'])
  })

  it('stays when the active usage is unknown or nobody is active', () => {
    expect(decide([acct('acc_1', null, true)], SETTINGS, NOW).action).toBe('stay')
    expect(decide([acct('acc_1', makeUsage())], SETTINGS, NOW).action).toBe('stay')
    expect(decide([], SETTINGS, NOW).action).toBe('stay')
  })
})
