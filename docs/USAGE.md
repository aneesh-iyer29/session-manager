# Using Session Manager

## Adding accounts

**Capture current login.** If Claude Code is signed in, this copies its credential from
the Keychain and its identity from `~/.claude.json`. The captured account becomes the
active one. Capture again any time; an account you already have is updated in place.

**Log in with browser.** Opens claude.ai in your default browser. After you approve, the
browser redirects to `http://localhost:54545/callback`, the app exchanges the code for a
token, looks up the account's email and organisation, and adds it as a standby account.
The page says you can close the tab. Cancel from the app if the browser never comes back;
the flow times out after five minutes.

Sign out of claude.ai in the browser between logins if you want to add a different account.

## Reading a card

Each card shows the account's **headroom**: `100 − max(used %)` across its gating windows,
which are the 5-hour window, the weekly window, and the Fable weekly window when the API
reports one. The window with the least headroom is the **binding window**; its name and
reset countdown sit under the number. Colours: green at 30+ headroom, orange at 11–29, red
at 10 or below (or at/over your threshold).

States a card can be in:

- **Active** — the credential Claude Code is using now.
- **Held out of rotation** — never an auto-swap target; still a manual switch target.
- **Needs login** — the refresh token was rejected. Remove the account and add it again.
- **Fetch error** — the last usage fetch failed; the numbers shown are from the previous
  success and the error is in Activity.

## Switching manually

Click **Switch to this account** on a standby card, or pick the account from the menu bar
menu. The app takes Claude Code's lock files, saves the outgoing credential back into its
slot (so a token Claude Code rotated is not lost), writes the new credential, updates
`oauthAccount` in `~/.claude.json`, and records the switch. Running `claude` sessions use
the new login on their next request.

## Auto-swap

Arm it in the Auto-swap panel or from the menu bar. Each poll the policy runs:

1. Accounts that are held or have unknown usage are never targets.
2. The active account is *near limit* when any gating window used % ≥ **threshold**.
3. `best`: stay unless near limit. `consume_first`: prefer the account whose weekly window
   resets soonest, if its headroom beats the active account's by ≥ **margin** and it is
   under threshold.
4. Near limit: switch to the account with the most headroom that is under threshold and
   beats the active account by ≥ margin. None → *blocked*.
5. No automatic switch within **cooldown** seconds of the last one.
6. **Dry run** turns a switch into a logged *stay* prefixed `dry-run:`.

The last decision is shown in the panel and, when it changes, in Activity. A notification
fires on each automatic switch (turn off with *Notifications*).

Poll interval is 5 min by default (minimum 15 s). Anthropic's usage endpoint allows only
about 30 requests per hour per account, shared with Claude Code's own checks, so the active
account is fetched at most every 5 min and standby accounts every 10 min unless within 10
points of the threshold. Accounts fetched within those gaps are
skipped unless you press Refresh.

## Compact nudge

A swap in the middle of a long Claude Code conversation makes the next request re-cache the
whole context on the new account (one full uncached read, priced as a cache write). The nudge
gets you to `/compact` first.

1. In the Auto-swap panel, click **Install** on "Claude Code compact nudge". This writes
   `~/.claude/hooks/session-manager-nudge.sh` and registers it as a `UserPromptSubmit` hook in
   `~/.claude/settings.json`. Nothing else in that file is touched; **Remove** takes it back out.
2. Set **Warn at (%)**, default 80. When the active account's worst gating window reaches it
   (and auto-swap is armed, not in dry run), the hero card shows a "Swap soon" notice and the
   app raises a flag file the hook reads.
3. Pick the **Nudge** behaviour. *Block once* (default): the next message you send in
   Claude Code is stopped once with "run /compact now, then send your message again"; later
   prompts go through, with a short note to Claude. *Context only*: nothing is stopped;
   Claude is told a swap is near and may remind you once.

The flag clears on its own once the account is below the warn line again, or after the swap.
The hook is silent whenever there is no flag. Session Manager only needs to be running; the
hook works in every Claude Code session on the machine.

## Codex panel

Shows the Codex CLI's account when `~/.codex/auth.json` has a ChatGPT login: plan, email,
5-hour and weekly windows. The app refreshes the CLI's token when it is within 30 minutes
of expiring and writes it back. In API-key mode the CLI has no quota endpoint, so the
panel only reports that it is configured. *Hide* in the panel header turns it off (*Show* brings it back).

## Menu bar

The menu bar item is the Arcophos mark alone, no text. Click it for a glance menu: each
account with a usage bar per window (5-hour limit, Weekly · all models, Weekly · Fable) and its
reset time,
the Codex account, and one status line (auto-swap state, last poll). The only actions are
**Open Session Manager** and **Quit**; switching and settings live in the window so the menu
can never change anything by accident. Clicking any row opens the window.
*Show in Dock* off hides the Dock icon; the app then lives only in the menu bar. Closing the
window hides it; quit from the menu or ⌘Q.

## Settings reference

| Setting | Range / default | Effect |
| --- | --- | --- |
| Auto-swap | off | Run the policy each poll. |
| Dry run | off | Log decisions without switching. |
| Threshold | 50–100, 90 | Near-limit percent. |
| Margin | 0–50, 10 | Required headroom advantage of a target. |
| Cooldown | ≥ 0, 300 s | Minimum gap between automatic switches. |
| Poll interval | ≥ 15, 300 s | How often the loop runs; each account is fetched at most every 5 min (standby: 10). |
| Strategy | `best` | `best` or `consume_first`. |
| Model | `Fable` | Display name of the per-model weekly window that gates swapping. |
| Codex panel (Hide / Show) | on | Show the Codex panel. |
| Notifications | on | macOS notification on automatic switches. |
| Launch at login | off | Register as a login item. |
| Show in Dock | on | Off = menu-bar only. |

| Warn at | 80 | Raise the compact nudge when the active account's worst gating window reaches this |
| Nudge | Block once | What the Claude Code hook does with the flag |

## Files

`~/Library/Application Support/Session Manager/` holds `settings.json`, `accounts.json`
(no secrets), `credentials/` (0600 files), `usage.json`, `state.json`, and `events.jsonl`.
Deleting the folder while the app is quit resets it; the app never
touches Claude Code's own login.
