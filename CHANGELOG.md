# Changelog

All notable changes to Session Manager are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

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
