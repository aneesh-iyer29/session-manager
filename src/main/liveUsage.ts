/**
 * Live usage feed from Claude Code's status line.
 *
 * Claude Code passes its status line script a JSON document on stdin that
 * includes `rate_limits.five_hour` / `seven_day` (used percentage and reset
 * epoch), derived from the rate-limit headers on every API response. That is
 * the active account's usage for free: no request against the usage endpoint's
 * ~30/hour budget, and it updates the moment Claude Code does.
 *
 * The installed script only copies stdin to `<dataDir>/statusline.json`
 * atomically and prints a one-line status (chaining any status line the user
 * already had). The daemon parses the file; the script needs nothing but bash.
 * The per-model (Fable) window is not in the status line data, so the endpoint
 * is still polled for it, just far less often.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageWindow } from '../shared/types'
import { dataDir } from './paths'
import { atomicWrite } from './store'

export const FEED_SCRIPT_NAME = 'session-manager-statusline.sh'
export const LIVE_FILE = 'statusline.json'
/** Where the user's own status line command is kept while ours is installed. */
export const CHAIN_FILE = 'statusline-chain.json'
/** Live data older than this is ignored: the session that wrote it is long gone. */
export const LIVE_MAX_AGE_MS = 6 * 60 * 60_000

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

export function feedScriptPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'hooks', FEED_SCRIPT_NAME)
}

export function livePath(dir = dataDir()): string {
  return join(dir, LIVE_FILE)
}

export function chainPath(dir = dataDir()): string {
  return join(dir, CHAIN_FILE)
}

export interface LiveUsage {
  /** When Claude Code wrote it (file mtime). */
  at: Date
  windows: UsageWindow[]
}

function windowFrom(raw: unknown, key: 'five_hour' | 'seven_day'): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const pct = typeof w.used_percentage === 'number' && Number.isFinite(w.used_percentage) ? w.used_percentage : null
  if (pct === null) return null
  const resets = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null
  return { key, label: key === 'five_hour' ? '5-hour' : 'Weekly', pct: Math.max(0, Math.min(100, pct)), resetsAt: resets }
}

/** Parse the status line document; null when missing, stale, unparsable, or without rate limits. */
export function readLive(dir = dataDir(), now = new Date()): LiveUsage | null {
  const path = livePath(dir)
  let at: Date
  try {
    at = statSync(path).mtime
  } catch {
    return null
  }
  if (now.getTime() - at.getTime() > LIVE_MAX_AGE_MS) return null
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const limits = (doc as Record<string, unknown>).rate_limits
  if (!limits || typeof limits !== 'object') return null
  const l = limits as Record<string, unknown>
  const windows = [windowFrom(l.five_hour, 'five_hour'), windowFrom(l.seven_day, 'seven_day')].filter((w): w is UsageWindow => w !== null)
  if (windows.length === 0) return null
  return { at, windows }
}

/**
 * The status line script. Copies stdin to the live file (temp + rename so the
 * daemon never reads a torn write), then prints a status: the user's original
 * command if one was chained, else a compact usage line via jq or python3,
 * else nothing.
 */
export const FEED_SCRIPT = `#!/bin/bash
# Session Manager status line feed. Installed by Session Manager; safe to delete.
# Copies Claude Code's status line JSON (which carries rate_limits) to the app's
# data dir so the active account's usage updates without polling Anthropic.
dir="\${SESSION_MANAGER_HOME:-$HOME/Library/Application Support/Session Manager}"
input="$(cat)"
mkdir -p "$dir" 2>/dev/null
tmp="$dir/statusline.json.tmp.$$"
if printf '%s' "$input" > "$tmp" 2>/dev/null; then mv -f "$tmp" "$dir/statusline.json"; fi
chain="$dir/statusline-chain.json"
if [ -s "$chain" ]; then
  if command -v jq >/dev/null 2>&1; then
    cmd="$(jq -r '.command // empty' "$chain" 2>/dev/null)"
  elif command -v python3 >/dev/null 2>&1; then
    cmd="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("command",""))' "$chain" 2>/dev/null)"
  fi
  if [ -n "$cmd" ]; then printf '%s' "$input" | bash -c "$cmd"; exit 0; fi
fi
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$input" | jq -r '[ (.rate_limits.five_hour.used_percentage // null | if . == null then empty else "5h " + (.|floor|tostring) + "%" end), (.rate_limits.seven_day.used_percentage // null | if . == null then empty else "7d " + (.|floor|tostring) + "%" end) ] | if length == 0 then "Session Manager" else "Session Manager · " + join(" · ") end'
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$input" | python3 -c 'import json,sys
d=json.load(sys.stdin).get("rate_limits") or {}
parts=[f"{k} {int(d[w]["used_percentage"])}%" for w,k in (("five_hour","5h"),("seven_day","7d")) if isinstance(d.get(w),dict) and isinstance(d[w].get("used_percentage"),(int,float))]
print("Session Manager" + (" · " + " · ".join(parts) if parts else ""))'
fi
exit 0
`

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} is not a JSON object; not touching it`)
  return raw as Record<string, unknown>
}

function isOurs(statusLine: unknown): boolean {
  return !!statusLine && typeof statusLine === 'object' && typeof (statusLine as { command?: unknown }).command === 'string' && (statusLine as { command: string }).command.includes(FEED_SCRIPT_NAME)
}

export function isFeedInstalled(settingsPath = claudeSettingsPath(), scriptPath = feedScriptPath()): boolean {
  try {
    return existsSync(scriptPath) && isOurs(readSettings(settingsPath).statusLine)
  } catch {
    return false
  }
}

/**
 * Write the script and point `statusLine` at it. A status line the user already
 * had is kept in the chain file and run by our script with the same stdin, so
 * nothing they see changes; uninstall puts it back.
 */
export function installFeed(settingsPath = claudeSettingsPath(), scriptPath = feedScriptPath(), dir = dataDir()): void {
  const settings = readSettings(settingsPath)
  mkdirSync(join(scriptPath, '..'), { recursive: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWrite(scriptPath, FEED_SCRIPT)
  chmodSync(scriptPath, 0o755)
  const existing = settings.statusLine
  if (existing && typeof existing === 'object' && !isOurs(existing)) {
    atomicWrite(chainPath(dir), JSON.stringify(existing, null, 2))
  }
  settings.statusLine = { type: 'command', command: `"${scriptPath}"` }
  mkdirSync(join(settingsPath, '..'), { recursive: true })
  atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

export function uninstallFeed(settingsPath = claudeSettingsPath(), scriptPath = feedScriptPath(), dir = dataDir()): void {
  if (existsSync(settingsPath)) {
    const settings = readSettings(settingsPath)
    if (isOurs(settings.statusLine)) {
      let original: unknown = null
      try {
        original = JSON.parse(readFileSync(chainPath(dir), 'utf8'))
      } catch {
        original = null
      }
      if (original && typeof original === 'object') settings.statusLine = original
      else delete settings.statusLine
      atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    }
  }
  rmSync(scriptPath, { force: true })
  rmSync(chainPath(dir), { force: true })
  rmSync(livePath(dir), { force: true })
}
