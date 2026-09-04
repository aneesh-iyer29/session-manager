# Architecture

Claude Swapper is a macOS Electron app. It watches the usage limits of several Claude Code
accounts, swaps the active account before the Fable weekly (or 5-hour / weekly) limit bites,
and shows the one Codex account's quota read-only. It is deliberately narrow: **many Claude
accounts, one Codex account, one model family (Fable) that gates swapping.**

```
┌─────────────────────────── renderer (React) ───────────────────────────┐
│  window.swapper (typed SwapperApi from src/shared/ipc.ts)              │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ contextBridge + ipcRenderer.invoke
┌──────────────────────────────▼───────────────────────── main (Node) ───┐
│  ipc.ts        one ipcMain.handle per channel, pushes stateChanged     │
│  daemon.ts     poll loop, autoswap, event log, notifications           │
│  tray.ts       menu bar item: "<alias> 63%" + menu                     │
│  window.ts     BrowserWindow (hiddenInset title bar, vibrancy)         │
│                                                                        │
│  switcher.ts ──► keychain.ts (/usr/bin/security)  claudeLocks.ts       │
│              └─► ~/.claude.json oauthAccount                           │
│  claudeOauth.ts  usage / profile / refresh / PKCE login (port 54545)   │
│  codex.ts        ~/.codex/auth.json → wham/usage                       │
│  autoswap.ts     pure decision policy                                  │
│  store.ts        JSON files under userData, atomic writes, 0600        │
│  paths.ts        every path, honours CLAUDE_CONFIG_DIR                 │
└────────────────────────────────────────────────────────────────────────┘
```

## Source layout

```
src/shared/     types.ts (data model), ipc.ts (channels + SwapperApi)   ← the contract
src/main/       Electron main process (Node): everything that touches disk, Keychain, network
src/preload/    contextBridge exposing SwapperApi as window.swapper
src/renderer/   React UI; src/renderer/src/mock/ is a full in-memory backend for browser dev
build/          electron-builder resources (icon.icns, entitlements)
docs/           this file, USAGE.md
```

## Runtime layout

| Path | Purpose |
| --- | --- |
| `~/Library/Application Support/Claude Swapper/settings.json` | user settings |
| `.../accounts.json` | account metadata list (no secrets) |
| `.../credentials/<id>.json` | one credential blob per account, mode 0600 |
| `.../usage.json` | last usage snapshot per account |
| `.../state.json` | `activeId`, `lastSwitchAt`, `lastDecision` |
| `.../events.jsonl` | append-only event log |
| `~/.claude/` (or `$CLAUDE_CONFIG_DIR`) | Claude Code config home |
| `~/.claude.json` | Claude Code global config; `oauthAccount` holds the active identity |
| Keychain item service `Claude Code-credentials`, account `$USER` | Claude Code's active OAuth credential |
| `~/.codex/auth.json` | Codex CLI login |

`CLAUDE_SWAPPER_HOME` overrides the data directory (used by tests).

## Credential shapes

Claude Code active credential (Keychain value):

```json
{"claudeAiOauth": {"accessToken": "...", "refreshToken": "...", "expiresAt": 1780000000000,
                   "scopes": ["user:inference", "user:profile"], "subscriptionType": "max"}}
```

`~/.claude.json` identity (only these keys are touched on swap):

```json
{"oauthAccount": {"accountUuid": "...", "emailAddress": "...", "organizationUuid": "...",
                  "organizationName": "...", "displayName": "..."}}
```

Codex `~/.codex/auth.json` has two modes:

```json
{"auth_mode": "chatgpt", "tokens": {"access_token": "...", "refresh_token": "...",
                                    "id_token": "...", "account_id": "..."}, "last_refresh": "..."}
{"auth_mode": "apikey", "OPENAI_API_KEY": "sk-..."}
```

## Endpoints used

| Provider | Purpose | Request |
| --- | --- | --- |
| Claude | usage | `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <access>`, `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01` |
| Claude | profile | `GET https://api.anthropic.com/api/oauth/profile` same headers |
| Claude | refresh | `POST https://platform.claude.com/v1/oauth/token` JSON `{grant_type: refresh_token, refresh_token, client_id: 9d1c250a-e61b-44d9-88ed-5944d1962f5e}` |
| Claude | login | authorize `https://claude.ai/oauth/authorize` with PKCE S256, `scope=org:create_api_key user:profile user:inference`, `redirect_uri=http://localhost:54545/callback`; exchange `POST https://api.anthropic.com/v1/oauth/token` JSON `{grant_type: authorization_code, client_id, code, state, redirect_uri, code_verifier}` |
| Codex | usage | `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>`, `ChatGPT-Account-ID: <account_id>`, `User-Agent: codex_cli_rs/0.50.0`, `originator: codex_cli_rs` |
| Codex | refresh | `POST https://auth.openai.com/oauth/token` form `grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=...` |

Claude usage response (normalized by `claudeOauth.normalizeUsage`):

```json
{"five_hour": {"utilization": 41.0, "resets_at": "2026-09-04T22:00:00Z"},
 "seven_day": {"utilization": 63.2, "resets_at": "2026-09-08T10:00:00Z"},
 "limits": [{"kind": "weekly_scoped", "percent": 80.0, "resets_at": "...",
             "scope": {"model": {"display_name": "Fable"}}}]}
```

Codex usage response: `{"plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 41,
"limit_window_seconds": 18000, "reset_at": 1788000000}, "secondary_window": {...604800...}}}`.
`reset_after_seconds` may appear instead of `reset_at`; treat it as relative to now.

## Normalized usage model

See `Usage` / `UsageWindow` in `src/shared/types.ts`. Window keys: `five_hour`, `seven_day`,
`model:<display_name lowercased>` for Claude; `five_hour`, `seven_day` for Codex (primary =
5h, secondary = weekly).

## Swap policy (`src/main/autoswap.ts`)

Pure functions, no I/O, fully unit-tested.

* `gatingWindows(usage, model)` returns the windows that gate an account: `five_hour`,
  `seven_day`, and `model:<model>` if present. `model` defaults to `"Fable"`.
* `headroom(usage, model)` = `100 - max(pct of gating windows)`; `null` when usage unknown.
* `decide(accounts, settings, now, lastSwitchAt)` returns `Decision`. Rules:
  1. Ignore disabled accounts and accounts whose usage is unknown as targets.
  2. Active account is *near limit* when any gating window pct ≥ `threshold`.
  3. Strategy `best`: if not near limit → stay. Strategy `consume_first`: prefer the enabled
     account whose weekly window (`seven_day` or the model window) resets soonest, if its
     headroom exceeds the active account's by ≥ `margin` and it is below threshold.
  4. If near limit → pick the enabled, non-active account with the greatest headroom that is
     below threshold and beats the active account's headroom by ≥ `margin`. None → `blocked`.
  5. Cooldown: no switch if `now - lastSwitchAt < cooldownSeconds`.
  6. `dryRun` turns any `switch` into a `stay` with reason prefixed `dry-run:`.

## Switch mechanics (`src/main/switcher.ts`)

`captureActive()`: read the active credential from the Keychain and the identity from
`~/.claude.json`; return `{credential, identity}`.

`addFromActive(store)`: capture, fingerprint by sha256(refreshToken), upsert the account (same
fingerprint or same `email+orgUuid` → update credential in place), mark it active.

`switchTo(store, accountId)`:
1. Take Claude Code's credential locks (`<config-home>/.oauth_refresh.lock` then
   `<config-home>.lock`, proper-lockfile directory protocol: `mkdir` is the mutex, 60 s
   staleness, touch mtime every 5 s while held).
2. Re-read the active credential and save it back into the *current* account's slot (so a token
   Claude Code rotated is not lost).
3. Write the target credential to the Keychain.
4. Under the config lock (`~/.claude.json.lock`, 10 s staleness) update `oauthAccount` keys in
   `~/.claude.json` (atomic write via temp file + rename, preserve other keys).
5. Record `activeId`, `lastSwitchAt`, and an event. On any failure after step 3, restore the
   previous credential before rethrowing.

Refreshing an *inactive* account's expired token is allowed (POST refresh, persist rotated
credential). Never refresh the *active* account's token; Claude Code owns it.

## Daemon (`src/main/daemon.ts`)

* Every `pollIntervalSeconds`: refresh usage for every enabled account (skip ones fetched
  < 60 s ago unless forced), refresh the Codex snapshot, then if `autoswapEnabled` run
  `decide` and perform the switch. Errors never kill the loop; they become `error` events.
* Emits `stateChanged` after every mutation. The renderer never polls.
* Sends a macOS notification (Electron `Notification`) on automatic switches when `notify`.
* Login flow: `startLogin()` starts a one-shot HTTP server on `127.0.0.1:54545`, opens the
  authorize URL with `shell.openExternal`, exchanges the code, fetches the profile, and adds
  the account. Times out after 5 minutes.

## Window and tray

* One `BrowserWindow`, 1040×720 default, min 860×600, `titleBarStyle: 'hiddenInset'`,
  `trafficLightPosition: {x: 18, y: 18}`, `vibrancy: 'under-window'`, `visualEffectState:
  'active'`. Closing hides the window; the app keeps running in the tray. Quit from the tray
  menu or ⌘Q.
* Tray title: `"<alias or email local-part> 63%"` where 63 is the active account's binding
  window pct; a 16×16 template icon. Menu: Open Claude Swapper, Refresh now, Accounts ▸
  (each account with headroom, click to switch), Auto-swap on/off, Launch at login, Quit.
* `showInDock=false` calls `app.dock.hide()` so the app is menu-bar only.
* `launchAtLogin` uses `app.setLoginItemSettings`.

## Packaging

`npm run dist` → `dist/Claude Swapper-<version>-arm64.dmg` (and x64, and zips). Builds are
unsigned; first launch needs right-click → Open, or
`xattr -dr com.apple.quarantine "/Applications/Claude Swapper.app"`.

## Conventions

* `src/shared` is the source of truth. Changing it means updating main, preload, renderer,
  and this document in the same change.
* Main-process modules that do I/O take their dependencies as arguments (store, fetch,
  clock) so tests are hermetic. Tests never touch the real Keychain, the network, or the
  user's home.
* Never log or throw a secret. Events and errors carry email addresses at most.
* Atomic writes everywhere (temp + rename). Credential files 0600, directory 0700.
* Renderer state comes only from `window.swapper`; the mock in `src/renderer/src/mock`
  implements the same `SwapperApi` and is used automatically in `npm run dev:web`.
