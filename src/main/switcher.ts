/**
 * Capture the active Claude Code login, add accounts, and perform a switch.
 *
 * A switch is a credential swap under Claude Code's own locks plus an identity
 * update in `~/.claude.json`. Before overwriting the live credential we save it
 * back into the account it belongs to, because Claude Code may have rotated the
 * token since we last stored it and a stale refresh token is a dead account.
 */
import { existsSync, readFileSync } from 'node:fs'

import { withConfigLock as realConfigLock, withCredentialsLock as realCredentialsLock } from './claudeLocks'
import {
  credentialFingerprint,
  extractAccessToken,
  extractPlan,
  fetchProfile as realFetchProfile,
  identityFromProfile,
  type FetchFn,
  type Identity,
} from './claudeOauth'
import { readActiveCredential, writeActiveCredential } from './keychain'
import { claudeGlobalConfig } from './paths'
import { atomicWrite, type Store, type StoredAccount, utcNowIso } from './store'

export type { Identity } from './claudeOauth'

export class CaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureError'
  }
}

export class SwitchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwitchError'
  }
}

export interface SwitcherDeps {
  readActive: () => Promise<string | null>
  writeActive: (value: string) => Promise<void>
  withCredentialsLock: <T>(fn: () => Promise<T>) => Promise<T>
  withConfigLock: <T>(fn: () => Promise<T>) => Promise<T>
  now: () => Date
  /** Profile lookup for credentials whose identity is not on file (fresh logins). */
  fetchFn: FetchFn
}

const DEFAULT_DEPS: SwitcherDeps = {
  readActive: () => readActiveCredential(),
  writeActive: (value) => writeActiveCredential(value),
  withCredentialsLock: (fn) => realCredentialsLock(fn),
  withConfigLock: (fn) => realConfigLock(fn),
  now: () => new Date(),
  fetchFn: (...args) => fetch(...args),
}

function resolveDeps(deps: Partial<SwitcherDeps>): SwitcherDeps {
  return { ...DEFAULT_DEPS, ...deps }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readGlobalConfig(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(claudeGlobalConfig(), 'utf8'))
    return isRecord(data) ? data : {}
  } catch {
    return {}
  }
}

/**
 * Like `readGlobalConfig` but for a read-modify-write: a file that exists yet
 * cannot be read or parsed is an error, never an empty object, because writing
 * `{oauthAccount}` back would erase every other Claude Code setting the user has.
 */
function readGlobalConfigForWrite(): Record<string, unknown> {
  const path = claudeGlobalConfig()
  if (!existsSync(path)) return {}
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new SwitchError(`refusing to overwrite unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(data)) throw new SwitchError(`refusing to overwrite ${path}: top level is not an object`)
  return data
}

/** `oauthAccount` of `~/.claude.json` → our identity (empty strings when missing). */
export function identityFromGlobalConfig(config: Record<string, unknown>): Identity {
  const oa = isRecord(config.oauthAccount) ? config.oauthAccount : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    email: str(oa.emailAddress),
    orgUuid: str(oa.organizationUuid),
    orgName: str(oa.organizationName),
    accountUuid: str(oa.accountUuid),
  }
}

/** The live credential and identity, or `CaptureError` when nobody is logged in. */
export async function captureActive(deps: Partial<SwitcherDeps> = {}): Promise<{ credential: string; identity: Identity }> {
  const d = resolveDeps(deps)
  const credential = await d.readActive()
  if (!credential || !extractAccessToken(credential)) {
    throw new CaptureError("Claude Code isn't logged in; run `claude` and sign in first")
  }
  return { credential, identity: identityFromGlobalConfig(readGlobalConfig()) }
}

/** Same lineage, or the same person in the same org (re-login rotates the lineage). */
function findMatch(store: Store, fingerprint: string, identity: Partial<Identity>): StoredAccount | null {
  const accounts = store.listAccounts()
  const byLineage = accounts.find((a) => a.fingerprint && a.fingerprint === fingerprint)
  if (byLineage) return byLineage
  const email = identity.email ?? ''
  const org = identity.orgUuid ?? ''
  if (email && org) {
    return accounts.find((a) => a.email.toLowerCase() === email.toLowerCase() && a.orgUuid === org) ?? null
  }
  return null
}

/**
 * Upsert an account for `credential`.
 *
 * A credential whose lineage we already track needs no network: its identity
 * is on file. Only an unknown credential without a caller-supplied identity (a
 * fresh PKCE login) is resolved through the profile API. The account is *not*
 * marked active; `addFromActive` does that when the credential is the live one.
 */
export async function addFromCredential(
  store: Store,
  credential: string,
  identity: Partial<Identity> | null = null,
  deps: Partial<SwitcherDeps> = {},
): Promise<StoredAccount> {
  const d = resolveDeps(deps)
  const fingerprint = credentialFingerprint(credential)
  let ident: Partial<Identity> = identity ?? {}
  let account = findMatch(store, fingerprint, ident)
  if (account === null && !ident.email) {
    const token = extractAccessToken(credential)
    if (!token) throw new CaptureError('credential has no access token')
    try {
      ident = identityFromProfile(await realFetchProfile(token, d.fetchFn))
    } catch (err) {
      throw new CaptureError(`could not resolve account identity: ${err instanceof Error ? err.message : String(err)}`)
    }
    account = findMatch(store, fingerprint, ident)
  }
  const next: StoredAccount = account ?? {
    id: store.nextAccountId(),
    email: '',
    alias: '',
    orgName: '',
    orgUuid: '',
    accountUuid: '',
    plan: null,
    disabled: false,
    addedAt: '',
    fingerprint: '',
    tokenStatus: 'ok',
  }
  if (ident.email) next.email = ident.email
  if (ident.orgUuid) next.orgUuid = ident.orgUuid
  if (ident.orgName) next.orgName = ident.orgName
  if (ident.accountUuid) next.accountUuid = ident.accountUuid
  next.fingerprint = fingerprint
  next.tokenStatus = 'ok'
  next.plan = extractPlan(credential) ?? next.plan
  const stored = store.upsertAccount(next)
  store.writeCredential(stored.id, credential)
  return stored
}

/** Capture whoever is logged into Claude Code right now and mark them active. */
export async function addFromActive(store: Store, deps: Partial<SwitcherDeps> = {}): Promise<StoredAccount> {
  const { credential, identity } = await captureActive(deps)
  const account = await addFromCredential(store, credential, identity, deps)
  store.saveState({ activeId: account.id })
  store.appendEvent('capture', `captured active login ${account.email}`, account.id)
  return account
}

/**
 * Which stored account does the live credential belong to?
 *
 * Fingerprint first; when Claude Code rotated the refresh token we fall back to
 * `state.activeId` but only if `~/.claude.json` still names that account's
 * email, so a manual re-login as someone else never overwrites a slot.
 */
export function ownerOfLive(store: Store, live: string): StoredAccount | null {
  const fp = credentialFingerprint(live)
  const byLineage = store.listAccounts().find((a) => a.fingerprint === fp)
  if (byLineage) return byLineage
  const activeId = store.loadState().activeId
  const account = activeId ? store.getAccount(activeId) : null
  if (!account) return null
  const liveEmail = identityFromGlobalConfig(readGlobalConfig()).email
  return liveEmail.toLowerCase() === account.email.toLowerCase() ? account : null
}

/** The account whose credential Claude Code is using, by fingerprint, else `state.activeId`. */
export async function activeAccount(store: Store, deps: Partial<SwitcherDeps> = {}): Promise<StoredAccount | null> {
  const d = resolveDeps(deps)
  let live: string | null = null
  try {
    live = await d.readActive()
  } catch {
    live = null
  }
  if (live) {
    const fp = credentialFingerprint(live)
    const match = store.listAccounts().find((a) => a.fingerprint === fp)
    if (match) return match
  }
  const activeId = store.loadState().activeId
  return activeId ? store.getAccount(activeId) : null
}

/** Update only the `oauthAccount` keys we own; every other key survives verbatim. */
function writeIdentity(account: StoredAccount): void {
  const config = readGlobalConfigForWrite()
  const oa = isRecord(config.oauthAccount) ? { ...config.oauthAccount } : {}
  oa.accountUuid = account.accountUuid
  oa.emailAddress = account.email
  oa.organizationUuid = account.orgUuid
  oa.organizationName = account.orgName
  config.oauthAccount = oa
  atomicWrite(claudeGlobalConfig(), JSON.stringify(config, null, 2), 0o600)
}

/** Install `accountId`'s credential as Claude Code's active login. */
export async function switchTo(store: Store, accountId: string, deps: Partial<SwitcherDeps> = {}): Promise<StoredAccount> {
  const d = resolveDeps(deps)
  const target = store.getAccount(accountId)
  if (!target) throw new SwitchError(`unknown account ${accountId}`)
  let cred = store.readCredential(target.id)
  if (!cred) throw new SwitchError(`${target.email || target.id} has no stored credential; log in again`)

  const current = await d.withCredentialsLock(async (): Promise<StoredAccount | null> => {
    const live = await d.readActive()
    let owner = live ? ownerOfLive(store, live) : null
    if (owner && live) {
      store.writeCredential(owner.id, live)
      owner = store.upsertAccount({ ...owner, fingerprint: credentialFingerprint(live) })
      if (owner.id === target.id) cred = live // already active: keep the freshest generation
    }
    await d.writeActive(cred as string)
    try {
      await d.withConfigLock(async () => writeIdentity(target))
    } catch (err) {
      // Leave Claude Code exactly as we found it rather than half-switched.
      if (live) {
        try {
          await d.writeActive(live)
        } catch {
          // best effort; the original error is the one worth reporting
        }
      }
      throw new SwitchError(`could not update ~/.claude.json: ${err instanceof Error ? err.message : String(err)}`)
    }
    return owner
  })

  store.saveState({ activeId: target.id, lastSwitchAt: utcNowIso(d.now()) })
  const origin = current && current.id !== target.id ? ` from ${current.email}` : ''
  store.appendEvent('switch', `switched to ${target.email}${origin}`, target.id)
  return target
}
