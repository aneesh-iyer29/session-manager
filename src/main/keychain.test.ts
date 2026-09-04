import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KeychainError, SERVICE, deleteActiveCredential, readActiveCredential, writeActiveCredential, type ExecFn, type ExecOptions } from './keychain'

interface Call {
  file: string
  args: string[]
  options: ExecOptions
}

function fakeExec(result: { code: number; stdout?: string; stderr?: string }, calls: Call[]): ExecFn {
  return async (file, args, options) => {
    calls.push({ file, args, options })
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

const SECRET = '{"claudeAiOauth": {"accessToken": "super-secret", "refreshToken": "r"}}'
let savedUser: string | undefined

beforeEach(() => {
  savedUser = process.env.USER
  process.env.USER = 'tester'
})
afterEach(() => {
  if (savedUser === undefined) delete process.env.USER
  else process.env.USER = savedUser
})

describe('macOS Keychain via /usr/bin/security', () => {
  it('reads with find-generic-password and strips the trailing newline', async () => {
    const calls: Call[] = []
    const value = await readActiveCredential(fakeExec({ code: 0, stdout: SECRET + '\n' }, calls), 'darwin')
    expect(value).toBe(SECRET)
    expect(calls[0]!.file).toBe('/usr/bin/security')
    expect(calls[0]!.args).toEqual(['find-generic-password', '-a', 'tester', '-w', '-s', SERVICE])
    expect(calls[0]!.options.input).toBeUndefined()
  })

  it('maps exit code 44 to null and other failures to KeychainError', async () => {
    expect(await readActiveCredential(fakeExec({ code: 44 }, []), 'darwin')).toBeNull()
    await expect(readActiveCredential(fakeExec({ code: 1, stderr: 'locked' }, []), 'darwin')).rejects.toBeInstanceOf(KeychainError)
  })

  it('writes via security -i with the secret hex-encoded on stdin only', async () => {
    const calls: Call[] = []
    await writeActiveCredential(SECRET, fakeExec({ code: 0 }, calls), 'darwin')
    const call = calls[0]!
    expect(call.file).toBe('/usr/bin/security')
    expect(call.args).toEqual(['-i'])
    expect(call.options.input).toBe(`add-generic-password -U -a "tester" -s "${SERVICE}" -X ${Buffer.from(SECRET).toString('hex')}\n`)
    expect(JSON.stringify(call.args)).not.toContain('super-secret')
    expect(call.options.input).not.toContain('super-secret')
    expect(call.options.timeoutMs).toBe(5000)
  })

  it('refuses a credential that would overflow the stdin line rather than leak it via argv', async () => {
    const calls: Call[] = []
    const big = JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(3000) } })
    await expect(writeActiveCredential(big, fakeExec({ code: 0 }, calls), 'darwin')).rejects.toBeInstanceOf(KeychainError)
    expect(calls).toHaveLength(0) // security was never invoked, so nothing reached argv
    // Just under the limit still goes through stdin.
    const fits = JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(1900) } })
    await writeActiveCredential(fits, fakeExec({ code: 0 }, calls), 'darwin')
    expect(calls[0]!.args).toEqual(['-i'])
    expect(calls[0]!.options.input).toContain(Buffer.from(fits).toString('hex'))
  })

  it('surfaces write failures without echoing the secret', async () => {
    await expect(writeActiveCredential(SECRET, fakeExec({ code: 1, stderr: 'denied' }, []), 'darwin')).rejects.toThrow(/rc=1.*denied/)
    try {
      await writeActiveCredential(SECRET, fakeExec({ code: 1, stderr: 'denied' }, []), 'darwin')
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret')
    }
  })

  it('deletes with delete-generic-password and tolerates a missing item', async () => {
    const calls: Call[] = []
    await deleteActiveCredential(fakeExec({ code: 44 }, calls), 'darwin')
    expect(calls[0]!.args).toEqual(['delete-generic-password', '-a', 'tester', '-s', SERVICE])
    await expect(deleteActiveCredential(fakeExec({ code: 1 }, []), 'darwin')).rejects.toBeInstanceOf(KeychainError)
  })
})

describe('file backend on other platforms', () => {
  let home: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'swapper-keychain-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  })
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    rmSync(home, { recursive: true, force: true })
  })

  it('round-trips through .credentials.json with mode 0600 and never runs security', async () => {
    const exec: ExecFn = async () => {
      throw new Error('security must not run')
    }
    expect(await readActiveCredential(exec, 'linux')).toBeNull()
    await writeActiveCredential(SECRET, exec, 'linux')
    const path = join(home, '.claude', '.credentials.json')
    expect(readFileSync(path, 'utf8')).toBe(SECRET)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await readActiveCredential(exec, 'linux')).toBe(SECRET)
    await deleteActiveCredential(exec, 'linux')
    expect(existsSync(path)).toBe(false)
  })
})
