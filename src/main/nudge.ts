/**
 * Compact nudge: the bridge between Session Manager and a running Claude Code.
 *
 * Nothing outside Claude Code can trigger a compaction, but a UserPromptSubmit
 * hook can stop one prompt with a message, or hand Claude extra context. So the
 * daemon raises a small flag file when the active account nears its swap line,
 * and a hook script we install into ~/.claude reads it on every prompt. The
 * user compacts before the swap instead of paying a full re-cache afterwards.
 *
 * The flag is plain text (id, mode, message) so the hook needs only bash.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NudgeFlag, NudgeMode } from '../shared/types'
import { dataDir } from './paths'
import { atomicWrite } from './store'

export const HOOK_SCRIPT_NAME = 'session-manager-nudge.sh'
/** Substring the installer uses to recognise its own entry in settings.json. */
export const HOOK_MARKER = HOOK_SCRIPT_NAME

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

export function hookScriptPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'hooks', HOOK_SCRIPT_NAME)
}

export function flagPath(dir = dataDir()): string {
  return join(dir, 'swap-pending.txt')
}

export function flagJsonPath(dir = dataDir()): string {
  return join(dir, 'swap-pending.json')
}

function nudgedPath(dir: string): string {
  return join(dir, 'swap-pending.nudged')
}

/** Write both the bash-friendly flag and a JSON twin for the UI; a new id resets the once-per-episode marker. */
export function writeFlag(flag: NudgeFlag, mode: NudgeMode, dir = dataDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const previous = readFlag(dir)
  if (previous && previous.id !== flag.id) rmSync(nudgedPath(dir), { force: true })
  const text = `${flag.id}\n${mode}\n${flag.message.replace(/\r?\n/g, ' ')}\n`
  atomicWrite(flagPath(dir), text)
  atomicWrite(flagJsonPath(dir), JSON.stringify(flag, null, 2))
}

export function clearFlag(dir = dataDir()): void {
  rmSync(flagPath(dir), { force: true })
  rmSync(flagJsonPath(dir), { force: true })
  rmSync(nudgedPath(dir), { force: true })
}

export function readFlag(dir = dataDir()): NudgeFlag | null {
  try {
    const raw = JSON.parse(readFileSync(flagJsonPath(dir), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const f = raw as Record<string, unknown>
    if (typeof f.id !== 'string' || typeof f.message !== 'string') return null
    return raw as NudgeFlag
  } catch {
    return null
  }
}

/**
 * The hook itself. Kept dependency-free (bash + sed) because it runs inside
 * whatever shell Claude Code spawns. `block` mode stops the first prompt of an
 * episode and erases it; every later prompt (and `context` mode always) only
 * adds context so Claude can mention it without getting in the way.
 */
export const HOOK_SCRIPT = `#!/bin/bash
# Session Manager compact nudge. Installed by Session Manager; safe to delete.
# Claude Code UserPromptSubmit hook: when the app has raised a swap-pending flag
# (the active account is near its auto-swap line), ask for a /compact first so
# the conversation is not re-cached in full on the next account.
dir="\${SESSION_MANAGER_HOME:-$HOME/Library/Application Support/Session Manager}"
flag="$dir/swap-pending.txt"
[ -f "$flag" ] || exit 0
{ IFS= read -r id; IFS= read -r mode; msg="$(cat)"; } < "$flag"
[ -n "$id" ] || exit 0
nudged="$dir/swap-pending.nudged"
last=""
[ -f "$nudged" ] && last="$(cat "$nudged")"
if [ "$mode" = "block" ] && [ "$last" != "$id" ]; then
  printf '%s\\n' "$id" > "$nudged"
  printf 'Session Manager: %s\\nRun /compact now, then send your message again.\\n' "$msg" >&2
  exit 2
fi
esc="$(printf '%s' "$msg" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')"
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Session Manager: %s The user has been asked to run /compact before continuing. If the task ahead is large, remind them once, briefly."}}\\n' "$esc"
exit 0
`

interface HookEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
}

function readSettingsForWrite(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path} is not a JSON object; not touching it`)
  }
  return raw as Record<string, unknown>
}

function entriesOf(settings: Record<string, unknown>): { hooks: Record<string, unknown>; list: HookEntry[] } {
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {}) as Record<string, unknown>
  const list = Array.isArray(hooks.UserPromptSubmit) ? (hooks.UserPromptSubmit as HookEntry[]) : []
  return { hooks, list }
}

function isOurs(entry: HookEntry): boolean {
  return Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER))
}

export function isHookInstalled(settingsPath = claudeSettingsPath(), scriptPath = hookScriptPath()): boolean {
  try {
    if (!existsSync(scriptPath)) return false
    const { list } = entriesOf(readSettingsForWrite(settingsPath))
    return list.some(isOurs)
  } catch {
    return false
  }
}

/**
 * Write the script (0755) and register it once. Every other key in
 * settings.json is preserved byte-for-byte in meaning; an unparsable file is
 * refused rather than overwritten.
 */
export function installHook(settingsPath = claudeSettingsPath(), scriptPath = hookScriptPath()): void {
  const settings = readSettingsForWrite(settingsPath)
  mkdirSync(join(scriptPath, '..'), { recursive: true })
  atomicWrite(scriptPath, HOOK_SCRIPT)
  chmodSync(scriptPath, 0o755)
  const { hooks, list } = entriesOf(settings)
  const command = `"${scriptPath}"`
  const entry: HookEntry = { hooks: [{ type: 'command', command }] }
  const next = list.filter((e) => !isOurs(e))
  next.push(entry)
  settings.hooks = { ...hooks, UserPromptSubmit: next }
  mkdirSync(join(settingsPath, '..'), { recursive: true })
  atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

export function uninstallHook(settingsPath = claudeSettingsPath(), scriptPath = hookScriptPath()): void {
  if (existsSync(settingsPath)) {
    const settings = readSettingsForWrite(settingsPath)
    const { hooks, list } = entriesOf(settings)
    const next = list.filter((e) => !isOurs(e))
    if (next.length !== list.length) {
      const nextHooks: Record<string, unknown> = { ...hooks }
      if (next.length) nextHooks.UserPromptSubmit = next
      else delete nextHooks.UserPromptSubmit
      if (Object.keys(nextHooks).length) settings.hooks = nextHooks
      else delete settings.hooks
      atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    }
  }
  rmSync(scriptPath, { force: true })
}

/** True when the script on disk is not the one this build would write (an older install). */
export function hookScriptStale(scriptPath = hookScriptPath()): boolean {
  try {
    statSync(scriptPath)
    return readFileSync(scriptPath, 'utf8') !== HOOK_SCRIPT
  } catch {
    return false
  }
}
