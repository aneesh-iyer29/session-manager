# Contributing

Thanks for helping. Session Manager is deliberately small; the best contributions keep it
that way.

## Setup

```sh
git clone https://github.com/aneesh-iyer29/claude-swapper.git
cd claude-swapper
npm install
npm run dev          # Electron with hot reload
npm run dev:web      # renderer only, in a browser, against the mock backend
```

Node 22 and macOS are required for the Electron app and packaging. `npm run dev:web` and
the test suite run anywhere.

## Before you open a PR

```sh
npm run typecheck && npm run lint && npm test && npm run build
CLAUDE_SWAPPER_HOME=$(mktemp -d) npm run smoke   # launches Electron headless, prints one status line
```

CI runs typecheck, lint, test, and build on `ubuntu-latest`; packaging and the smoke launch are local.

## Ground rules

- **The contract is `src/shared`.** If a change needs new fields or channels, update
  `types.ts` / `ipc.ts`, the main process, the preload, the renderer, the mock, and
  `docs/ARCHITECTURE.md` in one PR.
- **Tests are hermetic.** Point the store at a temp dir with `CLAUDE_SWAPPER_HOME`, point
  Claude Code's config home at a temp dir with `CLAUDE_CONFIG_DIR`, inject `fetch`, `exec`,
  and the clock. A test that touches the real Keychain, the network, or your home directory
  will be rejected.
- **No secrets anywhere visible.** Not in logs, thrown errors, events, or test fixtures
  that resemble real tokens.
- **UI follows `docs/DESIGN.md`.** Springs only, system font, semantic colours, tabular
  numbers. Check both light and dark and the 860×600 minimum size.
- **Scope.** Many Claude accounts, one Codex account, one gating model window. Features
  outside that (multiple Codex accounts, other providers, plugins, i18n) belong in a fork.

## Style

TypeScript strict, ESM, Prettier-ish formatting (2 spaces, no semicolons, single quotes,
120 columns). Small functions. Comments explain *why*, not *what*.

## Reporting bugs

Use the bug report template. Include the Activity log lines (they never contain secrets)
and your macOS and app versions.
