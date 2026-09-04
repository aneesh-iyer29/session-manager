import { describe, expect, it } from 'vitest'
import {
  bindingWindowOf,
  displayName,
  formatAgo,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatPlan,
  headroomBucket,
  localPart,
  secondaryWindows,
} from './format'

const now = new Date('2026-09-04T18:00:00Z')
const plus = (ms: number) => new Date(now.getTime() + ms).toISOString()

describe('formatCountdown', () => {
  it('renders hours and minutes under a day', () => {
    expect(formatCountdown(plus(2 * 3600_000 + 14 * 60_000), now)).toBe('2h 14m')
  })
  it('pads minutes so the width is stable', () => {
    expect(formatCountdown(plus(2 * 3600_000 + 5 * 60_000), now)).toBe('2h 05m')
  })
  it('renders days and hours over a day', () => {
    expect(formatCountdown(plus(3 * 86_400_000 + 4 * 3600_000 + 59 * 60_000), now)).toBe('3d 4h')
  })
  it('renders minutes only under an hour', () => {
    expect(formatCountdown(plus(14 * 60_000 + 30_000), now)).toBe('14m')
  })
  it('handles the edges', () => {
    expect(formatCountdown(plus(20_000), now)).toBe('<1m')
    expect(formatCountdown(plus(-1), now)).toBe('now')
    expect(formatCountdown(null, now)).toBe('—')
    expect(formatCountdown('garbage', now)).toBe('—')
  })
})

describe('formatAgo', () => {
  it('scales units', () => {
    expect(formatAgo(plus(-12_000), now)).toBe('12 s ago')
    expect(formatAgo(plus(-3 * 60_000), now)).toBe('3 min ago')
    expect(formatAgo(plus(-2 * 3600_000), now)).toBe('2 h ago')
    expect(formatAgo(plus(-500), now)).toBe('just now')
    expect(formatAgo(null, now)).toBe('never')
  })
})

describe('formatPercent', () => {
  it('rounds and clamps', () => {
    expect(formatPercent(63.2)).toBe('63%')
    expect(formatPercent(140)).toBe('100%')
    expect(formatPercent(-3)).toBe('0%')
    expect(formatPercent(null)).toBe('—')
  })
})

describe('headroomBucket', () => {
  it('uses the brief thresholds', () => {
    expect(headroomBucket(30)).toBe('ok')
    expect(headroomBucket(29)).toBe('warn')
    expect(headroomBucket(11)).toBe('warn')
    expect(headroomBucket(10)).toBe('danger')
    expect(headroomBucket(0)).toBe('danger')
    expect(headroomBucket(null)).toBe('unknown')
  })
  it('forces danger at the autoswap threshold', () => {
    expect(headroomBucket(80, true)).toBe('danger')
  })
})

describe('names', () => {
  it('prefers the alias, else the local part', () => {
    expect(displayName({ alias: 'work', email: 'me@acme.com' })).toBe('work')
    expect(displayName({ alias: '  ', email: 'me@acme.com' })).toBe('me')
    expect(localPart('nobody')).toBe('nobody')
  })
  it('maps plans to display form', () => {
    expect(formatPlan('max')).toBe('Max')
    expect(formatPlan(null)).toBe('')
    expect(formatPlan('weird')).toBe('weird')
  })
  it('formats durations compactly', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(300)).toBe('5 min')
    expect(formatDuration(5400)).toBe('1.5 h')
  })
})

describe('windows', () => {
  const usage = {
    fetchedAt: now.toISOString(),
    ok: true,
    error: null,
    plan: 'max',
    windows: [
      { key: 'model:fable', label: 'Fable weekly', pct: 63, resetsAt: null },
      { key: 'seven_day', label: 'Weekly', pct: 51, resetsAt: null },
      { key: 'five_hour', label: '5-hour', pct: 21, resetsAt: null },
    ],
  }
  it('resolves the binding window and orders the rest', () => {
    expect(bindingWindowOf({ bindingWindow: 'model:fable', usage })?.pct).toBe(63)
    expect(bindingWindowOf({ bindingWindow: null, usage })).toBeNull()
    expect(secondaryWindows(usage, 'model:fable').map((w) => w.key)).toEqual(['five_hour', 'seven_day'])
    expect(secondaryWindows(null, null)).toEqual([])
  })
})
