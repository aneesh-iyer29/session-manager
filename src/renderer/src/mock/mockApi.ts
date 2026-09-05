/**
 * In-memory SwapperApi for `npm run dev:web`. It behaves like the daemon as
 * seen from the renderer: every mutation returns the new AppState AND pushes it
 * to `onState` subscribers, errors reject with user-safe messages, and the login
 * flow resolves a few seconds later with a fresh account. Nothing here touches
 * the network or disk, so the UI can be built and screenshotted anywhere.
 */
import type { AppState, Decision, LoginStatus, Settings, SwapperEvent } from '@shared/types'
import type { SwapperApi } from '@shared/ipc'
import { buildState, makeUsage, seedAccounts, seedCodex, seedEvents, seedSettings, type MockAccount } from './fixture'

const LATENCY_MS = 250

export function createMockApi(): SwapperApi {
  const started = new Date()
  let accounts = seedAccounts(started)
  let settings: Settings = { ...seedSettings }
  let events = seedEvents(started)
  let codex = seedCodex(started)
  let activeId: string | null = 'acc_1'
  let hookInstalled = false
  let lastPollAt: string | null = new Date(started.getTime() - 12_000).toISOString()
  let inFlight = false
  let lastSwitchAt: string | null = events.find((e) => e.kind === 'switch')?.at ?? null
  let lastDecision: Decision | null = {
    action: 'stay',
    targetId: null,
    reason: 'work has 37% headroom, above threshold',
    at: lastPollAt ?? started.toISOString(),
  }
  let eventSeq = 100
  let accountSeq = 4
  const logins = new Map<string, { status: LoginStatus; timer: ReturnType<typeof setTimeout> | null }>()
  const listeners = new Set<(s: AppState) => void>()

  const snapshot = (): AppState =>
    buildState({
      version: '0.1.0-mock',
      now: new Date(),
      activeId,
      accounts,
      settings,
      codex,
      events,
      lastPollAt,
      inFlight,
      lastDecision,
      lastSwitchAt,
      nudge: { hookInstalled, pending: pendingNudge() },
    })

  /** Mirror the daemon: flag when the active account's worst gating window is at or past warnPct. */
  function pendingNudge(): AppState['nudge']['pending'] {
    if (!settings.autoswapEnabled || settings.dryRun) return null
    const a = accounts.find((x) => x.id === activeId)
    if (!a?.usage) return null
    const gating = a.usage.windows.filter((w) => w.key === 'five_hour' || w.key === 'seven_day' || w.key === `model:${settings.model.toLowerCase()}`)
    const worst = gating.reduce<(typeof gating)[number] | null>((m, w) => (m == null || w.pct > m.pct ? w : m), null)
    if (!worst || worst.pct < settings.warnPct) return null
    const label = a.alias || a.email
    const pct = Math.round(worst.pct)
    return {
      id: `${a.id}:${worst.key}:${worst.resetsAt ?? 'unknown'}`,
      at: new Date().toISOString(),
      accountId: a.id,
      label,
      window: worst.label,
      pct,
      message: `${label} is at ${pct}% of ${worst.label} and will be swapped at ${settings.threshold}%.`,
    }
  }

  const push = (): AppState => {
    const s = snapshot()
    for (const cb of listeners) cb(s)
    return s
  }

  const log = (kind: SwapperEvent['kind'], message: string, accountId: string | null = null) => {
    events = [{ id: `ev_${eventSeq++}`, at: new Date().toISOString(), kind, message, accountId }, ...events].slice(0, 100)
  }

  const find = (id: string): MockAccount => {
    const a = accounts.find((x) => x.id === id)
    if (!a) throw new Error(`No account ${id}`)
    return a
  }

  const name = (a: MockAccount) => a.alias || a.email.split('@')[0] || a.email

  /** Simulates IPC latency so loading states are visible while developing. */
  const later = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(fn())
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }, LATENCY_MS)
    })

  const api: SwapperApi = {
    getState: () => Promise.resolve(snapshot()),

    refresh: () => {
      inFlight = true
      push()
      return new Promise((resolve) => {
        setTimeout(() => {
          const now = new Date()
          // Nudge usage so meters visibly animate on refresh.
          accounts = accounts.map((a) =>
            a.usage
              ? {
                  ...a,
                  usage: {
                    ...a.usage,
                    fetchedAt: now.toISOString(),
                    windows: a.usage.windows.map((w) => ({ ...w, pct: Math.min(100, w.pct + (a.id === activeId ? 1 : 0)) })),
                  },
                }
              : a,
          )
          codex = seedCodex(now)
          lastPollAt = now.toISOString()
          inFlight = false
          const active = accounts.find((a) => a.id === activeId)
          const binding = active?.usage?.windows.find((w) => w.key === 'model:fable')
          lastDecision = {
            action: 'stay',
            targetId: null,
            reason: active && binding ? `${name(active)} has ${100 - binding.pct}% headroom, above threshold` : 'no active account',
            at: now.toISOString(),
          }
          log('info', `Refreshed ${accounts.filter((a) => !a.disabled).length} accounts`)
          resolve(push())
        }, 700)
      })
    },

    switchTo: (id) =>
      later(() => {
        const target = find(id)
        if (target.id === activeId) throw new Error(`${name(target)} is already active`)
        if (target.tokenStatus === 'dead') throw new Error(`${name(target)}'s login has expired. Remove it and log in again.`)
        const previous = accounts.find((a) => a.id === activeId)
        activeId = target.id
        lastSwitchAt = new Date().toISOString()
        log('switch', `Switched ${previous ? name(previous) : '—'} → ${name(target)}`, target.id)
        return push()
      }),

    captureActive: () =>
      later(() => {
        const active = accounts.find((a) => a.id === activeId)
        if (!active) throw new Error("Claude Code isn't logged in. Run `claude` and sign in, then capture again.")
        active.tokenStatus = 'ok'
        log('capture', `Captured ${name(active)} from Claude Code`, active.id)
        return push()
      }),

    startLogin: () => {
      const id = `login_${Date.now()}`
      const status: LoginStatus = {
        id,
        status: 'pending',
        url: 'https://claude.ai/oauth/authorize?client_id=mock&state=mock',
      }
      const timer = setTimeout(() => {
        const now = new Date()
        const acc: MockAccount = {
          id: `acc_${accountSeq++}`,
          email: `new${accountSeq}@example.com`,
          alias: '',
          orgName: 'Personal',
          orgUuid: `org-${accountSeq}`,
          accountUuid: `acct-${accountSeq}`,
          plan: 'pro',
          disabled: false,
          addedAt: now.toISOString(),
          tokenStatus: 'ok',
          usage: { ...makeUsage(now, { fiveHour: 0, weekly: 2, model: 3 }), plan: 'pro' },
        }
        accounts = [...accounts, acc]
        log('login', `Added ${name(acc)} via browser login`, acc.id)
        const state = push()
        const entry = logins.get(id)
        if (entry) entry.status = { ...status, status: 'done', account: state.accounts.find((a) => a.id === acc.id) }
      }, 3000)
      logins.set(id, { status, timer })
      return Promise.resolve(status)
    },

    loginStatus: (id) => {
      const entry = logins.get(id)
      if (!entry) return Promise.reject(new Error('Unknown login'))
      return Promise.resolve(entry.status)
    },

    cancelLogin: (id) => {
      const entry = logins.get(id)
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.status = { ...entry.status, status: 'error', error: 'Cancelled' }
      }
      return Promise.resolve()
    },

    setDisabled: (id, disabled) =>
      later(() => {
        const a = find(id)
        a.disabled = disabled
        log('info', disabled ? `Held ${name(a)} out of rotation` : `Returned ${name(a)} to rotation`, a.id)
        return push()
      }),

    setAlias: (id, alias) =>
      later(() => {
        const a = find(id)
        a.alias = alias.trim()
        return push()
      }),

    removeAccount: (id) =>
      later(() => {
        const a = find(id)
        if (a.id === activeId) throw new Error(`${name(a)} is active. Switch to another account first.`)
        accounts = accounts.filter((x) => x.id !== id)
        log('info', `Removed ${name(a)}`, null)
        return push()
      }),

    updateSettings: (patch) =>
      later(() => {
        const next = { ...settings, ...patch }
        if (next.threshold < 50 || next.threshold > 100) throw new Error('Threshold must be between 50 and 100.')
        if (next.margin < 0 || next.margin > 50) throw new Error('Margin must be between 0 and 50.')
        if (next.cooldownSeconds < 0) throw new Error('Cooldown cannot be negative.')
        if (next.pollIntervalSeconds < 15) throw new Error('Poll interval must be at least 15 seconds.')
        if (!next.model.trim()) throw new Error('Model name cannot be empty.')
        settings = next
        return push()
      }),

    openExternal: (url) => {
      window.open(url, '_blank', 'noopener')
      return Promise.resolve()
    },

    openDataFolder: () => Promise.resolve(),

    installHook: () =>
      later(() => {
        hookInstalled = true
        log('info', 'Claude Code compact-nudge hook installed', null)
        return push()
      }),

    uninstallHook: () =>
      later(() => {
        hookInstalled = false
        log('info', 'Claude Code compact-nudge hook removed', null)
        return push()
      }),

    onState: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }

  return api
}
