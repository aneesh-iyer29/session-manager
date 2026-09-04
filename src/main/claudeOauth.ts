/**
 * Claude OAuth: credential helpers, usage / profile fetch, refresh, PKCE login.
 *
 * Every network call goes through an injected `fetch` with a 10 s abort so
 * tests are hermetic and a stalled API can never wedge the poll loop. Nothing
 * here touches the Keychain or the store: callers hand in credential JSON
 * strings and get strings or plain objects back.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import type { LoginPhase, Usage, UsageWindow } from '../shared/types'
import { utcNowIso } from './store'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const EXCHANGE_URL = 'https://api.anthropic.com/v1/oauth/token'
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const LOGIN_PORT = 54545
export const SCOPES = 'org:create_api_key user:profile user:inference'
export const TIMEOUT_MS = 10_000
export const EXPIRY_BUFFER_MS = 5 * 60 * 1000

export type FetchFn = typeof fetch

const API_HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
  'anthropic-version': '2023-06-01',
  'User-Agent': 'claude-swapper/0.1',
  Accept: 'application/json',
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// -- credential JSON helpers ---------------------------------------------------

function oauthBlock(cred: string): Record<string, unknown> | null {
  let data: unknown
  try {
    data = JSON.parse(cred)
  } catch {
    return null
  }
  const block = isRecord(data) ? data.claudeAiOauth : null
  return isRecord(block) ? block : null
}

export function extractAccessToken(cred: string): string | null {
  const token = oauthBlock(cred)?.accessToken
  return typeof token === 'string' && token ? token : null
}

/** `expiresAt` in epoch milliseconds, or `null` when absent. */
export function extractExpiresAt(cred: string): number | null {
  const value = oauthBlock(cred)?.expiresAt
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

export function extractPlan(cred: string): string | null {
  const plan = oauthBlock(cred)?.subscriptionType
  return typeof plan === 'string' && plan ? plan : null
}

/** True when the access token expires within `bufferMs`; unknown expiry → false. */
export function isExpired(cred: string, bufferMs = EXPIRY_BUFFER_MS, nowMs = Date.now()): boolean {
  const expiresAt = extractExpiresAt(cred)
  if (expiresAt === null) return false
  return nowMs + bufferMs >= expiresAt
}

/**
 * Identity of a credential *lineage*: the refresh token survives access-token
 * rotation, so two generations of one login compare equal. Falls back to the
 * whole blob for credentials without a refresh token.
 */
export function credentialFingerprint(cred: string): string {
  const token = oauthBlock(cred)?.refreshToken
  if (typeof token === 'string' && token) {
    return 'sha256:' + createHash('sha256').update(token).digest('hex')
  }
  return 'sha256-full:' + createHash('sha256').update(cred ?? '').digest('hex')
}

// -- usage -----------------------------------------------------------------------

function window(key: string, label: string, pct: unknown, resetsAt: unknown): UsageWindow | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  return {
    key,
    label,
    pct: Math.round(pct * 10) / 10,
    resetsAt: typeof resetsAt === 'string' && resetsAt ? resetsAt : null,
  }
}

/**
 * Raw `/api/oauth/usage` → the normalized shape from the spec.
 *
 * Every model-scoped window in `limits` is emitted as `model:<name>` so the
 * dashboard can show them all; `model` only decides which one autoswap gates
 * on and is accepted here for symmetry with the other providers.
 */
export function normalizeUsage(raw: unknown, _model = 'Fable', plan: string | null = null): Usage {
  const r = isRecord(raw) ? raw : {}
  const windows: UsageWindow[] = []
  for (const [key, label] of [
    ['five_hour', '5-hour'],
    ['seven_day', 'Weekly'],
  ] as const) {
    const block = r[key]
    if (isRecord(block)) {
      const w = window(key, label, block.utilization, block.resets_at)
      if (w) windows.push(w)
    }
  }
  const limits = Array.isArray(r.limits) ? r.limits : []
  for (const lim of limits) {
    if (!isRecord(lim)) continue
    const scope = isRecord(lim.scope) ? lim.scope : null
    const modelScope = scope && isRecord(scope.model) ? scope.model : null
    const name = modelScope?.display_name
    if (typeof name !== 'string' || !name) continue
    const w = window(`model:${name.toLowerCase()}`, `${name} weekly`, lim.percent, lim.resets_at)
    if (w) windows.push(w)
  }
  return { fetchedAt: utcNowIso(), ok: true, error: null, windows, plan }
}

/** The normalized shape for a fetch that did not succeed (`ok: false`). */
export function failedUsage(error: string, plan: string | null = null): Usage {
  return { fetchedAt: utcNowIso(), ok: false, error, windows: [], plan }
}

export type UsageErrorKind = 'unauthorized' | 'rate_limited' | 'network' | 'server'

/** A usage / profile fetch failure, pre-classified so the daemon can pick a backoff. */
export class UsageError extends Error {
  kind: UsageErrorKind
  status?: number
  retryAfterMs?: number

  constructor(kind: UsageErrorKind, message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'UsageError'
    this.kind = kind
    if (extra.status !== undefined) this.status = extra.status
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/** Turn any thrown value into a `UsageError`; already-classified errors pass through. */
export function classifyUsageError(err: unknown): UsageError {
  if (err instanceof UsageError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new UsageError('network', message)
}

function usageErrorFromResponse(res: Response): UsageError {
  const status = res.status
  if (status === 401 || status === 403) return new UsageError('unauthorized', `HTTP ${status}`, { status })
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    return new UsageError('rate_limited', 'HTTP 429', { status, retryAfterMs })
  }
  return new UsageError('server', `HTTP ${status}`, { status })
}

async function getJson(url: string, accessToken: string, fetchFn: FetchFn): Promise<unknown> {
  let res: Response
  try {
    res = await fetchFn(url, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw classifyUsageError(err)
  }
  if (!res.ok) throw usageErrorFromResponse(res)
  try {
    return await res.json()
  } catch {
    throw new UsageError('server', 'malformed JSON response', { status: res.status })
  }
}

/** Raw usage payload; throws `UsageError` on any failure. */
export function fetchUsage(accessToken: string, fetchFn: FetchFn = fetch): Promise<unknown> {
  return getJson(USAGE_URL, accessToken, fetchFn)
}

/** Raw profile payload `{account: {...}, organization: {...}}`. */
export function fetchProfile(accessToken: string, fetchFn: FetchFn = fetch): Promise<unknown> {
  return getJson(PROFILE_URL, accessToken, fetchFn)
}

export interface Identity {
  email: string
  orgName: string
  orgUuid: string
  accountUuid: string
}

/** `/api/oauth/profile` payload → our identity (empty strings when missing). */
export function identityFromProfile(profile: unknown): Identity {
  const p = isRecord(profile) ? profile : {}
  const account = isRecord(p.account) ? p.account : {}
  const org = isRecord(p.organization) ? p.organization : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    email: str(account.email) || str(account.email_address),
    orgUuid: str(org.uuid),
    orgName: str(org.name),
    accountUuid: str(account.uuid),
  }
}

// -- refresh ---------------------------------------------------------------------

export type RefreshError = 'invalid_grant' | 'no_refresh_token' | 'transient'

/**
 * `error` is `null` (success), `invalid_grant` (dead lineage: re-login),
 * `no_refresh_token` (nothing to refresh with) or `transient` (retry later).
 */
export interface RefreshResult {
  credentials: string | null
  error: RefreshError | null
}

async function postJson(url: string, body: unknown, fetchFn: FetchFn): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': API_HEADERS['User-Agent'], Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

/** Merge a token-endpoint response into (a copy of) the credential JSON. */
export function applyTokenResponse(cred: string | null, resp: unknown, nowMs = Date.now()): string {
  if (!isRecord(resp) || typeof resp.access_token !== 'string' || !resp.access_token) {
    throw new Error('token response has no access_token')
  }
  let data: Record<string, unknown> = {}
  if (cred) {
    const parsed: unknown = JSON.parse(cred)
    if (isRecord(parsed)) data = parsed
  }
  const block: Record<string, unknown> = isRecord(data.claudeAiOauth) ? { ...data.claudeAiOauth } : {}
  block.accessToken = resp.access_token
  const expiresIn = typeof resp.expires_in === 'number' ? resp.expires_in : 0
  block.expiresAt = nowMs + Math.trunc(expiresIn) * 1000
  if (typeof resp.refresh_token === 'string' && resp.refresh_token) block.refreshToken = resp.refresh_token
  if (typeof resp.scope === 'string' && resp.scope) block.scopes = resp.scope.split(/\s+/).filter(Boolean)
  data.claudeAiOauth = block
  return JSON.stringify(data)
}

/**
 * Rotate an *inactive* account's token. Never call this for the active account;
 * Claude Code owns that one and would race us.
 */
export async function refreshCredentials(cred: string, fetchFn: FetchFn = fetch): Promise<RefreshResult> {
  const block = oauthBlock(cred)
  if (block === null) return { credentials: null, error: 'transient' } // torn read is likelier than a real shape change
  const refreshToken = block.refreshToken
  if (typeof refreshToken !== 'string' || !refreshToken) return { credentials: null, error: 'no_refresh_token' }
  let res: Response
  try {
    res = await postJson(REFRESH_URL, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }, fetchFn)
  } catch {
    return { credentials: null, error: 'transient' }
  }
  if (!res.ok) {
    if ([400, 401, 403].includes(res.status)) {
      let err: unknown = null
      try {
        const body: unknown = JSON.parse(await res.text())
        err = isRecord(body) ? body.error : null
      } catch {
        err = null
      }
      if (err === 'invalid_grant') return { credentials: null, error: 'invalid_grant' }
    }
    return { credentials: null, error: 'transient' }
  }
  try {
    return { credentials: applyTokenResponse(cred, await res.json()), error: null }
  } catch {
    return { credentials: null, error: 'transient' }
  }
}

// -- PKCE login ------------------------------------------------------------------

const b64url = (data: Buffer): string => data.toString('base64url')

export function redirectUri(port = LOGIN_PORT): string {
  return `http://localhost:${port}/callback`
}

export function authorizeUrl(verifier: string, state: string, port = LOGIN_PORT): string {
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const query = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(port),
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${AUTHORIZE_URL}?${query.toString()}`
}

/** Trade an authorization code for a fresh `claudeAiOauth` credential JSON. */
export async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
  fetchFn: FetchFn = fetch,
  port = LOGIN_PORT,
): Promise<string> {
  const res = await postJson(
    EXCHANGE_URL,
    {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: redirectUri(port),
      code_verifier: verifier,
    },
    fetchFn,
  )
  if (!res.ok) throw new Error(`token exchange returned HTTP ${res.status}`)
  return applyTokenResponse(null, await res.json())
}

const DONE_HTML =
  "<html><body style='font-family:system-ui'><h2>Signed in.</h2>You can close this tab and return to Session Manager.</body></html>"
const FAIL_HTML =
  "<html><body style='font-family:system-ui'><h2>Login failed.</h2>Return to Session Manager and try again.</body></html>"

export interface LoginFlowOptions {
  fetchFn?: FetchFn
  /** Opens the authorize URL in the user's browser once the callback server is listening. */
  openUrl: (url: string) => void
  port?: number
  timeoutMs?: number
}

export interface LoginFlowStatus {
  status: LoginPhase
  credential?: string
  error?: string
}

export interface LoginFlow {
  id: string
  url: string
  status(): LoginFlowStatus
  /** Resolves with the credential JSON; rejects on error, cancel or timeout. */
  promise: Promise<string>
  cancel(reason?: string): void
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * One browser login: authorize URL → local callback → token exchange.
 *
 * The callback server is one-shot on `127.0.0.1:<port>` (the redirect URI
 * Anthropic registered for Claude Code's client id). The browser is opened only
 * after the server is listening so the redirect can never race the bind.
 */
export function startLoginFlow(opts: LoginFlowOptions): LoginFlow {
  const fetchFn = opts.fetchFn ?? fetch
  const port = opts.port ?? LOGIN_PORT
  const timeoutMs = opts.timeoutMs ?? 300_000
  const verifier = b64url(randomBytes(32))
  const state = b64url(randomBytes(32))
  const id = randomUUID()
  const url = authorizeUrl(verifier, state, port)

  let status: LoginFlowStatus = { status: 'pending' }
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  let resolvePromise!: (cred: string) => void
  let rejectPromise!: (err: Error) => void
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  promise.catch(() => {}) // the flow's own status() reports errors; no unhandled rejection

  const finish = (credential: string | null, error: string | null): void => {
    if (status.status !== 'pending') return
    status = credential ? { status: 'done', credential } : { status: 'error', error: error ?? 'login failed' }
    if (timer) clearTimeout(timer)
    if (server) {
      server.close()
      server = null
    }
    if (credential) resolvePromise(credential)
    else rejectPromise(new Error(status.error))
  }

  /**
   * Validate state and exchange the code; returns success for the HTML reply.
   *
   * The port is reachable by every local process and, via a cross-origin GET,
   * by any web page open in the browser. A request that does not carry *our*
   * state therefore gets a 400 and is otherwise ignored: it must be able
   * neither to complete the login nor to abort it. Only the first matching
   * callback is exchanged; later ones (a reloaded tab) are refused.
   */
  let exchanging = false
  const handleCallback = async (query: URLSearchParams): Promise<boolean> => {
    if (status.status !== 'pending' || exchanging) return false
    const gotState = query.get('state') ?? ''
    if (!safeEqual(gotState, state)) return false
    if (query.has('error')) {
      finish(null, query.get('error_description') || query.get('error') || 'login denied')
      return false
    }
    const code = query.get('code') ?? ''
    if (!code) return false
    exchanging = true
    try {
      finish(await exchangeCode(code, state, verifier, fetchFn, port), null)
      return true
    } catch (err) {
      finish(null, `token exchange failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  server = createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (parsed.pathname !== '/callback' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end()
      return
    }
    void handleCallback(parsed.searchParams).then((ok) => {
      const body = ok ? DONE_HTML : FAIL_HTML
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    })
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    finish(null, `cannot listen on port ${port}: ${err.code ?? err.message}`)
  })
  server.listen(port, '127.0.0.1', () => {
    timer = setTimeout(() => finish(null, 'login timed out'), timeoutMs)
    timer.unref()
    try {
      opts.openUrl(url)
    } catch (err) {
      finish(null, `could not open browser: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return {
    id,
    url,
    status: () => status,
    promise,
    cancel: (reason = 'login cancelled') => finish(null, reason),
  }
}
