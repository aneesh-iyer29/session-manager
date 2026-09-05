/**
 * Daemon tests. Hermetic: the store lives in a temp CLAUDE_SWAPPER_HOME, Claude
 * Code's config home (locks, ~/.claude.json) is a temp CLAUDE_CONFIG_DIR, the
 * Keychain is a variable behind readActive/writeActive, and every HTTP call goes
 * to a scripted fetch. The real store, switcher, autoswap and claudeOauth run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { credentialFingerprint } from './claudeOauth'
import { Daemon } from './daemon'
import { Store, type StoredAccount } from './store'
import type { CodexState } from '../shared/types'

const FUTURE = Date.parse('2030-01-01T00:00:00Z')
const PAST = Date.parse('2020-01-01T00:00:00Z')

function credential(token: string, refresh: string, expiresAt = FUTURE): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' },
  })
}

function account(id: string, email: string, cred: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    email,
    alias: '',
    orgName: 'Org',
    orgUuid: `org-${id}`,
    accountUuid: `acct-${id}`,
    plan: 'max',
    disabled: false,
    addedAt: '2026-01-01T00:00:00Z',
    fingerprint: credentialFingerprint(cred),
    tokenStatus: 'ok',
    ...extra,
  }
}

interface Harness {
  store: Store
  daemon: Daemon
  live: { value: string | null }
  writes: string[]
  /** Fable weekly pct served per access token. */
  fable: Map<string, number>
  refreshes: number
  clock: { now: Date }
  codexCalls: number
}

const CODEX: CodexState = { configured: true, mode: 'chatgpt', email: 'me@example.com', plan: 'pro', usage: null }

function usageBody(fablePct: number): unknown {
  return {
    five_hour: { utilization: 10, resets_at: '2030-01-01T05:00:00Z' },
    seven_day: { utilization: 20, resets_at: '2030-01-07T00:00:00Z' },
    limits: [{ kind: 'weekly_scoped', percent: fablePct, resets_at: '2030-01-07T00:00:00Z', scope: { model: { display_name: 'Fable' } } }],
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let dir = ''

function harness(opts: { autoswap?: boolean; cred2?: string } = {}): Harness {
  const store = new Store(process.env.CLAUDE_SWAPPER_HOME as string)
  const cred1 = credential('tok-1', 'ref-1')
  const cred2 = opts.cred2 ?? credential('tok-2', 'ref-2')
  store.upsertAccount(account('acc_1', 'work@example.com', cred1))
  store.upsertAccount(account('acc_2', 'personal@example.com', cred2))
  store.writeCredential('acc_1', cred1)
  store.writeCredential('acc_2', cred2)
  store.saveState({ activeId: 'acc_1' })
  store.saveSettings({ ...store.loadSettings(), autoswapEnabled: opts.autoswap ?? false, notify: false })
  // Claude Code's own config so the switcher has an identity file to update.
  writeFileSync(
    join(process.env.CLAUDE_CONFIG_DIR as string, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com', organizationUuid: 'org-acc_1' }, other: 1 }),
  )

  const h: Harness = {
    store,
    daemon: undefined as unknown as Daemon,
    live: { value: cred1 },
    writes: [],
    fable: new Map([
      ['tok-1', 30],
      ['tok-2', 20],
      ['tok-fresh', 20],
    ]),
    refreshes: 0,
    clock: { now: new Date('2026-06-01T12:00:00Z') },
    codexCalls: 0,
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (url.includes('/api/oauth/usage')) {
      const pct = h.fable.get(token)
      if (pct === undefined) return json({ error: 'unauthorized' }, 401)
      return json(usageBody(pct))
    }
    if (url.includes('/v1/oauth/token')) {
      h.refreshes += 1
      return json({ access_token: 'tok-fresh', refresh_token: 'ref-fresh', expires_in: 3600, token_type: 'Bearer' })
    }
    return json({ error: `unexpected ${url}` }, 500)
  }

  h.daemon = new Daemon({
    store,
    version: 'test',
    deps: {
      fetchFn,
      readActive: async () => h.live.value,
      writeActive: async (v) => {
        h.writes.push(v)
        h.live.value = v
      },
      codexSnapshot: async () => {
        h.codexCalls += 1
        return CODEX
      },
      openUrl: () => undefined,
      notify: () => undefined,
      now: () => h.clock.now,
    },
  })
  return h
}

// paths.ts reads these lazily on every call, so setting them per test is enough
// for the store, the lock directories and ~/.claude.json to land in the temp dir.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swapper-daemon-'))
  process.env.CLAUDE_SWAPPER_HOME = join(dir, 'data')
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('polling', () => {
  it('stores normalized usage for every enabled account and the Codex snapshot', async () => {
    const h = harness()
    const state = await h.daemon.refresh()
    const usage = h.store.loadUsage()
    expect(usage.acc_1?.ok).toBe(true)
    expect(usage.acc_1?.windows.find((w) => w.key === 'model:fable')?.pct).toBe(30)
    expect(usage.acc_2?.windows.find((w) => w.key === 'model:fable')?.pct).toBe(20)
    expect(state.accounts.map((a) => a.id)).toEqual(['acc_1', 'acc_2'])
    expect(state.accounts[0]?.active).toBe(true)
    expect(state.accounts[0]?.headroom).toBe(70)
    expect(state.accounts[0]?.bindingWindow).toBe('model:fable')
    expect(state.codex.mode).toBe('chatgpt')
    expect(state.polling.lastPollAt).not.toBeNull()
    expect(h.codexCalls).toBe(1)
  })

  it('skips disabled accounts and keeps stale windows when a fetch fails', async () => {
    const h = harness()
    h.store.upsertAccount({ ...(h.store.getAccount('acc_2') as StoredAccount), disabled: true })
    await h.daemon.refresh()
    expect(h.store.loadUsage().acc_2).toBeUndefined()

    h.fable.delete('tok-1') // server now answers 401 for the active account
    await h.daemon.refresh()
    const usage = h.store.loadUsage().acc_1
    expect(usage?.ok).toBe(false)
    expect(usage?.windows.length).toBeGreaterThan(0)
    expect(h.store.getAccount('acc_1')?.tokenStatus).toBe('expired')
  })

  it('refreshes an inactive expired token and persists the rotated credential', async () => {
    const h = harness({ cred2: credential('tok-old', 'ref-old', PAST) })
    await h.daemon.refresh()
    expect(h.refreshes).toBe(1)
    const stored = JSON.parse(h.store.readCredential('acc_2') as string)
    expect(stored.claudeAiOauth.accessToken).toBe('tok-fresh')
    expect(h.store.getAccount('acc_2')?.tokenStatus).toBe('ok')
    expect(h.store.loadUsage().acc_2?.ok).toBe(true)
  })

  it('never refreshes the active account token', async () => {
    const h = harness()
    const expiredActive = credential('tok-1', 'ref-1', PAST)
    h.store.writeCredential('acc_1', expiredActive)
    h.store.upsertAccount({ ...(h.store.getAccount('acc_1') as StoredAccount), fingerprint: credentialFingerprint(expiredActive) })
    h.live.value = expiredActive
    await h.daemon.refresh()
    expect(h.refreshes).toBe(0)
    expect(h.store.loadUsage().acc_1?.ok).toBe(true)
  })

  it('honours codexEnabled=false without calling the snapshot', async () => {
    const h = harness()
    h.daemon.updateSettings({ codexEnabled: false })
    const state = await h.daemon.refresh()
    expect(state.codex).toEqual({ configured: false, mode: 'none', email: null, plan: null, usage: null })
    expect(h.codexCalls).toBe(0)
  })
})

describe('autoswap', () => {
  it('does not switch when disabled, even over threshold', async () => {
    const h = harness({ autoswap: false })
    h.fable.set('tok-1', 95)
    const state = await h.daemon.refresh()
    expect(h.writes).toEqual([])
    expect(state.activeId).toBe('acc_1')
    expect(state.autoswap.lastDecision).toBeNull()
  })

  it('switches to the account with the most headroom when over threshold', async () => {
    const h = harness({ autoswap: true })
    h.fable.set('tok-1', 95)
    const state = await h.daemon.refresh()
    expect(h.writes).toEqual([h.store.readCredential('acc_2')])
    expect(state.activeId).toBe('acc_2')
    expect(state.autoswap.lastDecision?.action).toBe('switch')
    expect(state.autoswap.lastDecision?.targetId).toBe('acc_2')
    expect(state.autoswap.lastSwitchAt).toBe('2026-06-01T12:00:00Z')
    expect(state.events.some((e) => e.kind === 'autoswap' && e.message.includes('auto-switched to personal@example.com'))).toBe(true)
    // ~/.claude.json identity follows the switch and unrelated keys survive.
    const cfg = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR as string, '.claude.json'), 'utf8'))
    expect(cfg.oauthAccount.emailAddress).toBe('personal@example.com')
    expect(cfg.other).toBe(1)
  })

  it('raises the compact-nudge flag past the warn line and clears it after the swap', async () => {
    const h = harness({ autoswap: true })
    h.store.saveSettings({ ...h.store.loadSettings(), warnPct: 80, threshold: 90 })
    h.fable.set('tok-1', 84)
    let state = await h.daemon.refresh()
    expect(state.activeId).toBe('acc_1')
    expect(state.nudge.pending?.accountId).toBe('acc_1')
    expect(state.nudge.pending?.pct).toBe(84)
    expect(state.nudge.pending?.message).toContain('will be swapped at 90%')
    const flagText = readFileSync(join(process.env.CLAUDE_SWAPPER_HOME as string, 'swap-pending.txt'), 'utf8')
    expect(flagText.split('\n')[1]).toBe('block')
    expect(state.events.filter((e) => e.message.startsWith('Compact nudge raised')).length).toBe(1)
    // Same episode on the next poll: no duplicate event.
    h.clock.now = new Date('2026-06-01T12:05:00Z')
    state = await h.daemon.refresh()
    expect(state.events.filter((e) => e.message.startsWith('Compact nudge raised')).length).toBe(1)
    // Over threshold: the swap fires and the flag clears with the new active account below the line.
    h.fable.set('tok-1', 95)
    h.clock.now = new Date('2026-06-01T12:10:00Z')
    state = await h.daemon.refresh()
    expect(state.activeId).toBe('acc_2')
    expect(state.nudge.pending).toBeNull()
    expect(existsSync(join(process.env.CLAUDE_SWAPPER_HOME as string, 'swap-pending.txt'))).toBe(false)
  })

  it('never raises the flag in dry run or with auto-swap off', async () => {
    const h = harness({ autoswap: true })
    h.store.saveSettings({ ...h.store.loadSettings(), dryRun: true })
    h.fable.set('tok-1', 85)
    expect((await h.daemon.refresh()).nudge.pending).toBeNull()
    h.store.saveSettings({ ...h.store.loadSettings(), dryRun: false, autoswapEnabled: false })
    expect((await h.daemon.refresh()).nudge.pending).toBeNull()
  })

  it('honours the cooldown after a switch', async () => {
    const h = harness({ autoswap: true })
    h.fable.set('tok-1', 95)
    await h.daemon.refresh()
    expect(h.writes).toHaveLength(1)

    // Now the new active account is also over threshold while the old one has recovered.
    h.fable.set('tok-2', 96)
    h.fable.set('tok-1', 5)
    h.clock.now = new Date('2026-06-01T12:01:00Z') // 60 s later, cooldown is 300 s
    let state = await h.daemon.refresh()
    expect(h.writes).toHaveLength(1)
    expect(state.autoswap.lastDecision?.action).toBe('stay')
    expect(state.autoswap.lastDecision?.reason).toMatch(/cooldown/i)

    h.clock.now = new Date('2026-06-01T12:06:00Z') // past the cooldown
    state = await h.daemon.refresh()
    expect(h.writes).toHaveLength(2)
    expect(state.activeId).toBe('acc_1')
  })

  it('turns a switch into a stay under dry run', async () => {
    const h = harness({ autoswap: true })
    h.daemon.updateSettings({ dryRun: true })
    h.fable.set('tok-1', 95)
    const state = await h.daemon.refresh()
    expect(h.writes).toEqual([])
    expect(state.autoswap.lastDecision?.action).toBe('stay')
    expect(state.autoswap.lastDecision?.reason).toMatch(/^dry-run:/)
  })
})

describe('account actions', () => {
  it('refuses to remove the active account and removes others with their credential', () => {
    const h = harness()
    expect(() => h.daemon.removeAccount('acc_1')).toThrow(/active/)
    const state = h.daemon.removeAccount('acc_2')
    expect(state.accounts.map((a) => a.id)).toEqual(['acc_1'])
    expect(h.store.readCredential('acc_2')).toBeNull()
    expect(() => h.daemon.removeAccount('acc_2')).toThrow(/unknown account/)
  })

  it('manual switch writes the target credential and updates state', async () => {
    const h = harness()
    const state = await h.daemon.switchTo('acc_2')
    expect(h.writes).toEqual([h.store.readCredential('acc_2')])
    expect(state.activeId).toBe('acc_2')
    await expect(h.daemon.switchTo('acc_9')).rejects.toThrow(/unknown account/)
  })

  it('disable, alias, and state pushes', () => {
    const h = harness()
    const pushes: string[] = []
    h.daemon.on('state', (s) => pushes.push(s.now))
    let state = h.daemon.setDisabled('acc_2', true)
    expect(state.accounts.find((a) => a.id === 'acc_2')?.disabled).toBe(true)
    state = h.daemon.setAlias('acc_2', '  side ')
    expect(state.accounts.find((a) => a.id === 'acc_2')?.alias).toBe('side')
    expect(pushes).toHaveLength(2)
  })
})

describe('regressions', () => {
  it('a state listener that throws does not break refresh or the next poll', async () => {
    const h = harness()
    h.daemon.on('state', () => {
      throw new Error('tray exploded')
    })
    await expect(h.daemon.refresh()).resolves.toBeDefined()
    expect(h.store.loadUsage().acc_1?.ok).toBe(true)
    h.clock.now = new Date('2026-06-01T12:05:00Z')
    await expect(h.daemon.refresh()).resolves.toBeDefined()
    expect(h.store.readEvents().some((e) => e.kind === 'error' && e.message.includes('tray exploded'))).toBe(true)
  })

  it('does not overwrite an alias edited while its usage fetch was in flight', async () => {
    const h = harness()
    // While acc_2's usage fetch is in flight the user renames and disables it (via IPC, same store).
    let edited = false
    const slowFetch: typeof fetch = async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      if (auth.endsWith('tok-2') && !edited) {
        edited = true
        h.daemon.setAlias('acc_2', 'renamed')
        h.daemon.setDisabled('acc_2', true)
      }
      return json(usageBody(20))
    }
    const daemon = new Daemon({
      store: h.store,
      version: 'test',
      deps: { fetchFn: slowFetch, readActive: async () => h.live.value, writeActive: async () => undefined, codexSnapshot: async () => CODEX, now: () => h.clock.now },
    })
    await daemon.refresh()
    const acc2 = h.store.getAccount('acc_2')
    expect(acc2?.alias).toBe('renamed')
    expect(acc2?.disabled).toBe(true)
    expect(acc2?.tokenStatus).toBe('ok')
  })

  it('does not resurrect an account removed while its usage fetch was in flight', async () => {
    const h = harness()
    let removed = false
    const fetchFn: typeof fetch = async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      if (auth.endsWith('tok-2') && !removed) {
        removed = true
        daemon.removeAccount('acc_2')
      }
      return json(usageBody(20))
    }
    const daemon = new Daemon({
      store: h.store,
      version: 'test',
      deps: { fetchFn, readActive: async () => h.live.value, writeActive: async () => undefined, codexSnapshot: async () => CODEX, now: () => h.clock.now },
    })
    await daemon.refresh()
    expect(h.store.getAccount('acc_2')).toBeNull()
    expect(h.store.loadUsage().acc_2).toBeUndefined()
  })

  it('never copies a foreign Claude Code login over a stored account', async () => {
    const h = harness()
    const stranger = credential('tok-stranger', 'ref-stranger')
    h.live.value = stranger
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR as string, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'stranger@example.com', organizationUuid: 'org-x' } }),
    )
    const state = await h.daemon.refresh()
    expect(h.store.readCredential('acc_1')).toBe(credential('tok-1', 'ref-1'))
    expect(h.store.getAccount('acc_1')?.fingerprint).toBe(credentialFingerprint(credential('tok-1', 'ref-1')))
    expect(state.activeId).toBeNull()
    expect(state.events.filter((e) => e.message.includes('does not track'))).toHaveLength(1)
    // ...and the message is only logged once, not on every poll.
    h.clock.now = new Date('2026-06-01T12:05:00Z')
    await h.daemon.refresh()
    expect(h.store.readEvents().filter((e) => e.message.includes('does not track'))).toHaveLength(1)
  })

  it('still adopts a rotated token for the active account (email confirmed by ~/.claude.json)', async () => {
    const h = harness()
    const rotated = credential('tok-1b', 'ref-1-rotated')
    h.fable.set('tok-1b', 30)
    h.live.value = rotated
    await h.daemon.refresh()
    expect(h.store.readCredential('acc_1')).toBe(rotated)
    expect(h.store.loadState().activeId).toBe('acc_1')
  })

  it('rotates an inactive token the server rejected with 401 even though expiresAt looks valid', async () => {
    const h = harness()
    h.fable.delete('tok-2')
    await h.daemon.refresh()
    expect(h.store.getAccount('acc_2')?.tokenStatus).toBe('expired')
    expect(h.refreshes).toBe(0)
    h.clock.now = new Date('2026-06-01T12:05:00Z')
    await h.daemon.refresh()
    expect(h.refreshes).toBe(1)
    expect(h.store.getAccount('acc_2')?.tokenStatus).toBe('ok')
    expect(JSON.parse(h.store.readCredential('acc_2') as string).claudeAiOauth.accessToken).toBe('tok-fresh')
  })

  it('backs off Codex after a failed snapshot instead of retrying every poll', async () => {
    const h = harness()
    const failing: CodexState = { ...CODEX, usage: { fetchedAt: 'x', ok: false, error: 'codex refresh failed: HTTP 400', windows: [], plan: null } }
    let calls = 0
    const daemon = new Daemon({
      store: h.store,
      version: 'test',
      deps: {
        fetchFn: async () => json(usageBody(10)),
        readActive: async () => h.live.value,
        writeActive: async () => undefined,
        codexSnapshot: async () => {
          calls += 1
          return failing
        },
        now: () => h.clock.now,
      },
    })
    await daemon.refresh(false)
    expect(calls).toBe(1)
    h.clock.now = new Date('2026-06-01T12:02:00Z')
    await daemon.refresh(false)
    expect(calls).toBe(1) // held off
    await daemon.refresh(true)
    expect(calls).toBe(2) // a manual refresh always retries
    h.clock.now = new Date('2026-06-01T12:10:00Z')
    await daemon.refresh(false)
    expect(calls).toBe(3)
  })

  it('caps the poll interval so the timer cannot overflow and spin', () => {
    const h = harness()
    expect(() => h.daemon.updateSettings({ pollIntervalSeconds: 3_000_000 })).toThrow(/pollIntervalSeconds/)
    expect(h.daemon.updateSettings({ pollIntervalSeconds: 86_400 }).settings.pollIntervalSeconds).toBe(86_400)
  })

  it('starting a second login cancels the first so the callback port is free', () => {
    const h = harness()
    const first = h.daemon.startLogin()
    const second = h.daemon.startLogin()
    expect(h.daemon.loginStatus(first.id)).toMatchObject({ status: 'error', error: 'login cancelled' })
    expect(h.daemon.loginStatus(second.id).status).toBe('pending')
    h.daemon.cancelLogin(second.id)
  })

  it('rejects an oversized alias', () => {
    const h = harness()
    expect(() => h.daemon.setAlias('acc_2', 'x'.repeat(65))).toThrow(/alias/)
    expect(h.daemon.setAlias('acc_2', 'x'.repeat(64)).accounts.find((a) => a.id === 'acc_2')?.alias).toHaveLength(64)
  })
})

describe('settings', () => {
  it('validates ranges and rejects unknown keys', () => {
    const h = harness()
    const state = h.daemon.updateSettings({ threshold: 85, margin: 5, strategy: 'consume_first', pollIntervalSeconds: 30 })
    expect(state.settings.threshold).toBe(85)
    expect(h.store.loadSettings().strategy).toBe('consume_first')
    expect(() => h.daemon.updateSettings({ threshold: 40 })).toThrow(/threshold/)
    expect(() => h.daemon.updateSettings({ threshold: 101 })).toThrow(/threshold/)
    expect(() => h.daemon.updateSettings({ margin: 60 })).toThrow(/margin/)
    expect(() => h.daemon.updateSettings({ cooldownSeconds: -1 })).toThrow(/cooldownSeconds/)
    expect(() => h.daemon.updateSettings({ pollIntervalSeconds: 5 })).toThrow(/pollIntervalSeconds/)
    expect(() => h.daemon.updateSettings({ model: '  ' })).toThrow(/model/)
    expect(() => h.daemon.updateSettings({ strategy: 'random' as 'best' })).toThrow(/strategy/)
    expect(() => h.daemon.updateSettings({ autoswapEnabled: 'yes' as unknown as boolean })).toThrow(/autoswapEnabled/)
    expect(() => h.daemon.updateSettings({ bogus: 1 } as Partial<import('../shared/types').Settings>)).toThrow(/unknown setting/)
    // Nothing from the failed patches leaked into the store.
    expect(h.store.loadSettings().threshold).toBe(85)
  })
})
