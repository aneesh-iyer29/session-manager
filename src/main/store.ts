/**
 * JSON persistence under the app's data directory.
 *
 * Every write goes through a temp file + `rename` so a crash mid-write can
 * never leave a torn file; credential blobs are 0600 in a 0700 directory. All
 * I/O is synchronous on purpose: the store is tiny, and sync fs makes every
 * read-modify-write sequence atomic with respect to the single main thread.
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { Decision, EventKind, Settings, Strategy, SwapperEvent, TokenStatus, Usage } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

/** Metadata for one Claude account; the secret lives in `credentials/<id>.json`. */
export interface StoredAccount {
  id: string
  email: string
  alias: string
  orgName: string
  orgUuid: string
  accountUuid: string
  plan: string | null
  disabled: boolean
  addedAt: string
  fingerprint: string
  tokenStatus: TokenStatus
}

export interface StoredState {
  activeId: string | null
  lastSwitchAt: string | null
  lastDecision: Decision | null
}

/** One day; anything longer would overflow the daemon's 32-bit `setTimeout` and poll continuously. */
export const MAX_POLL_INTERVAL_SECONDS = 86_400

// events.jsonl is a ring buffer: once it passes MAX it is trimmed back to KEEP.
export const EVENTS_MAX = 1000
export const EVENTS_KEEP = 500

const ID_RE = /^acc_(\d+)$/
const STRATEGIES: readonly Strategy[] = ['best', 'consume_first']

/** UTC timestamp with second precision and a `Z` suffix, as used everywhere. */
export function utcNowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Write `text` to `path` via a same-directory temp file and rename. */
export function atomicWrite(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, text)
    closeSync(fd)
    chmodSync(tmp, mode) // umask may have narrowed the create mode
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    throw err
  }
}

function readJson(path: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function clampNumber(value: unknown, fallback: number, min: number, max = Number.POSITIVE_INFINITY): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Merge over the defaults and clamp every field into its documented range, so
 * a hand-edited or stale settings file can never put the policy into an
 * impossible state (threshold 0 would swap on every poll).
 */
export function normalizeSettings(input: unknown): Settings {
  const s = isRecord(input) ? input : {}
  const d = DEFAULT_SETTINGS
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  const strategy = STRATEGIES.includes(s.strategy as Strategy) ? (s.strategy as Strategy) : d.strategy
  const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : d.model
  return {
    autoswapEnabled: bool(s.autoswapEnabled, d.autoswapEnabled),
    dryRun: bool(s.dryRun, d.dryRun),
    fiveHourThreshold: clampNumber(s.fiveHourThreshold, d.fiveHourThreshold, 50, 100),
    threshold: clampNumber(s.threshold, d.threshold, 50, 100),
    margin: clampNumber(s.margin, d.margin, 0, 50),
    cooldownSeconds: clampNumber(s.cooldownSeconds, d.cooldownSeconds, 0),
    pollIntervalSeconds: clampNumber(s.pollIntervalSeconds, d.pollIntervalSeconds, 15, MAX_POLL_INTERVAL_SECONDS),
    strategy,
    model,
    codexEnabled: bool(s.codexEnabled, d.codexEnabled),
    notify: bool(s.notify, d.notify),
    launchAtLogin: bool(s.launchAtLogin, d.launchAtLogin),
    showInDock: bool(s.showInDock, d.showInDock),
    warnPct: clampNumber(s.warnPct, d.warnPct, 50, 100),
    nudgeMode: s.nudgeMode === 'context' ? 'context' : d.nudgeMode,
  }
}

const TOKEN_STATUSES: readonly TokenStatus[] = ['ok', 'expired', 'dead', 'unknown']

function toAccount(raw: unknown): StoredAccount | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: raw.id,
    email: str(raw.email),
    alias: str(raw.alias),
    orgName: str(raw.orgName),
    orgUuid: str(raw.orgUuid),
    accountUuid: str(raw.accountUuid),
    plan: typeof raw.plan === 'string' && raw.plan ? raw.plan : null,
    disabled: raw.disabled === true,
    addedAt: str(raw.addedAt),
    fingerprint: str(raw.fingerprint),
    tokenStatus: TOKEN_STATUSES.includes(raw.tokenStatus as TokenStatus) ? (raw.tokenStatus as TokenStatus) : 'ok',
  }
}

/** Accounts, settings, usage cache, state and the event log. */
export class Store {
  readonly dir: string
  private readonly files: {
    settings: string
    accounts: string
    usage: string
    events: string
    state: string
    credentials: string
  }

  constructor(dir: string) {
    this.dir = dir
    this.files = {
      settings: join(dir, 'settings.json'),
      accounts: join(dir, 'accounts.json'),
      usage: join(dir, 'usage.json'),
      events: join(dir, 'events.jsonl'),
      state: join(dir, 'state.json'),
      credentials: join(dir, 'credentials'),
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    mkdirSync(this.files.credentials, { recursive: true, mode: 0o700 })
    chmodSync(this.files.credentials, 0o700) // pre-existing dir keeps whatever mode it had
  }

  // -- settings -----------------------------------------------------------

  /** Stored settings merged over the defaults and clamped, so new keys always exist. */
  loadSettings(): Settings {
    return normalizeSettings(readJson(this.files.settings, {}))
  }

  saveSettings(settings: Settings): void {
    atomicWrite(this.files.settings, JSON.stringify(normalizeSettings(settings), null, 2))
  }

  // -- accounts -----------------------------------------------------------

  listAccounts(): StoredAccount[] {
    const raw = readJson(this.files.accounts, [])
    if (!Array.isArray(raw)) return []
    return raw.map(toAccount).filter((a): a is StoredAccount => a !== null)
  }

  private saveAccounts(accounts: StoredAccount[]): void {
    atomicWrite(this.files.accounts, JSON.stringify(accounts, null, 2))
  }

  getAccount(id: string): StoredAccount | null {
    return this.listAccounts().find((a) => a.id === id) ?? null
  }

  /** Resolve a user-typed reference: exact id, then alias, then email (case-insensitive). */
  findAccount(query: string): StoredAccount | null {
    const q = query.trim()
    const accounts = this.listAccounts()
    const byId = accounts.find((a) => a.id === q)
    if (byId) return byId
    const ql = q.toLowerCase()
    const byAlias = accounts.find((a) => a.alias && a.alias.toLowerCase() === ql)
    if (byAlias) return byAlias
    return accounts.find((a) => a.email.toLowerCase() === ql) ?? null
  }

  upsertAccount(account: StoredAccount): StoredAccount {
    const accounts = this.listAccounts()
    const stored: StoredAccount = { ...account, addedAt: account.addedAt || utcNowIso() }
    const index = accounts.findIndex((a) => a.id === stored.id)
    if (index >= 0) accounts[index] = stored
    else accounts.push(stored)
    this.saveAccounts(accounts)
    return stored
  }

  /** Remove the account, its credential and its cached usage together. */
  deleteAccount(id: string): void {
    this.saveAccounts(this.listAccounts().filter((a) => a.id !== id))
    this.deleteCredential(id)
    const usage = this.loadUsage()
    if (id in usage) {
      delete usage[id]
      this.saveUsage(usage)
    }
  }

  /**
   * `acc_N` above every id ever seen (accounts, usage, credential files, events)
   * so a deleted account's id is never recycled onto its stale cache or history.
   */
  nextAccountId(): string {
    const seen: string[] = this.listAccounts().map((a) => a.id)
    seen.push(...Object.keys(this.loadUsage()))
    try {
      for (const name of readdirSync(this.files.credentials)) {
        if (name.endsWith('.json')) seen.push(name.slice(0, -'.json'.length))
      }
    } catch {
      // credentials dir missing: nothing seen there
    }
    seen.push(...this.readEvents(EVENTS_MAX).map((e) => e.accountId ?? ''))
    let max = 0
    for (const s of seen) {
      const m = ID_RE.exec(s)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return `acc_${max + 1}`
  }

  // -- credentials --------------------------------------------------------

  private credPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`bad account id: ${id}`)
    return join(this.files.credentials, `${id}.json`)
  }

  readCredential(id: string): string | null {
    const path = this.credPath(id)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  writeCredential(id: string, value: string): void {
    atomicWrite(this.credPath(id), value, 0o600)
  }

  deleteCredential(id: string): void {
    try {
      unlinkSync(this.credPath(id))
    } catch {
      // already gone
    }
  }

  // -- usage cache --------------------------------------------------------

  loadUsage(): Record<string, Usage> {
    const data = readJson(this.files.usage, {})
    return isRecord(data) ? (data as Record<string, Usage>) : {}
  }

  saveUsage(usage: Record<string, Usage>): void {
    atomicWrite(this.files.usage, JSON.stringify(usage, null, 2))
  }

  // -- daemon state -------------------------------------------------------

  loadState(): StoredState {
    const data = readJson(this.files.state, {})
    const d = isRecord(data) ? data : {}
    return {
      activeId: typeof d.activeId === 'string' ? d.activeId : null,
      lastSwitchAt: typeof d.lastSwitchAt === 'string' ? d.lastSwitchAt : null,
      lastDecision: isRecord(d.lastDecision) ? (d.lastDecision as unknown as Decision) : null,
    }
  }

  /** Partial update: unspecified keys keep their stored value. */
  saveState(state: Partial<StoredState>): void {
    const merged = { ...this.loadState(), ...state }
    atomicWrite(this.files.state, JSON.stringify(merged, null, 2))
  }

  // -- events -------------------------------------------------------------

  /** Append one line; a single `O_APPEND` write of < PIPE_BUF bytes is atomic. */
  appendEvent(kind: EventKind, message: string, accountId: string | null = null): SwapperEvent {
    const event: SwapperEvent = { id: randomUUID(), at: utcNowIso(), kind, message, accountId }
    mkdirSync(dirname(this.files.events), { recursive: true })
    appendFileSync(this.files.events, JSON.stringify(event) + '\n')
    this.trimEvents()
    return event
  }

  private trimEvents(): void {
    let lines: string[]
    try {
      lines = readFileSync(this.files.events, 'utf8').split('\n').filter(Boolean)
    } catch {
      return
    }
    if (lines.length > EVENTS_MAX) {
      atomicWrite(this.files.events, lines.slice(-EVENTS_KEEP).join('\n') + '\n')
    }
  }

  /** Newest first. */
  readEvents(limit = 100): SwapperEvent[] {
    let lines: string[]
    try {
      lines = readFileSync(this.files.events, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
    const events: SwapperEvent[] = []
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      try {
        const parsed: unknown = JSON.parse(lines[i] as string)
        if (isRecord(parsed)) events.push(parsed as unknown as SwapperEvent)
      } catch {
        // skip a torn line
      }
    }
    return events
  }
}
