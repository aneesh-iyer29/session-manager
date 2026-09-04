# Security

## What the app handles

Session Manager stores OAuth credentials for your Claude accounts and reads the Codex CLI's
login. They stay on your Mac:

- Per-account credentials live in
  `~/Library/Application Support/Session Manager/credentials/<id>.json`, mode 0600, in a
  0700 directory. Writes are atomic.
- The active credential is written to the macOS Keychain item Claude Code owns (service
  `Claude Code-credentials`), through `/usr/bin/security` with the secret passed on stdin
  in hex, never on the command line.
- `~/.codex/auth.json` is read, and rewritten only to persist a refreshed token, preserving
  its file mode and unknown keys.
- Network calls go only to `api.anthropic.com`, `platform.claude.com`, `claude.ai` (browser
  login), `chatgpt.com`, and `auth.openai.com`. There is no telemetry and no update check.
- Logs, events, and error messages never contain tokens. Email addresses may appear.

The browser login listens once on `127.0.0.1:54545` for the OAuth redirect and shuts the
listener down as soon as the code arrives, is cancelled, or five minutes pass.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email
[aneesh.iyer29@gmail.com](mailto:aneesh.iyer29@gmail.com) with a description and steps to
reproduce. You will get an acknowledgement within a few days. Fixes ship as a new release
with a note in `CHANGELOG.md`.

## Scope notes

- Builds are unsigned. Verify the download came from this repository's Releases page.
- The renderer has no Node access (`contextIsolation: true`, `nodeIntegration: false`);
  it can only call the channels in `src/shared/ipc.ts`, and the main process validates
  every argument.
- External links from the app are restricted to `http(s)` URLs opened in your default browser.
