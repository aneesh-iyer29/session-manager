/**
 * Shared data model. This file is the contract between the main process, the
 * preload bridge, and the renderer. Every process imports from here and nobody
 * redefines these shapes. Keep it dependency-free.
 */

/** One rate-limit window as reported by a provider, normalized. `pct` is 0-100 used. */
export interface UsageWindow {
  /** `five_hour`, `seven_day`, or `model:<display name lowercased>` (e.g. `model:fable`). */
  key: string
  /** Human label: "5-hour", "Weekly", "Fable weekly". */
  label: string
  pct: number
  /** ISO timestamp when the window resets, or null when unknown. */
  resetsAt: string | null
  /** True when projected from another window rather than reported (see the Fable estimate). */
  estimated?: boolean
}

export interface Usage {
  fetchedAt: string
  ok: boolean
  /** Short, secret-free error description when `ok` is false. */
  error: string | null
  windows: UsageWindow[]
  /** Subscription tier as reported by the provider ("max", "pro", ...), if known. */
  plan: string | null
}

export type TokenStatus = 'ok' | 'expired' | 'dead' | 'unknown'

export interface Account {
  /** Stable id like `acc_3`. */
  id: string
  email: string
  alias: string
  orgName: string
  orgUuid: string
  accountUuid: string
  plan: string | null
  /** True when this account's credential is the one Claude Code is using right now. */
  active: boolean
  /** Held out of auto-rotation. Still a valid manual switch target. */
  disabled: boolean
  addedAt: string
  tokenStatus: TokenStatus
  usage: Usage | null
  /** 100 - max(pct of gating windows), or null when usage is unknown. */
  headroom: number | null
  /** Key of the gating window with the least headroom, or null. */
  bindingWindow: string | null
}

export type CodexMode = 'chatgpt' | 'apikey' | 'none'

export interface CodexState {
  configured: boolean
  mode: CodexMode
  email: string | null
  plan: string | null
  usage: Usage | null
}

export type Strategy = 'best' | 'consume_first'

export interface Settings {
  autoswapEnabled: boolean
  dryRun: boolean
  /** 50-100. An account is "near limit" when any gating window reaches this. */
  threshold: number
  /** 0-50. A switch target must beat the active account's headroom by this much. */
  margin: number
  /** >= 0. Minimum seconds between automatic switches. */
  cooldownSeconds: number
  /** >= 15. The active account is fetched at most every 5 minutes; standby accounts every 10 unless near the threshold. The usage endpoint allows ~30 requests an hour per token. */
  pollIntervalSeconds: number
  strategy: Strategy
  /** Display name of the per-model weekly window that gates swapping. Default "Fable". */
  model: string
  codexEnabled: boolean
  notify: boolean
  launchAtLogin: boolean
  showInDock: boolean
  /** 50-100. Below `threshold`. The compact nudge flag is raised when the active account's gating window reaches this. */
  warnPct: number
  /** `block`: the Claude Code hook stops the first prompt after the flag with a message; `context`: it only tells Claude. */
  nudgeMode: NudgeMode
}

export type NudgeMode = 'block' | 'context'

/** Raised while the active account is near its swap line; consumed by the Claude Code hook. */
export interface NudgeFlag {
  /** Stable for one episode (account + window + reset), so the hook blocks at most once per episode. */
  id: string
  at: string
  accountId: string
  /** Alias or email of the account. */
  label: string
  /** Window label, e.g. "Fable weekly". */
  window: string
  pct: number
  message: string
}

/** The Claude Code status line feed: live 5-hour / weekly usage for the active account. */
export interface LiveFeedState {
  /** Whether our status line script is registered in ~/.claude/settings.json. */
  installed: boolean
  /** When Claude Code last wrote usage, or null. */
  lastAt: string | null
}

export interface NudgeState {
  /** Whether the UserPromptSubmit hook is present in ~/.claude/settings.json. */
  hookInstalled: boolean
  pending: NudgeFlag | null
}

export type DecisionAction = 'stay' | 'switch' | 'blocked'

export interface Decision {
  action: DecisionAction
  targetId: string | null
  reason: string
  at: string
}

export type EventKind = 'switch' | 'autoswap' | 'error' | 'login' | 'capture' | 'info'

export interface SwapperEvent {
  id: string
  at: string
  kind: EventKind
  message: string
  accountId: string | null
}

export interface AppState {
  version: string
  now: string
  activeId: string | null
  polling: {
    lastPollAt: string | null
    nextPollAt: string | null
    inFlight: boolean
  }
  autoswap: {
    lastDecision: Decision | null
    lastSwitchAt: string | null
  }
  settings: Settings
  accounts: Account[]
  codex: CodexState
  nudge: NudgeState
  liveFeed: LiveFeedState
  /** Newest first, at most 100. */
  events: SwapperEvent[]
}

export type LoginPhase = 'pending' | 'done' | 'error'

export interface LoginStatus {
  id: string
  status: LoginPhase
  /** Authorize URL; the main process also opens it in the default browser. */
  url: string
  account?: Account
  error?: string
}

export const DEFAULT_SETTINGS: Settings = {
  autoswapEnabled: false,
  dryRun: false,
  threshold: 90,
  margin: 10,
  cooldownSeconds: 300,
  pollIntervalSeconds: 300,
  strategy: 'best',
  model: 'Fable',
  codexEnabled: true,
  notify: true,
  launchAtLogin: false,
  showInDock: true,
  warnPct: 80,
  nudgeMode: 'block',
}
