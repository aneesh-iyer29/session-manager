/**
 * Read-only view of the one Codex CLI login: identity, refresh, usage.
 *
 * Codex never gets swapped; we only mirror its quota next to the Claude ones.
 * Identity comes from the JWT claims in `auth.json` (decoded, not verified —
 * we trust our own disk), and we refresh the token only when it is about to
 * expire so Codex itself keeps ownership of the lineage most of the time.
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { CodexMode, CodexState, Usage, UsageWindow } from '../shared/types'
import { codexAuthPath } from './paths'
import { utcNowIso } from './store'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const AUTH_CLAIM = 'https://api.openai.com/auth'
export const REFRESH_LEAD_MS = 30 * 60 * 1000
export const TIMEOUT_MS = 10_000
const USER_AGENT = 'codex_cli_rs/0.50.0'

export type FetchFn = typeof fetch

export interface CodexAuth {
  mode: CodexMode
  accessToken?: string
  refreshToken?: string
  accountId?: string
  email?: string
  plan?: string
  path: string
}

export class CodexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Decode the payload segment of a JWT without verifying it; `{}` on any problem. */
export function jwtClaims(token: string | undefined | null): Record<string, unknown> {
  if (!token) return {}
  const parts = token.split('.')
  if (parts.length < 3) return {}
  try {
    // base64url decoding in Node tolerates missing padding, which Codex omits.
    const claims: unknown = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'))
    return isRecord(claims) ? claims : {}
  } catch {
    return {}
  }
}

interface TokenIdentity {
  accountId?: string
  email?: string
  plan?: string
}

/** Identity from the id token, falling back to the access token. */
function identity(tokens: Record<string, unknown>): TokenIdentity {
  const idClaims = jwtClaims(str(tokens.id_token))
  const claims = Object.keys(idClaims).length ? idClaims : jwtClaims(str(tokens.access_token))
  const auth = isRecord(claims[AUTH_CLAIM]) ? claims[AUTH_CLAIM] : {}
  const out: TokenIdentity = {}
  const accountId = str(tokens.account_id) ?? str(auth.chatgpt_account_id)
  const plan = str(auth.chatgpt_plan_type) ?? str(claims.plan_type)
  const email = str(claims.email)
  if (accountId) out.accountId = accountId
  if (plan) out.plan = plan
  if (email) out.email = email
  return out
}

export function readAuth(path: string = codexAuthPath()): CodexAuth {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { mode: 'none', path }
  }
  if (!isRecord(data)) return { mode: 'none', path }
  const tokens = isRecord(data.tokens) ? data.tokens : {}
  const hasTokens = Object.keys(tokens).length > 0
  if (data.auth_mode === 'apikey' || (data.OPENAI_API_KEY && !hasTokens)) return { mode: 'apikey', path }
  const access = str(tokens.access_token)
  if (!access) return { mode: 'none', path }
  const auth: CodexAuth = { mode: 'chatgpt', accessToken: access, path, ...identity(tokens) }
  const refresh = str(tokens.refresh_token)
  if (refresh) auth.refreshToken = refresh
  return auth
}

/** `exp` claim of the access token as epoch ms, or `null` for opaque tokens. */
export function tokenExpiresAt(token: string | undefined): number | null {
  const exp = jwtClaims(token).exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

/** True when the access token expires within `REFRESH_LEAD_MS`. */
export function needsRefresh(auth: CodexAuth, nowMs = Date.now()): boolean {
  if (auth.mode !== 'chatgpt' || !auth.refreshToken) return false
  const expires = tokenExpiresAt(auth.accessToken)
  if (expires === null) return false
  return expires - nowMs < REFRESH_LEAD_MS
}

/** Merge rotated tokens into auth.json, preserving every other key and the file mode. */
function writeBack(path: string, tokens: Record<string, string>, now: Date): void {
  let data: Record<string, unknown> = {}
  let mode = 0o600
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isRecord(parsed)) data = parsed
  } catch {
    data = {}
  }
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    mode = 0o600
  }
  data.tokens = { ...(isRecord(data.tokens) ? data.tokens : {}), ...tokens }
  data.last_refresh = utcNowIso(now)
  const tmp = join(dirname(path), basename(path) + '.tmp')
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, JSON.stringify(data, null, 2))
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Refresh when < 30 min of access token remain; otherwise return `auth` untouched. */
export async function maybeRefresh(auth: CodexAuth, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<CodexAuth> {
  if (!needsRefresh(auth, now.getTime()) || !auth.refreshToken) return auth
  let resp: unknown
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: auth.refreshToken,
        scope: 'openid profile email',
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new CodexError(`HTTP ${res.status}`)
    resp = await res.json()
  } catch (err) {
    throw new CodexError(`codex refresh failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const r = isRecord(resp) ? resp : {}
  const access = str(r.access_token)
  if (!access) throw new CodexError('codex refresh returned no access token')
  const tokens: Record<string, string> = {
    access_token: access,
    refresh_token: str(r.refresh_token) ?? auth.refreshToken,
  }
  const idToken = str(r.id_token)
  if (idToken) tokens.id_token = idToken
  if (auth.accountId) tokens.account_id = auth.accountId
  writeBack(auth.path, tokens, now)
  const id = identity(tokens)
  const next: CodexAuth = { mode: 'chatgpt', accessToken: access, refreshToken: tokens.refresh_token as string, path: auth.path }
  const accountId = id.accountId ?? auth.accountId
  const email = id.email ?? auth.email
  const plan = id.plan ?? auth.plan
  if (accountId) next.accountId = accountId
  if (email) next.email = email
  if (plan) next.plan = plan
  return next
}

/** Raw `wham/usage` payload with the headers the Codex CLI sends. */
export async function fetchUsage(auth: CodexAuth, fetchFn: FetchFn = fetch): Promise<unknown> {
  if (auth.mode !== 'chatgpt' || !auth.accessToken) throw new CodexError('codex is not logged in with ChatGPT')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    originator: 'codex_cli_rs',
  }
  if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId
  const res = await fetchFn(USAGE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403 ? 'codex login expired; run `codex login`' : `HTTP ${res.status}`
    throw new CodexError(msg)
  }
  return res.json()
}

const iso = (ms: number): string => utcNowIso(new Date(ms))

/** `reset_at` (epoch seconds or ISO) wins; `reset_after_seconds` is relative to now. */
function resetAt(win: Record<string, unknown>, now: Date): string | null {
  const value = win.reset_at ?? win.resets_at
  if (typeof value === 'number' && Number.isFinite(value)) return iso(value * 1000)
  if (typeof value === 'string' && value) return value
  const after = win.reset_after_seconds
  if (typeof after === 'number' && Number.isFinite(after)) return iso(now.getTime() + after * 1000)
  return null
}

/** `wham/usage` → the shared normalized shape (primary = 5h, secondary = weekly). */
export function normalizeUsage(raw: unknown, now: Date = new Date()): Usage {
  const r = isRecord(raw) ? raw : {}
  const limits = isRecord(r.rate_limit) ? r.rate_limit : isRecord(r.rate_limits) ? r.rate_limits : {}
  const windows: UsageWindow[] = []
  for (const [keys, outKey, label] of [
    [['primary_window', 'primary'], 'five_hour', '5-hour'],
    [['secondary_window', 'secondary'], 'seven_day', 'Weekly'],
  ] as const) {
    let win: Record<string, unknown> | null = null
    for (const k of keys) {
      const candidate = limits[k]
      if (isRecord(candidate)) {
        win = candidate
        break
      }
    }
    if (!win) continue
    const pct = win.used_percent ?? win.percent_used
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue
    windows.push({
      key: outKey,
      label,
      pct: Math.round(Math.min(Math.max(pct, 0), 100) * 10) / 10,
      resetsAt: resetAt(win, now),
    })
  }
  return { fetchedAt: utcNowIso(now), ok: true, error: null, windows, plan: str(r.plan_type) ?? null }
}

export interface SnapshotOptions {
  fetchFn?: FetchFn
  path?: string
  now?: Date
}

/** The `codex` block of the app state. Never throws. */
export async function snapshot(opts: SnapshotOptions = {}): Promise<CodexState> {
  const now = opts.now ?? new Date()
  const base: CodexState = { configured: false, mode: 'none', email: null, plan: null, usage: null }
  let auth: CodexAuth
  try {
    auth = readAuth(opts.path)
  } catch {
    return base
  }
  if (auth.mode === 'none') return base
  const configured: CodexState = { ...base, configured: true, mode: auth.mode, email: auth.email ?? null, plan: auth.plan ?? null }
  if (auth.mode === 'apikey') return configured
  try {
    auth = await maybeRefresh(auth, opts.fetchFn, now)
    const usage = normalizeUsage(await fetchUsage(auth, opts.fetchFn), now)
    return { ...configured, email: auth.email ?? null, plan: usage.plan ?? auth.plan ?? null, usage }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...configured, usage: { fetchedAt: utcNowIso(now), ok: false, error: message, windows: [], plan: auth.plan ?? null } }
  }
}
