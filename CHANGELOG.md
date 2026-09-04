# Changelog

All notable changes to Claude Swapper are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

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
