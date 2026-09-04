/**
 * Read / write Claude Code's *active* credential.
 *
 * macOS: the generic-password Keychain item Claude Code owns (service
 * `Claude Code-credentials`, account `$USER`), driven through the system
 * `/usr/bin/security` binary so creator == reader and macOS never prompts.
 * Elsewhere: `<config-home>/.credentials.json` (mode 0600), the file backend
 * Claude Code itself uses on Linux.
 *
 * Writes hex-encode the secret (`-X`) and feed the whole command to
 * `security -i` on stdin so the credential never appears in `argv`, where any
 * process on the machine could read it via `ps`.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

import { claudeConfigHome } from './paths'
import { atomicWrite } from './store'

export const SERVICE = 'Claude Code-credentials'
const SECURITY = '/usr/bin/security' // pinned: never let a PATH shim see secrets
const NOT_FOUND_RC = 44 // errSecItemNotFound
const TIMEOUT_MS = 5000 // a wedged / locked Keychain must not hang the daemon
/**
 * `security -i` reads lines with a 4096-byte buffer; a longer command would be
 * split mid-argument and corrupt the item. The only other route is argv, which
 * `ps` exposes to every local process, so an oversized credential is refused
 * outright instead. Real Claude Code credentials are ~1 KiB of hex.
 */
const STDIN_LINE_LIMIT = 4096 - 64

export class KeychainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeychainError'
  }
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string
  timeoutMs?: number
}

/** The only thing the Keychain layer needs from the OS; tests inject a fake. */
export type ExecFn = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>

/** Real `execFile` with stdin support; resolves on any exit code, rejects only on spawn failure / timeout. */
export const execFileAsync: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error.killed || (error as NodeJS.ErrnoException).code === 'ENOENT')) {
          reject(new KeychainError(error.killed ? `${args[0] ?? 'security'} timed out` : `cannot run ${file}`))
          return
        }
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    if (child.stdin) {
      if (options.input !== undefined) child.stdin.write(options.input)
      child.stdin.end()
    }
  })

/** Mirror Claude Code's `getUsername()`: `$USER`, then the pwd entry. */
export function accountName(): string {
  const user = process.env.USER
  if (user) return user
  try {
    return userInfo().username || 'claude-code-user'
  } catch {
    return 'claude-code-user'
  }
}

/** File backend location (Linux, or tests forcing the file path). */
export function credentialsFile(): string {
  return join(claudeConfigHome(), '.credentials.json')
}

/** Quote for `security -i`, which re-parses each stdin line shell-style. */
function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Return the active credential JSON, or `null` when nobody is logged in. */
export async function readActiveCredential(
  exec: ExecFn = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== 'darwin') {
    const path = credentialsFile()
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  const result = await exec(
    SECURITY,
    ['find-generic-password', '-a', accountName(), '-w', '-s', SERVICE],
    { timeoutMs: TIMEOUT_MS },
  )
  if (result.code === 0) {
    // `-w` appends exactly one newline; strip only that.
    return result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
  }
  if (result.code === NOT_FOUND_RC) return null
  throw new KeychainError(`find-generic-password failed (rc=${result.code}): ${result.stderr.trim()}`)
}

/** Create or replace (`-U`) the active credential. */
export async function writeActiveCredential(
  value: string,
  exec: ExecFn = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') {
    mkdirSync(claudeConfigHome(), { recursive: true, mode: 0o700 })
    atomicWrite(credentialsFile(), value, 0o600)
    return
  }
  const hexValue = Buffer.from(value, 'utf8').toString('hex')
  const command = `add-generic-password -U -a ${quote(accountName())} -s ${quote(SERVICE)} -X ${hexValue}\n`
  if (Buffer.byteLength(command) > STDIN_LINE_LIMIT) {
    throw new KeychainError(`credential too large to store safely (${value.length} chars); refusing to pass it via argv`)
  }
  const result = await exec(SECURITY, ['-i'], { input: command, timeoutMs: TIMEOUT_MS })
  if (result.code !== 0) {
    throw new KeychainError(`add-generic-password failed (rc=${result.code}): ${result.stderr.trim()}`)
  }
}

/** Remove the active credential; a missing item is not an error. */
export async function deleteActiveCredential(
  exec: ExecFn = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') {
    const path = credentialsFile()
    if (existsSync(path)) unlinkSync(path)
    return
  }
  const result = await exec(
    SECURITY,
    ['delete-generic-password', '-a', accountName(), '-s', SERVICE],
    { timeoutMs: TIMEOUT_MS },
  )
  if (result.code !== 0 && result.code !== NOT_FOUND_RC) {
    throw new KeychainError(`delete-generic-password failed (rc=${result.code}): ${result.stderr.trim()}`)
  }
}
