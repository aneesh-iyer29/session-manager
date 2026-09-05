import { describe, expect, it } from 'vitest'
import type { Account, AppState, CodexState } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { accountHeader, bar, codexHeader, countdown, orderedWindows, statusLine, windowLine } from './trayText'

const now = new Date('2026-09-04T12:00:00Z')

function account(extra: Partial<Account> = {}): Account {
  return {
    id: 'acc_1',
    email: 'work@acme.dev',
    alias: '',
    orgName: '',
    orgUuid: '',
    accountUuid: '',
    plan: 'max',
    active: true,
    disabled: false,
    addedAt: '',
    tokenStatus: 'ok',
    usage: {
      fetchedAt: now.toISOString(),
      ok: true,
      error: null,
      plan: 'max',
      windows: [
        { key: 'model:fable', label: 'Fable weekly', pct: 63, resetsAt: '2026-09-06T15:00:00Z' },
        { key: 'five_hour', label: '5-hour', pct: 21, resetsAt: '2026-09-04T14:13:00Z' },
        { key: 'seven_day', label: 'Weekly', pct: 51, resetsAt: null },
      ],
    },
    headroom: 37,
    bindingWindow: 'model:fable',
    ...extra,
  }
}

describe('bar', () => {
  it('fills ten segments proportionally and clamps', () => {
    expect(bar(0)).toBe('▯▯▯▯▯▯▯▯▯▯')
    expect(bar(63)).toBe('▮▮▮▮▮▮▯▯▯▯')
    expect(bar(100)).toBe('▮▮▮▮▮▮▮▮▮▮')
    expect(bar(140)).toBe('▮▮▮▮▮▮▮▮▮▮')
    expect(bar(null)).toBe('▯▯▯▯▯▯▯▯▯▯')
  })
})

describe('countdown', () => {
  it('formats days, hours, minutes, now, and unknown', () => {
    expect(countdown('2026-09-06T15:00:00Z', now)).toBe('2d 3h')
    expect(countdown('2026-09-04T14:13:00Z', now)).toBe('2h 13m')
    expect(countdown('2026-09-04T12:38:00Z', now)).toBe('38m')
    expect(countdown('2026-09-04T11:00:00Z', now)).toBe('now')
    expect(countdown(null, now)).toBe('')
  })
})

describe('menu lines', () => {
  it('orders windows 5-hour, weekly, model and renders a line', () => {
    const acc = account()
    expect(orderedWindows(acc).map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'model:fable'])
    expect(windowLine(orderedWindows(acc)[0]!, now)).toBe('5-hour       ▮▮▯▯▯▯▯▯▯▯  21%  ·  2h 13m')
    expect(windowLine(orderedWindows(acc)[1]!, now)).toBe('Weekly       ▮▮▮▮▮▯▯▯▯▯  51%')
  })

  it('builds account headers with plan and flags', () => {
    expect(accountHeader(account())).toBe('work  ·  Max  ·  ACTIVE')
    expect(accountHeader(account({ alias: 'lab', active: false, disabled: true, tokenStatus: 'dead' }))).toBe('lab  ·  Max  ·  held out · needs login')
    expect(accountHeader(account({ plan: null, active: false }))).toBe('work')
  })

  it('describes codex modes', () => {
    const base: CodexState = { configured: false, mode: 'none', email: null, plan: null, usage: null }
    expect(codexHeader(base)).toBe('Codex  ·  not configured')
    expect(codexHeader({ ...base, configured: true, mode: 'apikey' })).toBe('Codex  ·  API key (no quota)')
    expect(codexHeader({ ...base, configured: true, mode: 'chatgpt', plan: 'pro', email: 'me@x.dev' })).toBe('Codex  ·  Pro  ·  me@x.dev')
  })

  it('summarises armed state and poll age', () => {
    const state = {
      settings: { ...DEFAULT_SETTINGS, autoswapEnabled: true },
      polling: { lastPollAt: '2026-09-04T11:59:48Z', nextPollAt: null, inFlight: false },
    } as AppState
    expect(statusLine(state, now)).toBe('Auto-swap armed  ·  polled 12s ago')
    expect(statusLine({ ...state, settings: { ...state.settings, dryRun: true } }, now)).toBe('Auto-swap dry run  ·  polled 12s ago')
    expect(statusLine({ ...state, settings: DEFAULT_SETTINGS, polling: { lastPollAt: null, nextPollAt: null, inFlight: false } }, now)).toBe(
      'Auto-swap off  ·  not polled yet',
    )
  })
})
