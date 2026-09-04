/**
 * Cooperate with Claude Code's own advisory locks while we touch its files.
 *
 * Claude Code uses npm `proper-lockfile`: the lock is a *directory* (mkdir is
 * the mutex), a live holder touches its mtime every 5 s, and a lock older than
 * the staleness window may be removed by a waiter. The credential refresh path
 * takes two locks in order — `<config-home>/.oauth_refresh.lock` then the
 * legacy `<config-home>.lock` — with 60 s staleness; `~/.claude.json.lock`
 * keeps the older 10 s default.
 *
 * Holding these while swapping closes the only real race: Claude Code reading
 * the old credential, refreshing it over the network, and writing it back on
 * top of the account we just installed.
 */
import { mkdirSync, rmdirSync, statSync, utimesSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { claudeConfigHome, claudeGlobalConfig } from './paths'

export const CREDENTIALS_STALENESS_MS = 60_000
export const CONFIG_STALENESS_MS = 10_000
export const TOUCH_INTERVAL_MS = 3_000 // a little faster than Claude Code's 5 s for margin
export const DEFAULT_TIMEOUT_MS = 9_000 // per lock; Claude Code retries its own acquire ~5x1-2 s

export class LockTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockTimeout'
  }
}

export interface LockOptions {
  /** How long to wait for the lock before giving up. */
  timeoutMs?: number
  /** Override the per-lock staleness window (tests). */
  stalenessMs?: number
  /** Override the keep-alive cadence (tests). */
  touchIntervalMs?: number
}

export function oauthRefreshLockDir(): string {
  return join(claudeConfigHome(), '.oauth_refresh.lock')
}

export function credentialsLockDir(): string {
  const home = claudeConfigHome()
  return join(dirname(home), basename(home) + '.lock')
}

export function configLockDir(): string {
  const cfg = claudeGlobalConfig()
  return join(dirname(cfg), basename(cfg) + '.lock')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

/**
 * Run `fn` while holding a proper-lockfile-compatible directory lock.
 *
 * Waits up to `timeoutMs`, takes over a lock whose mtime is older than
 * `stalenessMs`, keeps our own mtime fresh while held, and removes it on exit.
 */
export async function withProperLockfile<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  opts: LockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stalenessMs = opts.stalenessMs ?? CONFIG_STALENESS_MS
  const touchIntervalMs = opts.touchIntervalMs ?? TOUCH_INTERVAL_MS
  mkdirSync(dirname(lockDir), { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err
    }
    if (Date.now() - start > timeoutMs) {
      throw new LockTimeout(
        `could not acquire ${basename(lockDir)}; Claude Code may be refreshing credentials`,
      )
    }
    let heldMtime: number
    try {
      heldMtime = statSync(lockDir).mtimeMs
    } catch {
      continue // released between mkdir and stat; retry immediately
    }
    if (Date.now() - heldMtime > stalenessMs) {
      try {
        rmdirSync(lockDir) // dead holder; losing this race just loops again
      } catch {
        await sleep(50)
      }
      continue
    }
    await sleep(100 + Math.random() * 200)
  }

  const toucher = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(lockDir, now, now)
    } catch {
      clearInterval(toucher) // stolen or removed; nothing left to keep alive
    }
  }, touchIntervalMs)
  toucher.unref()
  try {
    return await fn()
  } finally {
    clearInterval(toucher)
    try {
      rmdirSync(lockDir)
    } catch {
      // already taken over as stale; nothing to release
    }
  }
}

/** Hold both credential locks in Claude Code's order (no deadlock against it). */
export function withCredentialsLock<T>(fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const o = { stalenessMs: CREDENTIALS_STALENESS_MS, ...opts }
  return withProperLockfile(oauthRefreshLockDir(), () => withProperLockfile(credentialsLockDir(), fn, o), o)
}

/** Hold the `~/.claude.json.lock` guarding the global config file. */
export function withConfigLock<T>(fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  return withProperLockfile(configLockDir(), fn, { stalenessMs: CONFIG_STALENESS_MS, ...opts })
}
