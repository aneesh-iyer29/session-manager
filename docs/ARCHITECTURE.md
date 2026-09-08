# Architecture

Session Manager is a macOS Electron app. It watches the usage limits of several Claude Code
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
| `~/Library/Application Support/Session Manager/settings.json` | user settings |
| `.../accounts.json` | account metadata list (no secrets) |
| `.../credentials/<id>.json` | one credential blob per account, mode 0600 |
| `.../usage.json` | last usage snapshot per account |
| `.../state.json` | `activeId`, `lastSwitchAt`, `lastDecision` |
| `.../events.jsonl` | append-only event log |
| `~/.claude/` (or `$CLAUDE_CONFIG_DIR`) | Claude Code config home |
| `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | Claude Code global config; `oauthAccount` holds the active identity |
| Keychain item service `Claude Code-credentials`, account `$USER` | Claude Code's active OAuth credential |
| `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) | Codex CLI login |

`SESSION_MANAGER_HOME` overrides the data directory (used by tests and the smoke launch).
`SESSION_MANAGER_SMOKE_MS=<ms>` makes `index.ts` print one `smoke: windows=… tray=… rendererChars=…`
line after that delay and quit (`SESSION_MANAGER_SMOKE_PNG=<path>` also saves a screenshot);
`npm run smoke` wraps it.

## Credential shapes

The Keychain write goes through `security -i` with the value hex-encoded on stdin; a
credential too large for that one line (> ~4 KiB) is refused rather than passed via argv.

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
`model:<display_name lowercased>` for Claude; `five_hour`, `seven_day` for Codex, told apart by
`limit_window_seconds` (else by slot, unless the reset lies beyond the slot's span: the API has
returned the weekly window as `primary_window`); other lengths become `window:<n>h` / `window:<n>d`.

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
`addFromCredential(store, credential, identity?)` is the same upsert without marking active; a
fresh browser login passes no identity and the profile API fills it in. These, `activeAccount`,
`captureActive` and `switchTo` are all async.

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

* Every `pollIntervalSeconds` (default 300): refresh usage for enabled accounts — the active one
  if not fetched < 5 min ago, standby ones < 10 min ago unless within 10 points of the threshold
  (forced polls ignore the gaps; the endpoint allows ~30 requests/hour per token, shared with
  Claude Code), refresh the Codex snapshot, then if `autoswapEnabled` run
  `decide` and perform the switch. Errors never kill the loop; they become `error` events.
* Two manual refreshes, one per provider: the toolbar's *Refresh Claude* (`refreshClaude`)
  forces a poll of the Claude accounts only; the Codex panel's *Refresh* (`refreshCodex`)
  re-fetches the Codex snapshot only, ignoring its back-off, and rejects with `usage.error`
  when the fetch fails (the state is pushed first, so the panel keeps the stale numbers).
  Codex snapshots are serialized: a manual refresh joins one a poll already started, and a
  scheduled poll that joins a Claude-only refresh runs the Codex part after it.
* Before polling, the live Keychain credential is matched to a stored account by fingerprint,
  or by `activeId` when `~/.claude.json` still names that account's email (Claude Code rotated
  the refresh token). A login that matches neither is *foreign*: `activeId` is cleared, an
  `info` event is logged once, and no stored credential is overwritten.
* An inactive account whose usage call returned 401 is marked `expired` and refreshed on the
  next poll even if `expiresAt` still looks valid; `invalid_grant` marks it `dead` and it is
  not retried until re-added. A failed Codex snapshot is held off for 5 minutes.
* `pollIntervalSeconds` is capped at 86400 (a longer `setTimeout` overflows and fires at once).
* Emits `stateChanged` after every mutation. The renderer never polls.
* Sends a macOS notification (Electron `Notification`) on automatic switches when `notify`.
* Login flow: `startLogin()` cancels any pending login, starts a one-shot HTTP server on
  `127.0.0.1:54545`, opens the authorize URL with `shell.openExternal`, exchanges the code,
  fetches the profile, and adds the account. Times out after 5 minutes. Callbacks whose
  `state` does not match are answered 400 and ignored (any local process or web page can
  reach the port; it must not be able to complete *or* abort the login), and only the first
  matching callback is exchanged.

## Live status line feed (`src/main/liveUsage.ts`)

Claude Code passes its status line script a JSON document that includes `rate_limits.five_hour`
and `rate_limits.seven_day` (`used_percentage`, `resets_at` epoch seconds), taken from the
rate-limit headers on every API response. That is the active account's usage with no request
against the usage endpoint's budget (~30/hour per token), refreshed on every assistant message.

* `installFeed()` writes `~/.claude/hooks/session-manager-statusline.sh` and sets
  `statusLine` in `~/.claude/settings.json` to it. An existing status line command is saved
  to `<dataDir>/statusline-chain.json` and run by our script with the same stdin, so the user
  sees no change; `uninstallFeed()` restores it.
* The script copies stdin to `<dataDir>/statusline.json` (temp + rename) and prints a compact
  usage line (via jq or python3) or the chained command's output. Bash only.
* The daemon watches the data dir (`fs.watch`, 400 ms debounce) and on each write merges the
  feed's 5h/7d windows into the active account's usage, keeping the per-model window from the
  last endpoint fetch, then re-runs the swap decision and the nudge. Feeds older than 6 h are
  ignored. While the feed is under 15 min old the active account's endpoint fetch gap grows
  to 30 min (only the model window still needs it), and an endpoint result never overwrites
  fresher live windows.
* Between endpoint polls the model window is projected: `model = anchor.model +
  2 × (liveWeekly − anchor.weekly)`, clamped, where the anchor is the last endpoint-reported
  (model, weekly) pair. Fable's weekly cap is about half the all-models cap and these accounts
  run Fable almost exclusively. Projected windows carry `estimated: true` and render with ≈.

## Compact nudge (`src/main/nudge.ts`)

A swap mid-conversation makes the next request re-cache the whole context on the new account.
Nothing outside Claude Code can trigger `/compact`, but a `UserPromptSubmit` hook can stop a
prompt with a message or hand Claude context. So:

* After every poll (and every manual switch) the daemon computes the active account's worst
  gating window. If auto-swap is enabled, not in dry run, and that window is at or past
  `settings.warnPct`, it writes `<dataDir>/swap-pending.txt` (line 1 episode id, line 2
  `nudgeMode`, rest message) plus a JSON twin for the UI. Otherwise it removes both. The id is
  `accountId:windowKey:resetsAt`, stable for one approach to the line.
* `installHook()` writes `~/.claude/hooks/session-manager-nudge.sh` (0755) and registers it
  under `hooks.UserPromptSubmit` in `~/.claude/settings.json`, preserving every other key and
  refusing to touch an unparsable file. `uninstallHook()` removes exactly that entry and the
  script. Both honour `CLAUDE_CONFIG_DIR`.
* The script (bash + sed only) reads the flag from `$SESSION_MANAGER_HOME` or the default data
  dir. In `block` mode it exits 2 with the message on stderr for the first prompt of an episode
  (recording the id in `swap-pending.nudged`) and adds `additionalContext` afterwards; in
  `context` mode it only adds context. No flag → exit 0, no output.

## Window and tray

* One `BrowserWindow`, 1040×720 default, min 860×600, `titleBarStyle: 'hiddenInset'`,
  `trafficLightPosition: {x: 18, y: 18}`, `vibrancy: 'under-window'`, `visualEffectState:
  'active'`. Closing hides the window; the app keeps running in the tray. Quit from the tray
  menu or ⌘Q.
* Tray: the Arcophos mark as a template image (`build/trayTemplate*.png`, regenerated with
  `npx electron scripts/render-tray.mjs` from `build/tray.svg`), no title. Click pops a glance
  menu whose rows are images: `trayText.ts` builds the row model and its HTML,
  `trayRender.ts` paints all rows in one offscreen transparent window at 2× and crops them into
  per-row `NativeImage`s (rebuilt on every state push, so the menu opens instantly). Each
  window row is label · "Resets in 3 hr 5 min" · percent over a 4 px bar in the headroom
  colour. If rendering fails the same rows fall back to text. Rows open the window; the only
  other items are Open Session Manager and Quit. No state changes from the tray.
* `showInDock=false` calls `app.dock.hide()` so the app is menu-bar only.
* `launchAtLogin` uses `app.setLoginItemSettings`.

## Packaging

`npm run build` → `out/main/index.js`, `out/preload/index.mjs` (Electron needs the `.mjs`
extension for an ESM preload), `out/renderer/`. `npm run dist:dir` → `dist/mac-arm64/Claude
Swapper.app`; `npm run dist` → `dist/Session Manager-<version>-arm64.dmg` (and x64, and zips).
Builds are unsigned (`identity: null`); first launch needs right-click → Open, or
`xattr -dr com.apple.quarantine "/Applications/Session Manager.app"`.

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
