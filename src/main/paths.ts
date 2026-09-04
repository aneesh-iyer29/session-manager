/**
 * Every filesystem path the app touches, resolved in one place.
 *
 * Functions read the environment at *call* time so tests can redirect the whole
 * app into a temp directory with `CLAUDE_SWAPPER_HOME`, `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME` and `HOME`. This module never imports electron: the shell
 * injects the userData directory through `setDataDir` at startup so every other
 * main-process module (and every test) can import paths without an Electron
 * runtime.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let injectedDataDir: string | null = null

/** Called once by index.ts with `app.getPath('userData')`; tests leave it unset. */
export function setDataDir(dir: string | null): void {
  injectedDataDir = dir
}

/** Our own state directory. `CLAUDE_SWAPPER_HOME` wins so tests never see real data. */
export function dataDir(): string {
  const env = process.env.CLAUDE_SWAPPER_HOME
  if (env) return env
  if (injectedDataDir) return injectedDataDir
  return join(homedir(), 'Library', 'Application Support', 'Claude Swapper')
}

/** Claude Code's config directory (`$CLAUDE_CONFIG_DIR` or `~/.claude`). */
export function claudeConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * Claude Code's global config (`~/.claude.json`) holding `oauthAccount`.
 *
 * Claude Code keeps this file *next to* the config home, not inside it, and
 * moves it along when `CLAUDE_CONFIG_DIR` is set. A legacy
 * `<config-home>/.config.json` wins when it still exists.
 */
export function claudeGlobalConfig(): string {
  const legacy = join(claudeConfigHome(), '.config.json')
  if (existsSync(legacy)) return legacy
  const base = process.env.CLAUDE_CONFIG_DIR || homedir()
  return join(base, '.claude.json')
}

/** Codex CLI login file (`$CODEX_HOME/auth.json` or `~/.codex/auth.json`). */
export function codexAuthPath(): string {
  const base = process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(base, 'auth.json')
}

export function settingsPath(): string {
  return join(dataDir(), 'settings.json')
}

export function accountsPath(): string {
  return join(dataDir(), 'accounts.json')
}

export function usagePath(): string {
  return join(dataDir(), 'usage.json')
}

export function statePath(): string {
  return join(dataDir(), 'state.json')
}

export function eventsPath(): string {
  return join(dataDir(), 'events.jsonl')
}

export function credentialsDir(): string {
  return join(dataDir(), 'credentials')
}
