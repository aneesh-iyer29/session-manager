# AGENTS.md

Guidance for any coding agent working in this repository. `CLAUDE.md` has the same
content with a module table; this file stands alone for the essentials.

## What this is

Claude Swapper: a macOS Electron (main: Node) + React (renderer) + TypeScript app. It
tracks usage for many Claude Code accounts, swaps the active login before the Fable weekly
(or 5-hour / weekly) limit hits, and shows one Codex account's quota read-only. Single
user, local only, no telemetry.

## Source of truth

- `src/shared/types.ts` and `src/shared/ipc.ts` are the contract between main, preload,
  and renderer. Do not change them casually; if you must, update every consumer, the mock
  in `src/renderer/src/mock/`, and `docs/ARCHITECTURE.md` together.
- `docs/ARCHITECTURE.md` is the spec (paths, endpoints, swap policy, switch steps).
- `docs/DESIGN.md` is the UI brief (tokens, layout, motion, copy). UI changes follow it.

## Commands

| Task | Command |
| --- | --- |
| Run the app | `npm run dev` |
| UI work in a browser with the mock backend | `npm run dev:web` (http://localhost:5180) |
| Types | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests | `npm test` |
| Bundle | `npm run build` |
| Headless launch check | `CLAUDE_SWAPPER_HOME=/tmp/x npm run smoke` |
| Package (unsigned DMG + zip, arm64 + x64) | `npm run dist` (`npm run dist:dir` for the bare .app) |

CI runs typecheck, lint, test, build, and the smoke launch on macOS.

## Rules

1. Tests are hermetic. Use temp directories through `CLAUDE_SWAPPER_HOME` and
   `CLAUDE_CONFIG_DIR`, inject `fetch`/`exec`/clock. Never touch the real Keychain,
   network, `~/.claude*`, or `~/.codex`.
2. No secrets in logs, thrown errors, events, or IPC payloads. Email addresses at most.
3. All file writes are atomic (temp + rename). Credential files are 0600 in a 0700 dir.
4. Never refresh the active account's token; never write the Keychain or `~/.claude.json`
   outside `src/main/switcher.ts`, which takes Claude Code's own lock files first.
5. Renderer uses React and `motion/react` only. Springs only; respect reduced motion.
6. TypeScript strict, ESM, no new runtime dependencies. Main/preload use Node built-ins
   and Electron only.
7. Keep scope: many Claude accounts, one Codex account, Fable-gated swapping. No i18n,
   no extra themes, no plugins.
8. Do not run `git` or `npm install` unless the task says so.

## Module map (main process)

`paths.ts` → `keychain.ts` / `claudeLocks.ts` → `store.ts` → `claudeOauth.ts`,
`codex.ts` → `switcher.ts` → `autoswap.ts` (pure) → `daemon.ts` → `ipc.ts` / `tray.ts` /
`window.ts` → `index.ts`. Each layer only imports from the layers before it.
