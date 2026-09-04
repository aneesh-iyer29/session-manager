# Architecture

Claude Swapper is a small Python service with three faces: a background daemon that polls
usage and auto-swaps Claude Code accounts, a local web dashboard, and an optional macOS
menu bar icon. It is deliberately narrow: **many Claude accounts, one Codex account, one
model family (Fable) that gates swapping.**

```
┌──────────────┐    ┌───────────────┐    ┌──────────────┐
│  web UI      │    │  menu bar     │    │  CLI         │
│  (static)    │    │  (rumps)      │    │  (argparse)  │
└──────┬───────┘    └──────┬────────┘    └──────┬───────┘
       │ HTTP JSON         │ in-process         │ in-process
       ▼                   ▼                    ▼
┌────────────────────────────────────────────────────────┐
│  Daemon (claude_swapper.daemon)                        │
│   - poll loop: refresh usage for every account         │
│   - autoswap policy (claude_swapper.autoswap)          │
│   - event log ring buffer                              │
└──────┬───────────────┬───────────────┬─────────────────┘
       │               │               │
       ▼               ▼               ▼
  store.py       claude_oauth.py     codex.py
  (accounts,     (usage, refresh,    (~/.codex/auth.json,
   settings,      PKCE login)         wham/usage)
   usage cache)
       │
       ▼
  switcher.py ── keychain.py (macOS `security`) + claude_locks.py (Claude Code's lock protocol)
             └── ~/.claude.json  (oauthAccount identity)
```

## Runtime layout

| Path | Purpose |
| --- | --- |
| `~/.claude-swapper/settings.json` | user settings (see Settings) |
| `~/.claude-swapper/accounts.json` | account metadata list (no secrets) |
| `~/.claude-swapper/credentials/<id>.json` | one credential blob per account, mode 0600 |
| `~/.claude-swapper/usage.json` | last usage snapshot per account |
| `~/.claude-swapper/events.jsonl` | append-only event log (swaps, errors) |
| `~/.claude-swapper/daemon.log` | daemon log |
| `~/.claude/` (or `$CLAUDE_CONFIG_DIR`) | Claude Code config home |
| `~/.claude.json` | Claude Code global config; `oauthAccount` holds the active identity |
| macOS Keychain item service `Claude Code-credentials`, account `$USER` | Claude Code's active OAuth credential |
| `~/.claude/.credentials.json` | active credential on Linux (file backend) |
| `~/.codex/auth.json` | Codex CLI login |

## Credential shapes

Claude Code active credential (Keychain value, or `.credentials.json` contents):

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
| Claude | login | authorize `https://claude.ai/oauth/authorize` with PKCE S256, `scope=org:create_api_key user:profile user:inference`, `redirect_uri=http://localhost:54545/callback`; token exchange `POST https://api.anthropic.com/v1/oauth/token` JSON `{grant_type: authorization_code, client_id, code, state, redirect_uri, code_verifier}` |
| Codex | usage | `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>`, `ChatGPT-Account-ID: <account_id>`, `User-Agent: codex_cli_rs/0.50.0`, `originator: codex_cli_rs` |
| Codex | refresh | `POST https://auth.openai.com/oauth/token` form `grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=...` |

Claude usage response (normalized by `claude_oauth.normalize_usage`):

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

Every provider produces the same shape, stored per account in `usage.json`:

```json
{"fetched_at": "2026-09-04T18:00:00Z",
 "ok": true, "error": null,
 "windows": [
   {"key": "five_hour", "label": "5-hour", "pct": 41.0, "resets_at": "..."},
   {"key": "seven_day", "label": "Weekly", "pct": 63.2, "resets_at": "..."},
   {"key": "model:fable", "label": "Fable weekly", "pct": 80.0, "resets_at": "..."}
 ],
 "plan": "max"}
```

`pct` is 0-100 used. A window with unknown reset has `resets_at: null`.
Window keys: `five_hour`, `seven_day`, `model:<display_name lowercased>` for Claude;
`five_hour`, `seven_day` for Codex (primary = 5h, secondary = weekly).

## Swap policy (`autoswap.py`)

Pure functions, no I/O, fully unit-tested.

* `gating_windows(usage, model)` returns the windows that gate an account: `five_hour`,
  `seven_day`, and `model:<model>` if present. `model` defaults to `"Fable"`.
* `headroom(usage, model)` = `100 - max(pct of gating windows)`; `None` when usage unknown.
* `decide(state, settings, now)` returns `Decision(action, target_id, reason)` where action is
  `"stay" | "switch" | "blocked"`. Rules:
  1. Ignore disabled accounts and accounts whose last usage fetch is unknown for the target.
  2. Active account is *near limit* when any gating window pct ≥ `threshold` (default 90).
  3. If not near limit → stay (strategy `best`). Strategy `consume_first`: switch to the
     enabled account whose weekly (`seven_day` or model window) resets soonest, if its headroom
     exceeds the active account's by ≥ `margin` and it is below threshold.
  4. If near limit → pick the enabled, non-active account with the greatest headroom that is
     below threshold and beats the active account's headroom by ≥ `margin` (default 10).
     None → `blocked`.
  5. Cooldown: no switch if `now - last_switch_at < cooldown_seconds` (default 300).
  6. `dry_run` turns any `switch` into a `stay` with reason prefixed `dry-run:`.

## Switch mechanics (`switcher.py`)

`capture_active()`: read the active credential (Keychain on macOS, file elsewhere) and the
identity from `~/.claude.json`; return `(credential_json, identity)`.

`add_from_active()`: capture, fingerprint by sha256(refreshToken), upsert the account (same
fingerprint or same `email+organizationUuid` → update credential in place), mark it active.

`switch_to(account_id)`:
1. Take Claude Code's credential locks (`<config-home>/.oauth_refresh.lock` then
   `<config-home>.lock`, proper-lockfile directory protocol, 60 s staleness, touch every 5 s).
2. Re-read the active credential and save it back into the *current* account's slot (so a token
   Claude Code rotated is not lost).
3. Write the target credential to the Keychain / file.
4. Under the config lock (`~/.claude.json.lock`, 10 s staleness) update `oauthAccount`
   keys in `~/.claude.json` (atomic write via temp file + rename, preserve other keys).
5. Record `active_id`, `last_switch_at`, and an event.

Refreshing an *inactive* account's expired token is allowed (POST refresh, persist rotated
credential). Never refresh the *active* account's token; Claude Code owns it.

## Settings (`settings.json`)

```json
{"autoswap_enabled": false, "dry_run": false, "threshold": 90, "margin": 10,
 "cooldown_seconds": 300, "poll_interval_seconds": 60, "strategy": "best",
 "model": "Fable", "port": 7788, "codex_enabled": true, "notify": true}
```

## HTTP API (`server.py`, default `http://127.0.0.1:7788`)

All responses JSON. Errors: `{"error": "message"}` with 4xx/5xx.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/state` | full state (below) |
| POST | `/api/refresh` | force a usage poll now → state |
| GET | `/api/settings` | settings object |
| PUT | `/api/settings` | partial settings object → merged settings |
| POST | `/api/accounts/capture` | add/update account from the active Claude Code login → `{account}` |
| POST | `/api/accounts/login` | start PKCE login → `{login_id, url}`; the server opens the browser too |
| GET | `/api/accounts/login/<login_id>` | `{status: "pending"|"done"|"error", account?, error?}` |
| POST | `/api/accounts/<id>/switch` | switch now → state |
| POST | `/api/accounts/<id>/enable` / `disable` | toggle rotation eligibility → state |
| PATCH | `/api/accounts/<id>` | `{alias}` → state |
| DELETE | `/api/accounts/<id>` | remove account (refuses the active one) → state |
| GET | `/api/events?limit=50` | `{events: [...]}` newest first |
| GET | `/` and static files | dashboard |

State object:

```json
{"version": "0.1.0", "now": "ISO", "active_id": "acc_1", "autoswap": {"enabled": true,
   "dry_run": false, "last_decision": {"action": "stay", "target_id": null, "reason": "..."},
   "last_switch_at": "ISO|null", "next_poll_at": "ISO"},
 "settings": {...},
 "accounts": [{"id": "acc_1", "email": "...", "alias": "", "org_name": "...", "plan": "max",
               "active": true, "disabled": false, "added_at": "ISO", "token_status": "ok|expired|dead",
               "usage": {normalized usage or null}, "headroom": 59.0}],
 "codex": {"configured": true, "mode": "chatgpt|apikey|none", "email": "...", "plan": "pro",
           "usage": {normalized usage or null}}}
```

Events: `{"at": "ISO", "kind": "switch|autoswap|error|login|capture|info", "message": "...",
"account_id": "acc_1|null"}`.

## CLI (`claude-swapper`)

| Command | Effect |
| --- | --- |
| `serve` | run daemon + web server in the foreground (`--port`, `--open`) |
| `menubar` | run daemon + web server + macOS menu bar icon |
| `status` | print accounts, windows, and headroom as a table |
| `add` | capture the active Claude Code login as an account |
| `login` | run the PKCE login flow and add the resulting account |
| `switch <id|email|alias>` | switch now |
| `auto --once [--dry-run]` | one decide-and-switch pass, exit code 0 switched / 2 nothing / 3 blocked |
| `install-launchagent` / `uninstall-launchagent` | autostart `menubar` at login |

## Module ownership

| Module | Responsibility |
| --- | --- |
| `paths.py` | every filesystem path, honours `CLAUDE_CONFIG_DIR`, `CLAUDE_SWAPPER_HOME` |
| `keychain.py` | `get/set/delete_password` via `/usr/bin/security`, file backend fallback |
| `claude_locks.py` | proper-lockfile directory locks in Claude Code's order |
| `store.py` | JSON persistence with atomic writes and 0600 credential files |
| `claude_oauth.py` | usage, profile, refresh, PKCE login, `normalize_usage` |
| `codex.py` | read auth.json, refresh if <30 min left, usage, `normalize_usage` |
| `switcher.py` | capture / add / switch |
| `autoswap.py` | pure decision policy |
| `daemon.py` | poll loop, event log, orchestration; the single object the UIs talk to |
| `server.py` | `ThreadingHTTPServer` JSON API + static files from `web/` |
| `menubar.py` | rumps app, lazy-imports rumps |
| `cli.py` | argparse entry point |
| `launch_agent.py` | LaunchAgent plist install/uninstall |

Only the standard library is used at runtime; `rumps` is an optional extra.
