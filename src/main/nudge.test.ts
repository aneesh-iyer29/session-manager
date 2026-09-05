import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NudgeFlag } from '../shared/types'
import { clearFlag, flagPath, hookScriptStale, installHook, isHookInstalled, readFlag, uninstallHook, writeFlag } from './nudge'

let dir: string
let settingsPath: string
let scriptPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-'))
  settingsPath = join(dir, 'claude', 'settings.json')
  scriptPath = join(dir, 'claude', 'hooks', 'session-manager-nudge.sh')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const flag: NudgeFlag = {
  id: 'acc_1:model:fable:2026-09-08T10:00:00Z',
  at: '2026-09-04T18:00:00Z',
  accountId: 'acc_1',
  label: 'work',
  window: 'Fable weekly',
  pct: 84,
  message: 'work is at 84% of Fable weekly and will be swapped at 90%.',
}

describe('flag file', () => {
  it('writes text and json twins and reads back', () => {
    writeFlag(flag, 'block', dir)
    expect(readFileSync(flagPath(dir), 'utf8')).toBe(`${flag.id}\nblock\n${flag.message}\n`)
    expect(readFlag(dir)).toEqual(flag)
    clearFlag(dir)
    expect(existsSync(flagPath(dir))).toBe(false)
    expect(readFlag(dir)).toBeNull()
  })

  it('resets the nudged marker only when the episode id changes', () => {
    writeFlag(flag, 'block', dir)
    writeFileSync(join(dir, 'swap-pending.nudged'), flag.id)
    writeFlag({ ...flag, pct: 86 }, 'block', dir)
    expect(existsSync(join(dir, 'swap-pending.nudged'))).toBe(true)
    writeFlag({ ...flag, id: 'acc_2:five_hour:x' }, 'block', dir)
    expect(existsSync(join(dir, 'swap-pending.nudged'))).toBe(false)
  })
})

describe('hook installer', () => {
  it('registers once, preserves other settings, and removes only itself', () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }], Stop: [{ hooks: [] }] },
      }),
    )
    installHook(settingsPath, scriptPath)
    installHook(settingsPath, scriptPath)
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.model).toBe('opus')
    expect(after.hooks.Stop).toEqual([{ hooks: [] }])
    expect(after.hooks.UserPromptSubmit).toHaveLength(2)
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo theirs')
    expect(after.hooks.UserPromptSubmit[1].hooks[0].command).toContain('session-manager-nudge.sh')
    expect(isHookInstalled(settingsPath, scriptPath)).toBe(true)
    expect(hookScriptStale(scriptPath)).toBe(false)

    uninstallHook(settingsPath, scriptPath)
    const gone = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(gone.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'echo theirs' }] }])
    expect(existsSync(scriptPath)).toBe(false)
    expect(isHookInstalled(settingsPath, scriptPath)).toBe(false)
  })

  it('creates settings.json when absent and drops the hooks key on uninstall', () => {
    installHook(settingsPath, scriptPath)
    expect(isHookInstalled(settingsPath, scriptPath)).toBe(true)
    uninstallHook(settingsPath, scriptPath)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({})
  })

  it('refuses to touch an unparsable settings.json', () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(settingsPath, '{ not json')
    expect(() => installHook(settingsPath, scriptPath)).toThrow(/not a JSON object|JSON/)
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json')
    expect(existsSync(scriptPath)).toBe(false)
  })
})

describe('hook script', () => {
  const run = () => spawnSync('/bin/bash', [scriptPath], { env: { ...process.env, CLAUDE_SWAPPER_HOME: dir }, input: '{}', encoding: 'utf8' })

  it('is silent with no flag', () => {
    installHook(settingsPath, scriptPath)
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('blocks the first prompt of an episode, then only adds context', () => {
    installHook(settingsPath, scriptPath)
    writeFlag(flag, 'block', dir)
    const first = run()
    expect(first.status).toBe(2)
    expect(first.stderr).toContain('Run /compact now')
    expect(first.stderr).toContain(flag.message)
    const second = run()
    expect(second.status).toBe(0)
    const out = JSON.parse(second.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(out.hookSpecificOutput.additionalContext).toContain(flag.message)
  })

  it('never blocks in context mode and escapes quotes', () => {
    installHook(settingsPath, scriptPath)
    writeFlag({ ...flag, message: 'say "hi" \\ done' }, 'context', dir)
    const r = run()
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.additionalContext).toContain('say "hi" \\ done')
  })

  it('is executable', () => {
    installHook(settingsPath, scriptPath)
    expect(execFileSync(scriptPath, { env: { ...process.env, CLAUDE_SWAPPER_HOME: dir }, encoding: 'utf8' })).toBe('')
  })
})
