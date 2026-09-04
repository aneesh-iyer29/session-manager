import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '../shared/types'
import { Store, atomicWrite, normalizeSettings, type StoredAccount } from './store'

let root: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swapper-store-'))
  store = new Store(join(root, 'data'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const acct = (id: string, email: string, alias = ''): StoredAccount => ({
  id,
  email,
  alias,
  orgName: 'Org',
  orgUuid: 'org',
  accountUuid: `u-${id}`,
  plan: null,
  disabled: false,
  addedAt: '',
  fingerprint: '',
  tokenStatus: 'ok',
})

const tmpFiles = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'))

describe('Store', () => {
  it('creates a private data dir and credentials dir', () => {
    expect(statSync(store.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(store.dir, 'credentials')).mode & 0o777).toBe(0o700)
  })

  it('clamps an absurd poll interval from a hand-edited file', () => {
    expect(normalizeSettings({ pollIntervalSeconds: 3_000_000 }).pollIntervalSeconds).toBe(86_400)
    expect(normalizeSettings({ pollIntervalSeconds: 5 }).pollIntervalSeconds).toBe(15)
  })

  it('merges settings over defaults and clamps them', () => {
    expect(store.loadSettings()).toEqual(DEFAULT_SETTINGS)
    store.saveSettings({ ...DEFAULT_SETTINGS, threshold: 80 })
    expect(store.loadSettings().threshold).toBe(80)
    expect(store.loadSettings().margin).toBe(DEFAULT_SETTINGS.margin)
    expect(tmpFiles(store.dir)).toEqual([])

    writeFileSync(
      join(store.dir, 'settings.json'),
      JSON.stringify({ threshold: 5, margin: 99, cooldownSeconds: -4, pollIntervalSeconds: 1, model: '  ', strategy: 'bogus', notify: 'yes' }),
    )
    expect(store.loadSettings()).toEqual({ ...DEFAULT_SETTINGS, threshold: 50, margin: 50, cooldownSeconds: 0, pollIntervalSeconds: 15 })
    expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ strategy: 'consume_first', model: 'Opus' })).toMatchObject({ strategy: 'consume_first', model: 'Opus' })
  })

  it('writes credentials atomically with mode 0600', () => {
    store.writeCredential('acc_1', '{"claudeAiOauth": {}}')
    const path = join(store.dir, 'credentials', 'acc_1.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.readCredential('acc_1')).toBe('{"claudeAiOauth": {}}')
    expect(store.readCredential('acc_9')).toBeNull()
    expect(tmpFiles(join(store.dir, 'credentials'))).toEqual([])
    store.deleteCredential('acc_1')
    expect(store.readCredential('acc_1')).toBeNull()
    store.deleteCredential('acc_1') // idempotent
    expect(() => store.readCredential('../etc')).toThrow(/bad account id/)
  })

  it('atomicWrite leaves no temp file behind and honours the mode', () => {
    const path = join(root, 'nested', 'file.json')
    atomicWrite(path, 'hello', 0o600)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(tmpFiles(join(root, 'nested'))).toEqual([])
  })

  it('upserts, gets and finds accounts by id, alias and email', () => {
    const a = store.upsertAccount(acct('acc_1', 'Alice@Example.com', 'work'))
    store.upsertAccount(acct('acc_2', 'bob@example.com'))
    expect(a.addedAt).toBeTruthy()
    expect(store.getAccount('acc_2')!.email).toBe('bob@example.com')
    expect(store.getAccount('acc_3')).toBeNull()
    expect(store.findAccount('acc_1')!.id).toBe('acc_1')
    expect(store.findAccount('WORK')!.id).toBe('acc_1')
    expect(store.findAccount('alice@example.com')!.id).toBe('acc_1')
    expect(store.findAccount('nobody')).toBeNull()
    store.upsertAccount({ ...a, alias: 'personal' })
    expect(store.listAccounts().map((x) => x.id)).toEqual(['acc_1', 'acc_2'])
    expect(store.getAccount('acc_1')!.alias).toBe('personal')
    expect(store.getAccount('acc_1')!.addedAt).toBe(a.addedAt)
  })

  it('never recycles account ids', () => {
    expect(store.nextAccountId()).toBe('acc_1')
    store.upsertAccount(acct('acc_1', 'a@x'))
    store.upsertAccount(acct('acc_2', 'b@x'))
    expect(store.nextAccountId()).toBe('acc_3')
    store.appendEvent('switch', 'to b', 'acc_2')
    store.deleteAccount('acc_2')
    expect(store.getAccount('acc_2')).toBeNull()
    expect(store.nextAccountId()).toBe('acc_3') // acc_2 lives on in events
  })

  it('deleteAccount removes the credential and cached usage', () => {
    store.upsertAccount(acct('acc_1', 'a@x'))
    store.writeCredential('acc_1', 'secret')
    const usage = { fetchedAt: 'x', ok: true, error: null, windows: [], plan: null }
    store.saveUsage({ acc_1: usage, acc_2: { ...usage, ok: false } })
    store.deleteAccount('acc_1')
    expect(store.readCredential('acc_1')).toBeNull()
    expect(Object.keys(store.loadUsage())).toEqual(['acc_2'])
  })

  it('merges partial state updates', () => {
    expect(store.loadState()).toEqual({ activeId: null, lastSwitchAt: null, lastDecision: null })
    store.saveState({ activeId: 'acc_1' })
    store.saveState({ lastSwitchAt: '2026-09-04T18:00:00Z' })
    expect(store.loadState().activeId).toBe('acc_1')
    expect(store.loadState().lastSwitchAt).toBe('2026-09-04T18:00:00Z')
  })

  it('returns events newest first with a limit', () => {
    for (let i = 0; i < 5; i++) store.appendEvent('info', `msg ${i}`, i % 2 ? null : 'acc_1')
    const events = store.readEvents(3)
    expect(events.map((e) => e.message)).toEqual(['msg 4', 'msg 3', 'msg 2'])
    expect(events[0]!.kind).toBe('info')
    expect(events[0]!.accountId).toBe('acc_1')
    expect(events[0]!.at.endsWith('Z')).toBe(true)
    expect(events[0]!.id).toBeTruthy()
    expect(store.readEvents()).toHaveLength(5)
    expect(new Store(store.dir).readEvents(1)[0]!.message).toBe('msg 4')
  })

  it('treats corrupt files as empty', () => {
    writeFileSync(join(store.dir, 'accounts.json'), '{not json')
    writeFileSync(join(store.dir, 'events.jsonl'), 'garbage\n' + JSON.stringify({ kind: 'info' }) + '\n')
    expect(store.listAccounts()).toEqual([])
    expect(store.readEvents()).toEqual([{ kind: 'info' }])
  })
})
