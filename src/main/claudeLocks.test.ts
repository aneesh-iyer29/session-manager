import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LockTimeout, withConfigLock, withCredentialsLock, withProperLockfile } from './claudeLocks'

let home: string
const env: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'swapper-locks-'))
  env.HOME = process.env.HOME
  env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
})
afterEach(() => {
  process.env.HOME = env.HOME
  if (env.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR
  rmSync(home, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory()

describe('withProperLockfile', () => {
  it('acquires and releases the lock directory', async () => {
    const lock = join(home, 'x.lock')
    const result = await withProperLockfile(lock, async () => {
      expect(isDir(lock)).toBe(true)
      return 42
    }, { timeoutMs: 1000 })
    expect(result).toBe(42)
    expect(existsSync(lock)).toBe(false)
  })

  it('releases even when the body throws, and is quiet when the lock was stolen', async () => {
    const lock = join(home, 'x.lock')
    await expect(withProperLockfile(lock, async () => {
      throw new Error('boom')
    }, { timeoutMs: 1000 })).rejects.toThrow('boom')
    expect(existsSync(lock)).toBe(false)
    await withProperLockfile(lock, async () => rmdirSync(lock), { timeoutMs: 1000 })
    expect(existsSync(lock)).toBe(false)
  })

  it('times out on a live lock without stealing it', async () => {
    const lock = join(home, 'held.lock')
    mkdirSync(lock) // fresh mtime: a live holder
    const start = Date.now()
    await expect(withProperLockfile(lock, async () => {}, { timeoutMs: 300, stalenessMs: 60_000 })).rejects.toBeInstanceOf(LockTimeout)
    expect(Date.now() - start).toBeGreaterThanOrEqual(290)
    expect(isDir(lock)).toBe(true)
  })

  it('takes over a stale lock', async () => {
    const lock = join(home, 'stale.lock')
    mkdirSync(lock)
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    await withProperLockfile(lock, async () => {
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(5000) // ours now, fresh mtime
    }, { timeoutMs: 1000, stalenessMs: 60_000 })
    expect(existsSync(lock)).toBe(false)
  })

  it('keeps touching the lock while held', async () => {
    const lock = join(home, 'touch.lock')
    await withProperLockfile(lock, async () => {
      const old = new Date(Date.now() - 30_000)
      utimesSync(lock, old, old)
      await sleep(300)
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(5000)
    }, { timeoutMs: 1000, touchIntervalMs: 50 })
  })
})

describe('Claude Code lock locations', () => {
  it('uses the config home for credential locks and the config file for the config lock', async () => {
    const configHome = join(home, '.claude')
    await withCredentialsLock(async () => {
      expect(isDir(join(configHome, '.oauth_refresh.lock'))).toBe(true)
      expect(isDir(join(home, '.claude.lock'))).toBe(true)
    }, { timeoutMs: 1000 })
    expect(existsSync(join(configHome, '.oauth_refresh.lock'))).toBe(false)
    expect(existsSync(join(home, '.claude.lock'))).toBe(false)
    await withConfigLock(async () => {
      expect(isDir(join(configHome, '.claude.json.lock'))).toBe(true)
    }, { timeoutMs: 1000 })
    expect(existsSync(join(configHome, '.claude.json.lock'))).toBe(false)
  })

  it('releases the first credential lock when the legacy lock is contended', async () => {
    mkdirSync(join(home, '.claude.lock'), { recursive: true })
    await expect(withCredentialsLock(async () => {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(LockTimeout)
    expect(existsSync(join(home, '.claude', '.oauth_refresh.lock'))).toBe(false)
  })
})
