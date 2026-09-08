/**
 * Daemon: the poll loop, autoswap orchestration, login bookkeeping, and the
 * single object the IPC layer and the tray talk to.
 *
 * It owns no persistence and no protocol code of its own; it composes the core
 * modules (store, claudeOauth, codex, switcher, autoswap). Every side effect
 * that would touch the network or the Keychain goes through `deps`, so tests
 * can run the real orchestration against fakes.
 */
import { EventEmitter } from 'node:events'
import { DEFAULT_SETTINGS } from '../shared/types'
import type {
  Account,
  AppState,
  CodexState,
  Decision,
  LoginStatus,
  Settings,
  TokenStatus,
  Usage,
} from '../shared/types'
import { MAX_POLL_INTERVAL_SECONDS, type Store, type StoredAccount } from './store'
import * as claudeOauth from './claudeOauth'
import * as codex from './codex'
import * as switcher from './switcher'
import * as nudge from './nudge'
import * as live from './liveUsage'
import { watch, type FSWatcher } from 'node:fs'
import { dataDir } from './paths'
import * as autoswap from './autoswap'
import { readActiveCredential, writeActiveCredential } from './keychain'

/** Usage fetched more recently than this is reused unless the poll is forced. */
/**
 * The usage endpoint allows roughly 28-30 requests per trailing hour per token,
 * with no refill until old requests age out, and Claude Code's own checks share
 * that budget. Six to ten fetches an hour per account is the safe steady state.
 */
const MIN_FETCH_GAP_MS = 5 * 60_000
/** Standby accounts change slowly; poll them every ten minutes unless they are close to the line. */
const STANDBY_FETCH_GAP_MS = 10 * 60_000
/** With the status line feed fresh, the endpoint is only needed for the per-model window. */
const LIVE_FED_FETCH_GAP_MS = 30 * 60_000
const LIVE_FRESH_MS = 15 * 60_000
/**
 * Between endpoint polls the per-model (Fable) window is projected from the live
 * weekly window: these accounts run Fable almost exclusively, and the Fable
 * weekly cap is about half the all-models cap, so each weekly point is worth two
 * Fable points. Anchored at the last real pair so the projection never drifts
 * beyond one poll interval.
 */
const MODEL_PER_WEEKLY = 2
const NEAR_LINE_PTS = 10
/** Fallback back-off after a 429 without a Retry-After. */
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000
/** How long a failed Codex refresh/usage call holds the next attempt off (a dead refresh token must not be retried every poll). */
const CODEX_BACKOFF_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 300_000
const EVENT_LIMIT = 100
const MAX_ALIAS_LENGTH = 64

export type FetchFn = typeof fetch

export interface DaemonDeps {
  fetchFn?: FetchFn
  readActive?: () => Promise<string | null>
  writeActive?: (value: string) => Promise<void>
  codexSnapshot?: () => Promise<CodexState>
  openUrl?: (url: string) => void | Promise<void>
  notify?: (title: string, body: string) => void
  now?: () => Date
}

export interface DaemonOptions {
  store: Store
  version: string
  deps?: DaemonDeps
}

interface LoginRecord {
  id: string
  url: string
  status: LoginStatus['status']
  account?: Account
  error?: string
  cancel: () => void
}

const EMPTY_CODEX: CodexState = { configured: false, mode: 'none', email: null, plan: null, usage: null }

/** Lazy Electron defaults keep this module importable (and testable) outside Electron. */
async function defaultOpenUrl(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

function defaultNotify(title: string, body: string): void {
  void import('electron').then(({ Notification }) => {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })
}

function iso(d: Date): string {
  return d.toISOString()
}

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Error text for events and usage records: short, and never a token. */
function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').slice(0, 200)
}

type BooleanSetting = 'autoswapEnabled' | 'dryRun' | 'codexEnabled' | 'notify' | 'launchAtLogin' | 'showInDock'

function assertNumber(key: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`)
  }
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`)
  return value
}

function assertBoolean(key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`)
  return value
}

/**
 * Validate a settings patch against the ranges the UI promises. Unknown keys
 * are rejected so settings.json never accumulates junk from an old renderer.
 */
export function validateSettingsPatch(patch: Partial<Settings>, current: Settings): Settings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings patch must be an object')
  }
  const next: Settings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    switch (key as keyof Settings) {
      case 'threshold':
        next.threshold = Math.round(assertNumber(key, value, 50, 100))
        break
      case 'margin':
        next.margin = Math.round(assertNumber(key, value, 0, 50))
        break
      case 'cooldownSeconds':
        next.cooldownSeconds = Math.round(assertNumber(key, value, 0, Number.MAX_SAFE_INTEGER))
        break
      case 'pollIntervalSeconds':
        next.pollIntervalSeconds = Math.round(assertNumber(key, value, 15, MAX_POLL_INTERVAL_SECONDS))
        break
      case 'strategy':
        if (value !== 'best' && value !== 'consume_first') {
          throw new Error('strategy must be "best" or "consume_first"')
        }
        next.strategy = value
        break
      case 'model':
        if (typeof value !== 'string' || !value.trim()) throw new Error('model must not be empty')
        next.model = value.trim()
        break
      case 'warnPct':
        next.warnPct = Math.round(assertNumber(key, value, 50, 100))
        break
      case 'nudgeMode':
        if (value !== 'block' && value !== 'context') throw new Error('nudgeMode must be "block" or "context"')
        next.nudgeMode = value
        break
      case 'autoswapEnabled':
      case 'dryRun':
      case 'codexEnabled':
      case 'notify':
      case 'launchAtLogin':
      case 'showInDock':
        next[key as BooleanSetting] = assertBoolean(key, value)
        break
      default:
        throw new Error(`unknown setting "${key}"`)
    }
  }
  return next
}

export class Daemon {
  private readonly store: Store
  private readonly version: string
  private readonly fetchFn: FetchFn
  private readonly readActive: () => Promise<string | null>
  private readonly writeActive: (value: string) => Promise<void>
  private readonly codexSnapshot: () => Promise<CodexState>
  private readonly openUrl: (url: string) => void | Promise<void>
  private readonly notify: (title: string, body: string) => void
  private readonly now: () => Date

  private readonly emitter = new EventEmitter()
  private timer: NodeJS.Timeout | null = null
  private running = false
  private inFlight: Promise<void> | null = null
  /** Whether the poll in flight covers Codex; a joining caller that needs it runs that part after. */
  private inFlightCodex = false
  private codexInFlight: Promise<void> | null = null
  private lastPollAt: Date | null = null
  private nextPollAt: Date | null = null
  /** Per-account: when usage was last attempted, and until when a 429 holds us off. */
  private readonly lastAttempt = new Map<string, number>()
  private readonly backoffUntil = new Map<string, number>()
  private codexState: CodexState = EMPTY_CODEX
  private codexBackoffUntil = 0
  private readonly logins = new Map<string, LoginRecord>()
  private liveWatcher: FSWatcher | null = null
  private liveTimer: NodeJS.Timeout | null = null
  private liveAppliedAt = 0
  /** Last endpoint-reported (model, weekly) pair per account, the anchor for the projection. */
  private readonly modelAnchor = new Map<string, { key: string; model: number; weekly: number }>()

  constructor(opts: DaemonOptions) {
    this.store = opts.store
    this.version = opts.version
    const deps = opts.deps ?? {}
    this.fetchFn = deps.fetchFn ?? fetch
    this.readActive = deps.readActive ?? (() => readActiveCredential())
    this.writeActive = deps.writeActive ?? ((v) => writeActiveCredential(v))
    this.codexSnapshot = deps.codexSnapshot ?? (() => codex.snapshot({ fetchFn: this.fetchFn }))
    this.openUrl = deps.openUrl ?? defaultOpenUrl
    this.notify = deps.notify ?? defaultNotify
    this.now = deps.now ?? (() => new Date())
  }

  // ----- lifecycle -----

  /** Start polling: one poll now, then a setTimeout chain (never setInterval, so a slow poll can't pile up). */
  start(): void {
    this.watchLive()
    if (this.running) return
    this.running = true
    void this.poll(true).finally(() => this.schedule())
  }

  stop(): void {
    this.liveWatcher?.close()
    this.liveWatcher = null
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextPollAt = null
    for (const login of this.logins.values()) if (login.status === 'pending') login.cancel()
  }

  private schedule(): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    // Settings are clamped, but a hand-edited file must still never exceed the 32-bit timer range.
    const ms = Math.min(this.settings().pollIntervalSeconds, MAX_POLL_INTERVAL_SECONDS) * 1000
    this.nextPollAt = new Date(this.now().getTime() + ms)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll(false).finally(() => this.schedule())
    }, ms)
    this.timer.unref?.()
  }

  // ----- events -----

  on(event: 'state', cb: (state: AppState) => void): void {
    this.emitter.on(event, cb)
  }

  off(event: 'state', cb: (state: AppState) => void): void {
    this.emitter.off(event, cb)
  }

  /** A listener that throws (tray, IPC) must not unwind the poll loop or an IPC handler. */
  private emit(): void {
    if (this.emitter.listenerCount('state') === 0) return
    let state: AppState
    try {
      state = this.getState()
    } catch (err) {
      this.store.appendEvent('error', `state: ${describe(err)}`)
      return
    }
    for (const listener of this.emitter.listeners('state') as Array<(s: AppState) => void>) {
      try {
        listener(state)
      } catch (err) {
        this.store.appendEvent('error', `state listener: ${describe(err)}`)
      }
    }
  }

  // ----- settings -----

  private settings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.store.loadSettings() }
  }

  updateSettings(patch: Partial<Settings>): AppState {
    const next = validateSettingsPatch(patch, this.settings())
    this.store.saveSettings(next)
    this.schedule()
    this.emit()
    return this.getState()
  }

  // ----- state -----

  getState(): AppState {
    const settings = this.settings()
    const state = this.store.loadState()
    const usage = this.store.loadUsage()
    const accounts = this.store
      .listAccounts()
      .map((a) => this.toAccount(a, usage[a.id] ?? null, state.activeId, settings.model))
    // Hero first, then the most runway; unknown usage sinks to the bottom.
    accounts.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      const ha = a.headroom ?? -1
      const hb = b.headroom ?? -1
      if (ha !== hb) return hb - ha
      return a.id.localeCompare(b.id)
    })
    return {
      version: this.version,
      now: iso(this.now()),
      activeId: state.activeId,
      polling: {
        lastPollAt: this.lastPollAt ? iso(this.lastPollAt) : null,
        nextPollAt: this.nextPollAt ? iso(this.nextPollAt) : null,
        inFlight: this.inFlight !== null,
      },
      autoswap: { lastDecision: state.lastDecision, lastSwitchAt: state.lastSwitchAt },
      settings,
      accounts,
      codex: this.codexState,
      nudge: { hookInstalled: nudge.isHookInstalled(), pending: nudge.readFlag() },
      liveFeed: { installed: live.isFeedInstalled(), lastAt: (() => { const f = live.readLive(dataDir(), this.now()); return f ? iso(f.at) : null })() },
      events: this.store.readEvents(EVENT_LIMIT),
    }
  }

  private toAccount(a: StoredAccount, usage: Usage | null, activeId: string | null, model: string): Account {
    const binding = usage ? autoswap.bindingWindow(usage, model) : null
    return {
      id: a.id,
      email: a.email,
      alias: a.alias,
      orgName: a.orgName,
      orgUuid: a.orgUuid,
      accountUuid: a.accountUuid,
      plan: a.plan,
      active: a.id === activeId,
      disabled: a.disabled,
      addedAt: a.addedAt,
      tokenStatus: a.tokenStatus,
      usage,
      headroom: usage ? autoswap.headroom(usage, model) : null,
      bindingWindow: binding ? binding.key : null,
    }
  }

  // ----- polling -----

  /** Everything the scheduled poll does, now: every Claude account, Codex, then the swap policy. */
  async refresh(force = true): Promise<AppState> {
    await this.poll(force)
    return this.getState()
  }

  /** The toolbar button: the Claude accounts only. Codex has its own button and `refreshCodex`. */
  async refreshClaude(): Promise<AppState> {
    await this.poll(true, false)
    return this.getState()
  }

  /**
   * The Codex panel button: the Codex snapshot only, ignoring its back-off.
   * The state is updated and pushed before a failed fetch is thrown, so the
   * panel shows the stale numbers and the caller can toast the reason
   * (`usage.error` is user-safe by contract).
   */
  async refreshCodex(): Promise<AppState> {
    await this.codexPoll(true)
    this.emit()
    const usage = this.codexState.usage
    if (usage && !usage.ok) throw new Error(usage.error ?? 'Codex usage could not be fetched')
    return this.getState()
  }

  /** Serialized: a second caller waits for the poll already in flight instead of starting another. */
  private poll(force: boolean, includeCodex = true): Promise<void> {
    if (this.inFlight) {
      const joined = this.inFlight
      return includeCodex && !this.inFlightCodex ? joined.then(() => this.codexPoll(force)) : joined
    }
    this.inFlightCodex = includeCodex
    this.inFlight = this.pollOnce(force, includeCodex).finally(() => {
      this.inFlight = null
      this.emit()
    })
    this.emit()
    return this.inFlight
  }

  /** Never rejects: every phase is guarded, and so is the bookkeeping around them. */
  private async pollOnce(force: boolean, includeCodex: boolean): Promise<void> {
    try {
      const settings = this.settings()
      const now = this.now()
      await this.guard('sync active credential', () => this.syncActiveCredential())
      await this.guard('live usage', async () => void this.applyLive())
      const activeId = this.store.loadState().activeId
      const usageNow = this.store.loadUsage()
      for (const acc of this.store.listAccounts()) {
        if (acc.disabled) continue
        const last = this.lastAttempt.get(acc.id)
        const gap = this.fetchGap(acc, activeId, usageNow[acc.id] ?? null, settings)
        if (!force && last !== undefined && now.getTime() - last < gap) continue
        const held = this.backoffUntil.get(acc.id)
        if (held !== undefined && now.getTime() < held) continue
        this.lastAttempt.set(acc.id, now.getTime())
        await this.guard(`refresh ${acc.email}`, () => this.refreshAccount(acc, settings))
      }
      if (includeCodex) await this.codexPoll(force)
      if (settings.autoswapEnabled) await this.guard('autoswap', () => this.runAutoswap(settings))
      await this.guard('nudge', async () => this.updateNudge(settings))
      this.lastPollAt = now
    } catch (err) {
      try {
        this.store.appendEvent('error', `poll: ${describe(err)}`)
      } catch {
        // the store itself is unwritable; nothing more to do this round
      }
    }
  }

  /**
   * How long to leave an account alone between usage fetches. The active
   * account is watched every poll; a standby one only every few minutes unless
   * it is within a few points of the threshold, where a swap decision may hinge
   * on it. Keeps the usage endpoint's budget intact with many accounts.
   */
  private fetchGap(acc: StoredAccount, activeId: string | null, usage: Usage | null, settings: Settings): number {
    if (acc.id === activeId) return this.liveIsFresh() ? LIVE_FED_FETCH_GAP_MS : MIN_FETCH_GAP_MS
    const worst = autoswap.bindingWindow(usage, settings.model)
    if (worst && worst.pct >= settings.threshold - NEAR_LINE_PTS) return MIN_FETCH_GAP_MS
    return STANDBY_FETCH_GAP_MS
  }

  /** Errors never kill the loop; they become `error` events the user can read. */
  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      this.store.appendEvent('error', `${label}: ${describe(err)}`)
    }
  }

  /**
   * Track which account Claude Code is really using and keep its rotated token.
   * Claude Code refreshes the active token itself; if we did not copy the new
   * value into the account's slot, switching away would lose it.
   */
  private async syncActiveCredential(): Promise<void> {
    let live: string | null
    try {
      live = await this.readActive()
    } catch {
      return // Keychain locked or wedged: leave our bookkeeping as it was
    }
    if (!live) return // logged out: `activeId` keeps naming the last known account
    const state = this.store.loadState()
    // Ownership needs the fingerprint or, after Claude Code rotated the refresh
    // token, `activeId` confirmed by the email in ~/.claude.json. A live login
    // that matches neither belongs to someone we do not track: never copy it
    // over a stored account's credential.
    const acc = switcher.ownerOfLive(this.store, live)
    if (!acc) {
      if (state.activeId !== null) {
        this.store.saveState({ ...state, activeId: null })
        this.store.appendEvent('info', 'Claude Code is logged in as an account Session Manager does not track; use Capture to add it')
      }
      return
    }
    if (state.activeId !== acc.id) {
      this.store.saveState({ ...state, activeId: acc.id })
      this.store.appendEvent('info', `active login is now ${acc.email}`, acc.id)
    }
    const fp = claudeOauth.credentialFingerprint(live)
    if (fp !== acc.fingerprint) {
      this.store.writeCredential(acc.id, live)
      this.store.upsertAccount({ ...acc, fingerprint: fp })
    }
  }

  private async refreshAccount(acc: StoredAccount, settings: Settings): Promise<void> {
    let cred = this.store.readCredential(acc.id)
    if (!cred) {
      this.recordUsage(acc, null, 'no credential stored', 'dead')
      return
    }
    // A dead token stays dead until the user re-adds the account; retrying only
    // spams the token endpoint with a refresh token the server already rejected.
    if (acc.tokenStatus === 'dead') return
    const isActive = acc.id === this.store.loadState().activeId
    // `expired` also covers a 401 on a token whose expiresAt still looks valid
    // (revoked, or clock skew): rotate it instead of hitting 401 every poll.
    const stale = acc.tokenStatus === 'expired' || claudeOauth.isExpired(cred, undefined, this.now().getTime())
    if (!isActive && stale) {
      const result = await claudeOauth.refreshCredentials(cred, this.fetchFn)
      const current = this.store.getAccount(acc.id)
      if (!current) return // removed while the refresh was in flight
      acc = current
      if (result.credentials) {
        cred = result.credentials
        this.store.writeCredential(acc.id, cred)
        acc = { ...acc, fingerprint: claudeOauth.credentialFingerprint(cred) }
        this.store.upsertAccount(acc)
      } else if (result.error === 'invalid_grant' || result.error === 'no_refresh_token') {
        this.recordUsage(acc, null, `refresh failed: ${result.error}`, 'dead')
        this.store.appendEvent('error', `${acc.email}: token is dead (${result.error})`, acc.id)
        return
      } else {
        this.recordUsage(acc, null, 'refresh failed: transient', 'expired')
        return
      }
    }
    const token = claudeOauth.extractAccessToken(cred)
    if (!token) {
      this.recordUsage(acc, null, 'credential has no access token', 'dead')
      return
    }
    try {
      const raw = await claudeOauth.fetchUsage(token, this.fetchFn)
      let usage = claudeOauth.normalizeUsage(raw, settings.model)
      const modelKey = `model:${settings.model.toLowerCase()}`
      const modelWin = usage.windows.find((w) => w.key === modelKey)
      const weeklyWin = usage.windows.find((w) => w.key === 'seven_day')
      if (modelWin && weeklyWin) this.modelAnchor.set(acc.id, { key: modelKey, model: modelWin.pct, weekly: weeklyWin.pct })
      else this.modelAnchor.delete(acc.id)
      // The status line is the fresher source for the active account's 5h/7d windows.
      const feed = isActive ? live.readLive(dataDir(), this.now()) : null
      if (feed && this.now().getTime() - feed.at.getTime() < LIVE_FRESH_MS) {
        const liveKeys = new Set(feed.windows.map((w) => w.key))
        usage = { ...usage, windows: [...feed.windows, ...usage.windows.filter((w) => !liveKeys.has(w.key))] }
      }
      this.recordUsage(acc, usage, null, 'ok')
    } catch (err) {
      const ue = err instanceof claudeOauth.UsageError ? err : claudeOauth.classifyUsageError(err)
      let message = describe(ue)
      if (ue.kind === 'rate_limited') {
        const waitMs = ue.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS
        this.backoffUntil.set(acc.id, this.now().getTime() + waitMs)
        message = `Rate limited by Anthropic · retrying in ${Math.max(1, Math.round(waitMs / 60_000))} min`
      } else if (ue.kind === 'unauthorized') {
        message = 'Token rejected · refreshing on the next poll'
      } else if (ue.kind === 'network') {
        message = 'No connection · retrying'
      } else if (ue.kind === 'server') {
        message = `Anthropic error${ue.status ? ` ${ue.status}` : ''} · retrying`
      }
      const status: TokenStatus = ue.kind === 'unauthorized' ? 'expired' : acc.tokenStatus
      this.recordUsage(acc, null, message, status)
    }
  }

  /**
   * Persist a fetch result; on failure keep the stale windows but flag them.
   *
   * `acc` was read before the network round trip, so it is re-read here: the
   * user may have renamed, disabled or removed the account meanwhile, and
   * writing the old snapshot back would undo that (or resurrect the account).
   */
  private recordUsage(snapshot: StoredAccount, usage: Usage | null, error: string | null, status: TokenStatus): void {
    const acc = this.store.getAccount(snapshot.id)
    if (!acc) return
    const all = this.store.loadUsage()
    let next: Usage
    if (usage) {
      next = { ...usage, ok: usage.ok ?? true, error: usage.error ?? null }
    } else {
      const stale = all[acc.id]
      next = stale
        ? { ...stale, ok: false, error }
        : { fetchedAt: iso(this.now()), ok: false, error, windows: [], plan: acc.plan }
    }
    all[acc.id] = next
    this.store.saveUsage(all)
    const plan = next.ok && next.plan ? next.plan : acc.plan
    this.store.upsertAccount({ ...acc, tokenStatus: status, plan })
  }

  /** One Codex snapshot at a time: a manual refresh joins the one a poll already started rather than doubling the call. */
  private codexPoll(force: boolean): Promise<void> {
    if (this.codexInFlight) return this.codexInFlight
    this.codexInFlight = this.guard('codex', () => this.pollCodex(this.settings(), force)).finally(() => {
      this.codexInFlight = null
    })
    return this.codexInFlight
  }

  private async pollCodex(settings: Settings, force: boolean): Promise<void> {
    if (!settings.codexEnabled) {
      this.codexState = EMPTY_CODEX
      return
    }
    const nowMs = this.now().getTime()
    if (!force && nowMs < this.codexBackoffUntil) return
    this.codexState = await this.codexSnapshot()
    const failed = this.codexState.configured && this.codexState.mode === 'chatgpt' && this.codexState.usage?.ok === false
    this.codexBackoffUntil = failed ? nowMs + CODEX_BACKOFF_MS : 0
  }

  /**
   * Raise the compact-nudge flag while an automatic swap is close: the active
   * account's worst gating window is at or past `warnPct` and auto-swap is
   * armed for real. Clear it otherwise. The id is stable for one episode so
   * the hook blocks a prompt at most once per approach to the line.
   */
  private updateNudge(settings: Settings): void {
    const state = this.store.loadState()
    const active = state.activeId ? this.store.getAccount(state.activeId) : null
    const usage = active ? (this.store.loadUsage()[active.id] ?? null) : null
    const worst = active && settings.autoswapEnabled && !settings.dryRun ? autoswap.bindingWindow(usage, settings.model) : null
    if (!active || !worst || worst.pct < settings.warnPct) {
      if (nudge.readFlag()) {
        nudge.clearFlag()
        this.store.appendEvent('info', 'Compact nudge cleared', active?.id ?? null)
      }
      return
    }
    const label = active.alias || active.email
    const pct = Math.round(worst.pct)
    const flag = {
      id: `${active.id}:${worst.key}:${worst.resetsAt ?? 'unknown'}`,
      at: iso(this.now()),
      accountId: active.id,
      label,
      window: worst.label,
      pct,
      message: `${label} is at ${pct}% of ${worst.label} and will be swapped at ${settings.threshold}%.`,
    }
    const previous = nudge.readFlag()
    nudge.writeFlag(flag, settings.nudgeMode)
    if (!previous || previous.id !== flag.id) {
      this.store.appendEvent('info', `Compact nudge raised: ${flag.message}`, active.id)
    }
  }

  /**
   * Follow Claude Code's status line file. `fs.watch` on the data dir fires for
   * the rename that lands each atomic write; a short debounce coalesces bursts
   * from several sessions. Applying is cheap, so the UI updates within a second
   * of Claude Code learning new numbers.
   */
  private watchLive(): void {
    if (this.liveWatcher) return
    try {
      this.liveWatcher = watch(dataDir(), (_event, filename) => {
        if (filename !== live.LIVE_FILE) return
        if (this.liveTimer) clearTimeout(this.liveTimer)
        this.liveTimer = setTimeout(() => {
          this.liveTimer = null
          this.guard('live usage', async () => {
            if (this.applyLive()) {
              const settings = this.settings()
              if (settings.autoswapEnabled) await this.runAutoswap(settings)
              this.updateNudge(settings)
              this.emit()
            }
          }).catch(() => undefined)
        }, 400)
      })
      this.liveWatcher.on('error', () => {
        this.liveWatcher = null
      })
    } catch {
      this.liveWatcher = null
    }
  }

  /**
   * Merge the status line's 5-hour / weekly windows into the active account's
   * stored usage. Windows the feed does not carry (the per-model one) are kept
   * from the last endpoint fetch. Returns true when something changed.
   */
  private applyLive(): boolean {
    const feed = live.readLive(dataDir(), this.now())
    if (!feed || feed.at.getTime() <= this.liveAppliedAt) return false
    const state = this.store.loadState()
    if (!state.activeId) return false
    const acc = this.store.getAccount(state.activeId)
    if (!acc) return false
    const all = this.store.loadUsage()
    const previous = all[acc.id]
    const liveKeys = new Set(feed.windows.map((w) => w.key))
    const anchor = this.modelAnchor.get(acc.id)
    const liveWeekly = feed.windows.find((w) => w.key === 'seven_day')
    const kept = (previous?.windows ?? [])
      .filter((w) => !liveKeys.has(w.key))
      .map((w) => {
        if (!anchor || !liveWeekly || w.key !== anchor.key) return w
        const projected = Math.max(0, Math.min(100, anchor.model + MODEL_PER_WEEKLY * (liveWeekly.pct - anchor.weekly)))
        return { ...w, pct: Math.round(projected * 10) / 10, estimated: true }
      })
    all[acc.id] = {
      fetchedAt: iso(feed.at),
      ok: true,
      error: null,
      windows: [...feed.windows, ...kept],
      plan: previous?.plan ?? acc.plan,
    }
    this.store.saveUsage(all)
    this.liveAppliedAt = feed.at.getTime()
    return true
  }

  private liveIsFresh(): boolean {
    const feed = live.readLive(dataDir(), this.now())
    return feed !== null && this.now().getTime() - feed.at.getTime() < LIVE_FRESH_MS
  }

  installFeed(): AppState {
    live.installFeed()
    this.store.appendEvent('info', 'Claude Code status line feed installed')
    this.emit()
    return this.getState()
  }

  uninstallFeed(): AppState {
    live.uninstallFeed()
    this.liveAppliedAt = 0
    this.store.appendEvent('info', 'Claude Code status line feed removed')
    this.emit()
    return this.getState()
  }

  installHook(): AppState {
    nudge.installHook()
    this.store.appendEvent('info', 'Claude Code compact-nudge hook installed')
    this.emit()
    return this.getState()
  }

  uninstallHook(): AppState {
    nudge.uninstallHook()
    this.store.appendEvent('info', 'Claude Code compact-nudge hook removed')
    this.emit()
    return this.getState()
  }

  private async runAutoswap(settings: Settings): Promise<void> {
    const state = this.store.loadState()
    const usage = this.store.loadUsage()
    const rows = this.store.listAccounts().map((a) => ({
      id: a.id,
      active: a.id === state.activeId,
      disabled: a.disabled,
      usage: usage[a.id] ?? null,
    }))
    const decision: Decision = autoswap.decide(rows, settings, this.now(), parseIso(state.lastSwitchAt))
    // Log only when action or target changes; "cooldown: 294s left" would churn every poll.
    const prev = state.lastDecision
    if (!prev || prev.action !== decision.action || prev.targetId !== decision.targetId) {
      this.store.appendEvent('autoswap', `${decision.action}: ${decision.reason}`, decision.targetId)
    }
    this.store.saveState({ ...state, lastDecision: decision })
    if (decision.action !== 'switch' || !decision.targetId) return
    const acc = await switcher.switchTo(this.store, decision.targetId, this.switcherDeps())
    this.lastAttempt.delete(acc.id)
    this.store.appendEvent('autoswap', `auto-switched to ${acc.email}: ${decision.reason}`, acc.id)
    if (settings.notify) this.notify('Session Manager', `Switched to ${acc.alias || acc.email}`)
  }

  private switcherDeps(): Partial<switcher.SwitcherDeps> {
    return { readActive: this.readActive, writeActive: this.writeActive, now: this.now, fetchFn: this.fetchFn }
  }

  // ----- account actions -----

  private require(accountId: string): StoredAccount {
    const acc = this.store.getAccount(accountId)
    if (!acc) throw new Error(`unknown account ${accountId}`)
    return acc
  }

  async switchTo(accountId: string): Promise<AppState> {
    this.require(accountId)
    const acc = await switcher.switchTo(this.store, accountId, this.switcherDeps())
    this.lastAttempt.delete(acc.id)
    this.updateNudge(this.settings())
    this.emit()
    return this.getState()
  }

  async captureActive(): Promise<AppState> {
    const acc = await switcher.addFromActive(this.store, this.switcherDeps())
    this.store.appendEvent('capture', `captured ${acc.email}`, acc.id)
    this.lastAttempt.delete(acc.id)
    this.emit()
    return this.getState()
  }

  startLogin(): LoginStatus {
    // One callback port: an earlier login still waiting would keep it bound.
    for (const pending of this.logins.values()) if (pending.status === 'pending') this.cancelLogin(pending.id)
    const flow = claudeOauth.startLoginFlow({
      fetchFn: this.fetchFn,
      openUrl: (url) => void this.openUrl(url),
      timeoutMs: LOGIN_TIMEOUT_MS,
    })
    const record: LoginRecord = { id: flow.id, url: flow.url, status: 'pending', cancel: () => flow.cancel() }
    this.logins.set(record.id, record)
    void flow.promise.then(
      (credential) => this.finishLogin(record, credential),
      (err) => this.failLogin(record, describe(err)),
    )
    return this.loginStatus(record.id)
  }

  private async finishLogin(record: LoginRecord, credential: string): Promise<void> {
    try {
      // A fresh login carries no identity; the switcher resolves it through the profile API.
      const acc = await switcher.addFromCredential(this.store, credential, null, this.switcherDeps())
      record.status = 'done'
      record.account = this.toAccount(
        acc,
        this.store.loadUsage()[acc.id] ?? null,
        this.store.loadState().activeId,
        this.settings().model,
      )
      this.store.appendEvent('login', `logged in as ${acc.email}`, acc.id)
      this.lastAttempt.delete(acc.id)
      this.emit()
      void this.poll(false)
    } catch (err) {
      this.failLogin(record, describe(err))
    }
  }

  private failLogin(record: LoginRecord, error: string): void {
    if (record.status !== 'pending') return
    record.status = 'error'
    record.error = error
    this.store.appendEvent('error', `login failed: ${error}`)
    this.emit()
  }

  loginStatus(loginId: string): LoginStatus {
    const record = this.logins.get(loginId)
    if (!record) throw new Error(`unknown login ${loginId}`)
    const out: LoginStatus = { id: record.id, status: record.status, url: record.url }
    if (record.account) out.account = record.account
    if (record.error) out.error = record.error
    return out
  }

  cancelLogin(loginId: string): void {
    const record = this.logins.get(loginId)
    if (!record) return
    if (record.status === 'pending') {
      record.cancel()
      record.status = 'error'
      record.error = 'login cancelled'
    }
    this.emit()
  }

  setDisabled(accountId: string, disabled: boolean): AppState {
    const acc = this.require(accountId)
    this.store.upsertAccount({ ...acc, disabled })
    this.store.appendEvent('info', `${disabled ? 'held out of rotation' : 'returned to rotation'}: ${acc.email}`, acc.id)
    this.emit()
    return this.getState()
  }

  setAlias(accountId: string, alias: string): AppState {
    const acc = this.require(accountId)
    const trimmed = alias.trim()
    if (trimmed.length > MAX_ALIAS_LENGTH) throw new Error(`alias must be at most ${MAX_ALIAS_LENGTH} characters`)
    this.store.upsertAccount({ ...acc, alias: trimmed })
    this.emit()
    return this.getState()
  }

  removeAccount(accountId: string): AppState {
    const acc = this.require(accountId)
    if (accountId === this.store.loadState().activeId) {
      throw new Error('cannot remove the active account; switch to another account first')
    }
    this.store.deleteAccount(accountId)
    try {
      this.store.deleteCredential(accountId)
    } catch {
      // The store may already have removed the credential with the account.
    }
    this.lastAttempt.delete(accountId)
    this.backoffUntil.delete(accountId)
    this.store.appendEvent('info', `removed ${acc.email}`, accountId)
    this.emit()
    return this.getState()
  }
}
