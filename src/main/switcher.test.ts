import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { credentialFingerprint, type FetchFn } from './claudeOauth'
import { claudeGlobalConfig } from './paths'
import { Store } from './store'
import {
  CaptureError,
  SwitchError,
  activeAccount,
  addFromActive,
  addFromCredential,
  captureActive,
  switchTo,
  type Identity,
  type SwitcherDeps,
} from './switcher'

const ALICE: Identity = { email: 'alice@example.com', orgUuid: 'org-a', orgName: 'Org A', accountUuid: 'u-a' }
const BOB: Identity = { email: 'bob@example.com', orgUuid: 'org-b', orgName: 'Org B', accountUuid: 'u-b' }

function makeCred(opts: { access?: string; refresh?: string | null; plan?: string } = {}): string {
  const { access = 'access-1', refresh = 'refresh-1', plan = 'max' } = opts
  const block: Record<string, unknown> = { accessToken: access, expiresAt: 4_102_444_800_000, subscriptionType: plan }
  if (refresh !== null) block.refreshToken = refresh
  return JSON.stringify({ claudeAiOauth: block })
}

/** A fake Keychain: `live.value` is the active credential (null = logged out). */
interface Live {
  value: string | null
  writes: string[]
  failWrites: boolean
}

let home: string
let store: Store
let live: Live
let deps: Partial<SwitcherDeps>
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'swapper-switcher-'))
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'SESSION_MANAGER_HOME']) savedEnv[k] = process.env[k]
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  process.env.SESSION_MANAGER_HOME = join(home, 'swapper')
  store = new Store(join(home, 'swapper'))
  live = { value: null, writes: [], failWrites: false }
  deps = {
    readActive: async () => live.value,
    writeActive: async (value) => {
      if (live.failWrites) throw new Error('keychain locked')
      live.value = value
      live.writes.push(value)
    },
    withCredentialsLock: (fn) => fn(),
    withConfigLock: (fn) => fn(),
    now: () => new Date('2026-09-04T18:00:00Z'),
    fetchFn: async () => {
      throw new Error('no network expected')
    },
  }
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

function writeGlobalConfig(identity: Identity, extra: Record<string, unknown> = {}): string {
  const path = claudeGlobalConfig()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      oauthAccount: {
        accountUuid: identity.accountUuid,
        emailAddress: identity.email,
        organizationUuid: identity.orgUuid,
        organizationName: identity.orgName,
        displayName: 'Someone',
      },
      ...extra,
    }),
  )
  return path
}

/** acc_1 = Alice (active, captured from the live login), acc_2 = Bob (stored only). */
async function twoAccounts(): Promise<void> {
  live.value = makeCred({ access: 'a1', refresh: 'ra' })
  writeGlobalConfig(ALICE, { foo: 'bar', projects: { '/x': { allowedTools: [] } } })
  await addFromActive(store, deps)
  await addFromCredential(store, makeCred({ access: 'b1', refresh: 'rb', plan: 'pro' }), BOB, deps)
  live.writes = []
}

describe('captureActive / addFromActive', () => {
  it('requires a login with an access token', async () => {
    await expect(captureActive(deps)).rejects.toBeInstanceOf(CaptureError)
    live.value = '{"claudeAiOauth": {}}'
    await expect(captureActive(deps)).rejects.toBeInstanceOf(CaptureError)
    live.value = makeCred()
    writeGlobalConfig(ALICE)
    const { credential, identity } = await captureActive(deps)
    expect(credential).toBe(live.value)
    expect(identity).toEqual(ALICE)
  })

  it('marks the captured account active and records an event', async () => {
    await twoAccounts()
    const [alice, bob] = store.listAccounts()
    expect(alice!.id).toBe('acc_1')
    expect(bob!.id).toBe('acc_2')
    expect(alice!.email).toBe(ALICE.email)
    expect(alice!.plan).toBe('max')
    expect(bob!.plan).toBe('pro')
    expect(alice!.fingerprint).toBe(credentialFingerprint(store.readCredential('acc_1')!))
    expect(store.loadState().activeId).toBe('acc_1')
    expect(store.readEvents()[0]!.kind).toBe('capture')
    expect((await activeAccount(store, deps))!.id).toBe('acc_1')
  })
})

describe('addFromCredential', () => {
  it('dedupes by lineage, then by email + org', async () => {
    await twoAccounts()
    const sameLineage = await addFromCredential(store, makeCred({ access: 'a2', refresh: 'ra' }), null, deps)
    expect(sameLineage.id).toBe('acc_1')
    expect(sameLineage.email).toBe(ALICE.email) // identity kept from the existing record
    expect(store.readCredential('acc_1')).toBe(makeCred({ access: 'a2', refresh: 'ra' }))
    const relogin = await addFromCredential(store, makeCred({ access: 'a3', refresh: 'ra-new' }), ALICE, deps)
    expect(relogin.id).toBe('acc_1') // same email + org → same slot, rotated lineage
    expect(store.getAccount('acc_1')!.fingerprint).toBe(credentialFingerprint(makeCred({ refresh: 'ra-new' })))
    expect(store.listAccounts()).toHaveLength(2)
    expect(store.loadState().activeId).toBe('acc_1') // never changed by addFromCredential
  })

  it('resolves an unknown credential through the profile API', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ account: { uuid: 'u-c', email: 'carol@example.com' }, organization: { uuid: 'org-c', name: 'Org C' } }), { status: 200 })
    const carol = await addFromCredential(store, makeCred({ refresh: 'rc' }), null, { ...deps, fetchFn })
    expect(carol.email).toBe('carol@example.com')
    expect(carol.orgName).toBe('Org C')
    expect(store.loadState().activeId).toBeNull()
    const offline: FetchFn = async () => {
      throw new Error('offline')
    }
    await expect(addFromCredential(store, makeCred({ refresh: 'rd' }), null, { ...deps, fetchFn: offline })).rejects.toBeInstanceOf(CaptureError)
  })
})

describe('switchTo', () => {
  it('saves the rotated live credential back, installs the target and updates the identity', async () => {
    await twoAccounts()
    const rotated = makeCred({ access: 'a1-rotated', refresh: 'ra' }) // Claude Code refreshed Alice
    live.value = rotated

    const target = await switchTo(store, 'acc_2', deps)

    expect(target.id).toBe('acc_2')
    expect(store.readCredential('acc_1')).toBe(rotated) // old account's slot got the fresh token
    expect(live.value).toBe(makeCred({ access: 'b1', refresh: 'rb', plan: 'pro' }))
    expect(live.writes).toHaveLength(1)
    const config = JSON.parse(readFileSync(claudeGlobalConfig(), 'utf8'))
    expect(config.oauthAccount.emailAddress).toBe(BOB.email)
    expect(config.oauthAccount.accountUuid).toBe(BOB.accountUuid)
    expect(config.oauthAccount.organizationUuid).toBe(BOB.orgUuid)
    expect(config.oauthAccount.organizationName).toBe(BOB.orgName)
    expect(config.oauthAccount.displayName).toBe('Someone') // untouched key inside the block
    expect(config.foo).toBe('bar')
    expect(config.projects).toEqual({ '/x': { allowedTools: [] } })
    const state = store.loadState()
    expect(state.activeId).toBe('acc_2')
    expect(state.lastSwitchAt).toBe('2026-09-04T18:00:00Z')
    const event = store.readEvents()[0]!
    expect(event.kind).toBe('switch')
    expect(event.accountId).toBe('acc_2')
    expect(event.message).toContain('bob@example.com')
    expect(event.message).toContain('alice@example.com')
    expect((await activeAccount(store, deps))!.id).toBe('acc_2')
  })

  it('saves back even when the refresh token rotated (matched via state + email)', async () => {
    await twoAccounts()
    const rotated = makeCred({ access: 'a9', refresh: 'ra-rotated' })
    live.value = rotated
    await switchTo(store, 'acc_2', deps)
    expect(store.readCredential('acc_1')).toBe(rotated)
    expect(store.getAccount('acc_1')!.fingerprint).toBe(credentialFingerprint(rotated))
  })

  it('never overwrites a slot with a foreign login', async () => {
    await twoAccounts()
    live.value = makeCred({ access: 's1', refresh: 'rs' })
    writeGlobalConfig({ ...ALICE, email: 'stranger@example.com' })
    await switchTo(store, 'acc_2', deps)
    expect(store.readCredential('acc_1')).toBe(makeCred({ access: 'a1', refresh: 'ra' }))
    expect(live.value).toBe(makeCred({ access: 'b1', refresh: 'rb', plan: 'pro' }))
  })

  it('keeps the freshest generation when switching to the active account', async () => {
    await twoAccounts()
    const rotated = makeCred({ access: 'a1-rotated', refresh: 'ra' })
    live.value = rotated
    await switchTo(store, 'acc_1', deps)
    expect(live.value).toBe(rotated)
    expect(store.readCredential('acc_1')).toBe(rotated)
  })

  it('rejects unknown accounts and missing credentials', async () => {
    await twoAccounts()
    await expect(switchTo(store, 'acc_99', deps)).rejects.toBeInstanceOf(SwitchError)
    store.deleteCredential('acc_2')
    await expect(switchTo(store, 'acc_2', deps)).rejects.toBeInstanceOf(SwitchError)
    expect(live.writes).toHaveLength(0)
  })

  it('restores the previous credential when the config update fails', async () => {
    await twoAccounts()
    const before = live.value
    const failingConfigLock: SwitcherDeps['withConfigLock'] = async () => {
      throw new Error('config lock held')
    }
    await expect(switchTo(store, 'acc_2', { ...deps, withConfigLock: failingConfigLock })).rejects.toBeInstanceOf(SwitchError)
    expect(live.writes).toHaveLength(2) // target written, then the original put back
    expect(live.value).toBe(before)
    expect(store.loadState().activeId).toBe('acc_1')
    expect(JSON.parse(readFileSync(claudeGlobalConfig(), 'utf8')).oauthAccount.emailAddress).toBe(ALICE.email)
    expect(store.readEvents().some((e) => e.kind === 'switch')).toBe(false)
  })

  it('never clobbers an unparseable ~/.claude.json and restores the credential', async () => {
    await twoAccounts()
    const before = live.value
    writeFileSync(claudeGlobalConfig(), '{"oauthAccount": {"emailAddress": "alice@example.com"}, "projects": {' ) // torn write
    const torn = readFileSync(claudeGlobalConfig(), 'utf8')
    await expect(switchTo(store, 'acc_2', deps)).rejects.toThrow(/refusing to overwrite/)
    expect(readFileSync(claudeGlobalConfig(), 'utf8')).toBe(torn)
    expect(live.value).toBe(before)
    expect(store.loadState().activeId).toBe('acc_1')
  })

  it('creates ~/.claude.json when it does not exist yet', async () => {
    await twoAccounts()
    rmSync(claudeGlobalConfig())
    await switchTo(store, 'acc_2', deps)
    expect(JSON.parse(readFileSync(claudeGlobalConfig(), 'utf8')).oauthAccount.emailAddress).toBe(BOB.email)
  })

  it('runs the credential swap inside the locks', async () => {
    await twoAccounts()
    const order: string[] = []
    const locked: Partial<SwitcherDeps> = {
      ...deps,
      withCredentialsLock: async (fn) => {
        order.push('cred-lock')
        try {
          return await fn()
        } finally {
          order.push('cred-unlock')
        }
      },
      withConfigLock: async (fn) => {
        order.push('config-lock')
        try {
          return await fn()
        } finally {
          order.push('config-unlock')
        }
      },
      writeActive: async (value) => {
        order.push('write')
        live.value = value
      },
    }
    await switchTo(store, 'acc_2', locked)
    expect(order).toEqual(['cred-lock', 'write', 'config-lock', 'config-unlock', 'cred-unlock'])
  })
})

describe('activeAccount', () => {
  it('falls back to state.activeId when the Keychain is empty', async () => {
    await twoAccounts()
    live.value = null
    expect((await activeAccount(store, deps))!.id).toBe('acc_1')
    store.saveState({ activeId: null })
    expect(await activeAccount(store, deps)).toBeNull()
  })
})
