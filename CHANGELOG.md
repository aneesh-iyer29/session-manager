# Changelog

All notable changes to Session Manager are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Added

- A separate swap line for the 5-hour session (**5-hour swap at**, default 90) beside the
  weekly one (**Weekly swap at**, the setting formerly called *Threshold*). One heavy turn can
  move a session several points, so the session keeps a buffer while the weeks can be run
  nearly dry. New setting `fiveHourThreshold`.
- The Codex panel has its own *Refresh*, with the time since the last fetch beside it, so
  the Codex quota can be brought up to date on the spot and a fresh `codex login` picked
  up without waiting for the next poll. The toolbar button is now *Refresh Claude* and
  polls only the Claude accounts. The two never fetch Codex twice at once.

### Changed

- Activity folds after the newest twelve entries, with *Show N more* / *Show less* under the
  list. The backend still keeps the last hundred, so nothing is lost; the right column just
  stops running the height of a hundred log lines.
- Headroom is session-first. An account's gauge shows its 5-hour session, and a weekly window
  (all models or Fable) takes over only once it is past the warn line and closer to its limit
  than the session, the point at which the week runs out before the session does. Before, the
  highest of the three windows always headed the gauge, which on a Max account is the Fable
  weekly for most of the week even with a session about to run out.
- Swap targets are compared on the axis that ran out: session headroom when the 5-hour line
  hit, weekly headroom when a weekly line did; ties break on the other axis. `consume_first`
  judges its margin on weekly headroom. Every window is coloured and swapped against its own
  line, in the cards and in the menu bar.
- The compact nudge and the fast poll cadence follow the window nearest its swap line rather
  than the highest window.

### Fixed

- While the status line feed is fresh, the Fable window is polled every 5 minutes instead of
  30 once it is within 10 points of its swap line, so a swap on that window is never decided
  on a projection alone.
- After a swap, status line documents still carrying the previous login's windows (a Claude
  Code session finishing its turn) are recognised by their weekly reset and ignored, instead
  of landing on the new account and prompting a second swap.
- Codex windows are labelled by their length rather than their slot, so a weekly window the
  API returns as `primary_window` no longer shows as a 5-hour limit resetting in six days.

## [0.4.0] - 2026-09-04

### Added

- Live usage feed: an installable Claude Code status line script hands the app the 5-hour
  and weekly usage Claude Code already has from every response, so the active account
  updates instantly and the usage endpoint is only polled for the per-model window (every
  30 min while the feed is fresh). Existing status lines are chained and restored on remove.
- Between those polls the Fable window is projected from the live weekly window (two points
  per weekly point, anchored at the last real reading) and marked ≈.

## [0.3.7] - 2026-09-04

### Changed

- Poll cadence tuned to the usage endpoint's measured budget (~30 requests/hour per token):
  default interval 5 min, active account at most every 5 min, standby every 10 min.

## [0.3.6] - 2026-09-04

### Fixed

- A failed usage poll no longer blanks the headroom number: the last known windows still
  drive the gauge and the swap policy, with one line saying why and how old they are.
- Failure wording: "Rate limited by Anthropic · retrying in 9 min" instead of "HTTP 429".
- Removed hover tooltips from tray rows, reset times, poll age, and the decision line.

### Changed

- Default poll interval is 2 min; standby accounts are fetched at most every 5 min unless
  within 10 points of the threshold, to stay inside the usage endpoint's rate limit.

## [0.3.5] - 2026-09-04

### Changed

- Removed the non-functional ⌘O/⌘Q hints from the glance menu so macOS no longer reserves a
  shortcut column and the usage rows reach the right edge.

## [0.3.4] - 2026-09-04

### Changed

- Repository, package, app id, and env vars renamed from claude-swapper to session-manager
  (`SESSION_MANAGER_HOME`, `SESSION_MANAGER_SMOKE_*`). Data folder is unchanged.

## [0.3.3] - 2026-09-04

### Changed

- Glance menu rows span the full menu width so the shortcuts sit flush right; Quit no longer
  shows the version. CI runs on Ubuntu and skips docs-only pushes and tags.

## [0.3.2] - 2026-09-04

### Fixed

- Menu bar glyph was an opaque white square: the template PNGs are now rasterized by
  Electron offscreen (`scripts/render-tray.mjs`) with real alpha instead of by `qlmanage`.

### Changed

- Glance menu rows are rendered as retina images with a real progress bar, in the style of
  Claude's usage panel: label, "Resets in 3 hr 5 min" / "Resets Mon 10:00 AM", percent, bar.
  Falls back to text rows if the offscreen renderer fails.

## [0.3.1] - 2026-09-04

### Changed

- Menu bar item is now the brand mark alone. Its menu is a read-only glance: usage bars
  and reset countdowns per account and for Codex, a status line, then Open Session Manager
  and Quit. Switching and toggles were removed from the menu.

## [0.3.0] - 2026-09-04

### Added

- Compact nudge: when the active account's worst gating window reaches "Warn at" (default 80%)
  with auto-swap armed, the daemon raises a swap-pending flag. An optional Claude Code
  `UserPromptSubmit` hook (installed from the Auto-swap panel) reads it and either stops the
  first prompt with "run /compact now" or only tells Claude, so the conversation is compacted
  before it is re-cached on the next account. New settings `warnPct` and `nudgeMode`; new
  `nudge` state; `installHook` / `uninstallHook` IPC.

## [0.2.0] - 2026-09-04

### Changed

- Renamed the app to Session Manager.
- Restyled to the house idiom: paper ground, ink actions, Space Mono and Lora
  (bundled), 3 px corners, no shadows or vibrancy; see `docs/DESIGN.md`.
- App icon is now the brand mark on a full-bleed paper square; the menu bar glyph is the mark.
- Press feedback is `scale(0.96)`; the refresh control uses an inline SVG icon.

## [0.1.0] - 2026-09-04

Initial release.

### Added

- Dashboard with a binding-window gauge for the active account and standby cards for the rest.
- Add accounts by capturing the current Claude Code login or through a browser (PKCE) login.
- Manual switching that cooperates with Claude Code's own lock files and preserves rotated tokens.
- Auto-swap with threshold, margin, cooldown, `best` / `consume_first` strategies, a
  configurable gating model window (Fable by default), and dry run.
- Read-only Codex quota panel from the Codex CLI's ChatGPT login, with an API-key-mode notice.
- Menu bar item showing the active account and its binding-window percent, with a menu for
  switching, refreshing, auto-swap, launch at login, and quitting.
- Activity log, macOS notifications on automatic switches, launch at login, dock hiding.
- Unsigned DMG and zip builds for arm64 and x64.
