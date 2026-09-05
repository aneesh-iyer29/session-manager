# Session Manager — notes for Claude Code

macOS Electron + React + TypeScript app. Watches usage for many Claude Code accounts,
auto-swaps the active login before the Fable weekly / 5-hour / weekly window bites, shows
one Codex account's quota read-only. One user, no server, no telemetry.

## Layout

```
src/shared/    types.ts (data model), ipc.ts (channels + SwapperApi)  ← THE CONTRACT
src/main/      Electron main (Node): disk, Keychain, network, poll loop
src/preload/   contextBridge → window.swapper
src/renderer/  React UI; src/renderer/src/mock/ = in-memory SwapperApi for browser dev
build/         icon.icns, tray template PNGs, entitlements
docs/          ARCHITECTURE.md (spec), DESIGN.md (UI brief), USAGE.md (user guide)
```

## Where to look

| Concern | Module |
| --- | --- |
| Paths, `CLAUDE_CONFIG_DIR`, `SESSION_MANAGER_HOME` | `src/main/paths.ts` |
| Keychain read/write via `/usr/bin/security` | `src/main/keychain.ts` |
| Claude Code's lock files (proper-lockfile dirs) | `src/main/claudeLocks.ts` |
| Settings / accounts / credentials / usage / events on disk | `src/main/store.ts` |
| Claude usage, profile, refresh, PKCE login | `src/main/claudeOauth.ts` |
| Codex `auth.json`, refresh, usage | `src/main/codex.ts` |
| Capture, add, switch (5 steps, restore on failure) | `src/main/switcher.ts` |
| Swap policy (pure, no I/O) | `src/main/autoswap.ts` |
| Poll loop, autoswap run, login bookkeeping, notifications | `src/main/daemon.ts` |
| Compact-nudge flag file and the Claude Code hook installer | `src/main/nudge.ts` |
| Window, tray, IPC registration, app lifecycle | `src/main/window.ts`, `tray.ts`, `ipc.ts`, `index.ts` |
| Renderer state and components | `src/renderer/src/` |

## Commands

```
npm run dev        Electron with hot reload
npm run dev:web    renderer only, in a browser with the mock backend (port 5180) — use for UI work
npm run typecheck  tsc for node + web projects
npm run lint       eslint
npm test           vitest (hermetic; never touches Keychain, network, or ~)
npm run build      electron-vite build → out/ (main/index.js, preload/index.mjs, renderer/)
npm run smoke      build, launch Electron headless for 8 s, print `smoke: windows=1 tray=1 …`, quit
npm run dist       build + unsigned DMG/zip → dist/ (dist:dir for just the .app)
```

## Conventions

- `src/shared` is the contract. Changing it means updating main, preload, renderer, the
  mock, and `docs/ARCHITECTURE.md` in the same change.
- Main-process modules take their I/O as arguments (store, fetch, exec, clock). Tests use
  temp dirs via `SESSION_MANAGER_HOME` / `CLAUDE_CONFIG_DIR` and injected fetch/exec.
- `switcher.addFromActive` / `addFromCredential` / `activeAccount` are async (they read the
  Keychain and may call the profile API). `claudeGlobalConfig()` follows `CLAUDE_CONFIG_DIR`;
  `codexAuthPath()` follows `CODEX_HOME`.
- Smoke-test the real app against a scratch data dir: `SESSION_MANAGER_HOME=/tmp/x npm run smoke`
  (`SESSION_MANAGER_SMOKE_PNG=/tmp/x.png` also saves a screenshot). It reads the Keychain
  and `~/.codex/auth.json` like a normal launch but writes nothing when there are no accounts.
- Never log, throw, or emit a secret. Events and errors carry email addresses at most.
- Atomic writes (temp + rename). Credential files 0600, credentials dir 0700.
- Renderer: React + `motion/react` only; springs only (`type: 'spring', bounce: 0`),
  respect `prefers-reduced-motion`; `docs/DESIGN.md` governs every visual decision.
- TypeScript strict, ESM. No new runtime dependencies without a very good reason.
- Docstrings explain *why*. Small functions.

## Do not

- Do not read or print the real Keychain item, `~/.codex/auth.json`, or credential files.
- Do not refresh the *active* account's token; Claude Code owns it.
- Do not write `~/.claude.json` or the Keychain outside the switcher's lock-protected path.
- Do not add i18n, themes beyond light/dark, telemetry, plugin systems, or multiple Codex accounts.
- Do not use `setInterval` for polling; the daemon chains `setTimeout`.
- Do not run `git` commands or `npm install` unless asked.
