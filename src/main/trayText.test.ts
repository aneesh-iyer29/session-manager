import { describe, expect, it } from 'vitest'
import type { Account, AppState, CodexState } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { accountRight, bar, codexHeader, countdown, menuRows, orderedWindows, resetText, rowText, rowsHtml, statusLine, tone } from './trayText'

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

const codexNone: CodexState = { configured: false, mode: 'none', email: null, plan: null, usage: null }

function state(extra: Partial<AppState> = {}): AppState {
  return {
    version: 't',
    now: now.toISOString(),
    activeId: 'acc_1',
    polling: { lastPollAt: '2026-09-04T11:59:48Z', nextPollAt: null, inFlight: false },
    autoswap: { lastDecision: null, lastSwitchAt: null },
    settings: { ...DEFAULT_SETTINGS, autoswapEnabled: true },
    accounts: [account()],
    codex: codexNone,
    nudge: { hookInstalled: false, pending: null },
    events: [],
    ...extra,
  }
}

describe('bar and countdown', () => {
  it('fills ten segments proportionally and clamps', () => {
    expect(bar(0)).toBe('▯▯▯▯▯▯▯▯▯▯')
    expect(bar(63)).toBe('▮▮▮▮▮▮▯▯▯▯')
    expect(bar(140)).toBe('▮▮▮▮▮▮▮▮▮▮')
    expect(bar(null)).toBe('▯▯▯▯▯▯▯▯▯▯')
  })

  it('formats countdowns', () => {
    expect(countdown('2026-09-06T15:00:00Z', now)).toBe('2d 3h')
    expect(countdown('2026-09-04T14:13:00Z', now)).toBe('2h 13m')
    expect(countdown('2026-09-04T11:00:00Z', now)).toBe('now')
    expect(countdown(null, now)).toBe('')
  })
})

describe('resetText', () => {
  it('uses "in N hr M min" inside a day and a weekday time beyond it', () => {
    expect(resetText('2026-09-04T14:13:00Z', now)).toBe('Resets in 2 hr 13 min')
    expect(resetText('2026-09-04T14:00:00Z', now)).toBe('Resets in 2 hr')
    expect(resetText('2026-09-04T12:38:00Z', now)).toBe('Resets in 38 min')
    expect(resetText('2026-09-04T11:00:00Z', now)).toBe('Resets now')
    expect(resetText(null, now)).toBe('')
    const later = resetText('2026-09-07T10:00:00Z', now)
    expect(later.startsWith('Resets Mon ')).toBe(true)
    expect(later).toMatch(/\d{1,2}:\d{2}/)
  })
})

describe('tone', () => {
  it('follows the headroom buckets and the threshold', () => {
    expect(tone(21, 90)).toBe('ok')
    expect(tone(75, 90)).toBe('warn')
    expect(tone(92, 90)).toBe('danger')
    expect(tone(85, 80)).toBe('danger')
    expect(tone(null, 90)).toBe('unknown')
  })
})

describe('rows', () => {
  it('orders windows 5-hour, weekly, model', () => {
    expect(orderedWindows(account()).map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'model:fable'])
  })

  it('builds account right-hand text', () => {
    expect(accountRight(account())).toBe('Max · Active')
    expect(accountRight(account({ active: false, disabled: true, tokenStatus: 'dead' }))).toBe('Max · Held out · Needs login')
    expect(accountRight(account({ plan: null, active: false }))).toBe('')
  })

  it('describes codex modes', () => {
    expect(codexHeader(codexNone)).toEqual({ title: 'Codex', right: 'Not configured' })
    expect(codexHeader({ ...codexNone, configured: true, mode: 'apikey' })).toEqual({ title: 'Codex', right: 'API key · no quota' })
    expect(codexHeader({ ...codexNone, configured: true, mode: 'chatgpt', plan: 'pro', email: 'me@x.dev' })).toEqual({ title: 'Codex · me@x.dev', right: 'Pro' })
  })

  it('summarises armed state and poll age', () => {
    expect(statusLine(state(), now)).toBe('Auto-swap armed · polled 12s ago')
    expect(statusLine(state({ settings: { ...DEFAULT_SETTINGS, autoswapEnabled: true, dryRun: true } }), now)).toBe('Auto-swap dry run · polled 12s ago')
  })

  it('assembles the whole menu in display order', () => {
    const rows = menuRows(state(), now)
    expect(rows.map((r) => r.kind)).toEqual(['header', 'window', 'window', 'window', 'header', 'status'])
    expect(rows[0]).toEqual({ kind: 'header', title: 'work', right: 'Max · Active' })
    expect(rows[1]).toEqual({ kind: 'window', label: '5-hour limit', right: 'Resets in 2 hr 13 min', pct: 21, tone: 'ok' })
    expect(rows[2]).toMatchObject({ label: 'Weekly · all models', right: '', pct: 51 })
    expect(rows[3]).toMatchObject({ label: 'Weekly · Fable', pct: 63, tone: 'ok' })
    expect(rows[4]).toEqual({ kind: 'header', title: 'Codex', right: 'Not configured' })
  })

  it('has an empty-state row and hides codex when disabled', () => {
    const rows = menuRows(state({ accounts: [], settings: { ...DEFAULT_SETTINGS, codexEnabled: false } }), now)
    expect(rows.map((r) => r.kind)).toEqual(['status', 'status'])
    expect(rows[0]).toMatchObject({ text: 'No accounts yet · open Session Manager to add one' })
  })

  it('renders text fallbacks and html for every row kind', () => {
    const rows = menuRows(state(), now)
    expect(rowText(rows[0]!)).toBe('work  ·  Max · Active')
    expect(rowText(rows[1]!)).toBe('5-hour limit         ▮▮▯▯▯▯▯▯▯▯  21%  ·  Resets in 2 hr 13 min')
    const html = rowsHtml(rows, false)
    expect(html).toContain('5-hour limit')
    expect(html).toContain('width:21%')
    expect(html).toContain('<b>63%</b>')
    expect(html).not.toContain('<script')
    expect(rowsHtml([{ kind: 'header', title: '<x>', right: '&' }], true)).toContain('&lt;x&gt;')
  })
})
