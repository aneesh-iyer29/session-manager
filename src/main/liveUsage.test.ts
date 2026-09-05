import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFeed, isFeedInstalled, livePath, readLive, uninstallFeed } from './liveUsage'

let dir: string
let settingsPath: string
let scriptPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-'))
  settingsPath = join(dir, 'claude', 'settings.json')
  scriptPath = join(dir, 'claude', 'hooks', 'session-manager-statusline.sh')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sample = {
  model: { id: 'claude-fable-5-1', display_name: 'Fable' },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } },
}

describe('readLive', () => {
  it('parses both windows with ISO reset times and clamps', () => {
    writeFileSync(livePath(dir), JSON.stringify({ rate_limits: { ...sample.rate_limits, five_hour: { used_percentage: 123, resets_at: 1738425600 } } }))
    const live = readLive(dir, new Date())
    expect(live?.windows).toEqual([
      { key: 'five_hour', label: '5-hour', pct: 100, resetsAt: '2025-02-01T16:00:00.000Z' },
      { key: 'seven_day', label: 'Weekly', pct: 41.2, resetsAt: '2025-02-06T16:00:00.000Z' },
    ])
  })

  it('returns null when missing, stale, torn, or without rate limits', () => {
    expect(readLive(dir)).toBeNull()
    writeFileSync(livePath(dir), '{"model":{}}')
    expect(readLive(dir)).toBeNull()
    writeFileSync(livePath(dir), '{ torn')
    expect(readLive(dir)).toBeNull()
    writeFileSync(livePath(dir), JSON.stringify(sample))
    const old = new Date(Date.now() - 7 * 60 * 60_000)
    utimesSync(livePath(dir), old, old)
    expect(readLive(dir, new Date())).toBeNull()
    utimesSync(livePath(dir), new Date(), new Date())
    expect(readLive(dir, new Date())?.windows).toHaveLength(2)
  })
})

describe('installer', () => {
  it('installs, chains an existing status line, and restores it on uninstall', () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'echo mine', padding: 1 } }))
    installFeed(settingsPath, scriptPath, dir)
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.model).toBe('opus')
    expect(after.statusLine.command).toContain('session-manager-statusline.sh')
    expect(JSON.parse(readFileSync(join(dir, 'statusline-chain.json'), 'utf8'))).toEqual({ type: 'command', command: 'echo mine', padding: 1 })
    expect(isFeedInstalled(settingsPath, scriptPath)).toBe(true)
    // Idempotent: a second install must not overwrite the chain with our own entry.
    installFeed(settingsPath, scriptPath, dir)
    expect(JSON.parse(readFileSync(join(dir, 'statusline-chain.json'), 'utf8')).command).toBe('echo mine')

    uninstallFeed(settingsPath, scriptPath, dir)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine).toEqual({ type: 'command', command: 'echo mine', padding: 1 })
    expect(existsSync(scriptPath)).toBe(false)
    expect(isFeedInstalled(settingsPath, scriptPath)).toBe(false)
  })

  it('removes the key entirely when there was no status line before', () => {
    installFeed(settingsPath, scriptPath, dir)
    uninstallFeed(settingsPath, scriptPath, dir)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({})
  })

  it('refuses an unparsable settings file', () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(settingsPath, 'nope')
    expect(() => installFeed(settingsPath, scriptPath, dir)).toThrow()
    expect(existsSync(scriptPath)).toBe(false)
  })
})

describe('script', () => {
  const run = (input: string) =>
    spawnSync('/bin/bash', [scriptPath], { env: { ...process.env, SESSION_MANAGER_HOME: dir }, input, encoding: 'utf8' })

  it('copies stdin atomically and prints a usage line', () => {
    installFeed(settingsPath, scriptPath, dir)
    const r = run(JSON.stringify(sample))
    expect(r.status).toBe(0)
    expect(JSON.parse(readFileSync(livePath(dir), 'utf8'))).toEqual(sample)
    expect(existsSync(join(dir, 'statusline.json.tmp'))).toBe(false)
    expect(r.stdout.trim()).toMatch(/^Session Manager( · 5h 23% · 7d 41%)?$/)
  })

  it('runs a chained status line with the same stdin', () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: "sed -n 's/.*display_name\":\"\\([^\"]*\\)\".*/model=\\1/p'" } }))
    installFeed(settingsPath, scriptPath, dir)
    const r = run(JSON.stringify(sample))
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('model=Fable')
    expect(readLive(dir)?.windows).toHaveLength(2)
  })
})
