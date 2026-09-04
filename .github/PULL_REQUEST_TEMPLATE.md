## What

<!-- One or two sentences: what changes and why. Link the issue if there is one. -->

## How

<!-- Anything a reviewer should know: contract changes in src/shared, new settings, migration of stored files. -->

## Checklist

- [ ] `npm run typecheck && npm run lint && npm test && npm run build` pass locally
- [ ] Tests are hermetic (temp dirs, injected fetch/exec/clock; no real Keychain, network, or home directory)
- [ ] No secrets in logs, errors, events, or fixtures
- [ ] If `src/shared` changed: main, preload, renderer, mock, and `docs/ARCHITECTURE.md` updated together
- [ ] UI changes follow `docs/DESIGN.md` and were checked in light and dark at 860×600
- [ ] `CHANGELOG.md` updated under Unreleased (user-visible changes only)
