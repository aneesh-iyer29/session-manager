# Design brief

Session Manager is an internal tool. It should sit next to the rest of the house tooling
without explanation: the same paper, the same ink, the same monospaced working voice, the same
restraint. Its single job: tell one researcher, at a glance, **which Claude account is live, how
much Fable runway each account has, and whether the auto-swap is armed**, and let them act in one
click. The register is a lab instrument, not a consumer dashboard. Every element earns its place.

## Brand source

Derived from the house stylesheet (September 2026):

- **Type.** Montserrat for everything that works (body, numbers, labels, controls), with
  tabular figures so changing numbers hold their width. Space Mono only where a fixed pitch
  keeps columns still: the log lines, the countdowns, inline code. Lora, the brand serif, only
  for the wordmark and one welcoming headline. All three are bundled under the SIL Open Font
  License in `src/renderer/src/assets/fonts`; nothing is fetched at runtime.
- **Colour.** Paper `#fbfaf7`, ink `#232323`, muted `#514e47`, nav-off `#6c695f`, line `#e1ded6`,
  box rule `#c7c4bb`, separator `#b8b5ab`, quote rule `#a6a399`. Status: ok `#3d6b51`, error
  `#96453c`, gold `#84754e`. The accent *is* the ink: primary actions are ink-filled.
- **Shape.** 3 px corners on everything. Boxes are white with a 1 px warm-grey rule. No drop
  shadows, no blur, no gradients. Dotted rules mark things that are optional or held out.
- **Voice.** Labels are bold, uppercase, tracked 0.10–0.16 em. Body is 13–15 px at 1.5–1.6 leading.
- **Motion.** 0.18 s colour transitions on hover; one short entrance for the logo. Nothing loops.
- **Signature detail.** A 4 px vertical rule with chamfered ends (the site's pull-quote marker).

## Direction

**Runway, not usage.** The vocabulary is *runway*: how much room is left before a window
throttles you, and when it resets. Meters show *used* percent (what the API reports) but the
numbers people scan say *headroom* and *resets in 2h 14m*.

**Signature element: the binding-window gauge.** The active account is the hero. Its card shows
one large monospaced number, the headroom of its *binding window* (the 5-hour session, or a
weekly window once it is past the warn line and tighter than the session), with the window name
and reset countdown under it, and the other two windows as quiet secondary meters. The hero card carries the brand's chamfered gold rule down
its left edge. Every other account repeats the same gauge at a smaller scale. When a swap
happens, the new active card rises to the hero slot with a critically damped layout spring; this
is the one orchestrated moment in the app.

**Paper as glass.** The window shows macOS vibrancy through a paper tint; cards are translucent, blurred surfaces with a bright inset top edge, and `prefers-reduced-transparency` makes them solid. Light
is canonical, matching the site; dark is a faithful inversion in the same warm neutrals.

## Tokens

See `src/renderer/src/styles/tokens.css`. Roles, light values:

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#fbfaf7` | window ground |
| `--surface` | `#ffffff` | cards and inputs |
| `--text` / `--text-2` / `--text-3` | `#232323` / `#514e47` / `#6c695f` | ink, muted, labels |
| `--hairline` / `--hairline-strong` / `--sep` | `#e1ded6` / `#c7c4bb` / `#b8b5ab` | dividers, box rules, emphasis rules |
| `--ink` | `#232323` | primary actions, ACTIVE tag, toggles on, threshold tick |
| `--gold` | `#84754e` | hero rule, armed state, swap events, warn bucket |
| `--ok` / `--danger` | `#3d6b51` / `#96453c` | headroom ≥ 30 / ≤ 10 or at threshold |

Type scale (Montserrat unless noted; tracking is size-specific):

| Role | Size / weight / tracking |
| --- | --- |
| Wordmark | Lora 18px / 400 |
| Empty-state headline | Lora 26px / 400 |
| Hero number | 52px / 700 / -0.03em, line-height 1 |
| Card number | 26px / 700 / -0.02em |
| Name | 14–16px / 700 / -0.01em |
| Body | 13px / 400 / 0, leading 1.5 |
| Label / eyebrow / button | 10–11px / 700 / +0.10–0.14em, uppercase |
| Log line | Space Mono 11px / 400 |

Spacing: 4-pt grid. Card padding 16 (hero 18, with 24 on the ruled side), gaps 12, section gaps
24, window padding 20. Radius 3 everywhere. No shadows.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ●●●   Session Manager (Lora) [AUTO-SWAP ARMED] 12 s ago [↻ REFRESH CLAUDE]│  toolbar, 1px rule
├──────────────────────────────────────┬───────────────────────────────────┤
│ ACTIVE ───────────────────────────── │ CODEX ─── 3 min ago ↻ REFRESH HIDE│
│ ┃ work  work@acme.dev   MAX  [ACTIVE]│ │ PRO · me@…   5-hour ▓▓▓░ 41%  │ │
│ ┃  37%  HEADROOM                     │ │              Weekly ▓▓▓▓▓░ 71%│ │
│ ┃  Fable weekly · resets in 2d 3h    │ AUTO-SWAP ─────────────────────── │
│ ┃  ▓▓▓▓▓▓▓▓▓░░░░░│░                  │ threshold 90 · margin 10 · 5 min  │
│ ┃  5-hour ▓▓░░ 21%  Weekly ▓▓▓░ 51%  │ STAY — work has 37% headroom      │
│ STANDBY (2) ──────────────────────── │ Auto-swap            [■ ]          │
│ ┌───────────────┐ ┌ ─ ─ ─ ─ ─ ─ ─ ┐  │ Dry run              [  ]          │
│ │ personal 82%  │   alt 5% HELD OUT  │ ACTIVITY ───────────────────── 6  │
│ │ [SWITCH]      │ └ ─ ─ ─ ─ ─ ─ ─ ┘  │ 18:42 ▪ Switched work → personal  │
│ ┆ ADD ACCOUNT  [CAPTURE] Log in… ┆   │ 18:41 ▪ Fable weekly at 91% …     │
└──────────────────────────────────────┴───────────────────────────────────┘
```

Left column (fluid, min 560): hero card, standby grid (2-up, 1-up under 960), dotted add-account
row. Right column (320 fixed): Codex, Auto-swap, Activity; scrolls independently. Section heads
are tracked uppercase labels over a hairline. Empty state: a dotted box with the Lora headline,
one sentence, and the two add actions. No illustration.

## Motion

Springs only, via `motion/react`, `type: 'spring', bounce: 0, duration: 0.4`. Layout reorder
after a swap uses the same spring. Meter fills animate width on data change. Press feedback is
`scale: 0.96` on pointer-down, nothing else. Hover is a 0.18 s colour transition on exact
properties, never `all`. Toasts enter from the top edge and leave the same way, softer on exit.
`prefers-reduced-motion`: cross-fades only. No entrance animation on load beyond a 150 ms fade.

## Copy

Sentence case in prose; uppercase only where the label system says so. Verbs name outcomes:
"Switch to this account", "Capture current login", "Log in with browser", "Hold out of rotation" /
"Return to rotation", "Remove". Toasts repeat the verb: "Switched to personal". Errors say what
happened and what to do. Empty activity: "Nothing yet. Swaps and errors show up here."

## Quality floor

Keyboard focus visible (ink ring, 2px, offset 2px). Every control has an accessible name.
Contrast ≥ 4.5:1 for text on surfaces. Icons are inline SVG in `currentColor`, 2 px stroke beside
bold text. Resizes cleanly to 860×600. Light and dark both first-class. No layout shift when
numbers change (monospace, fixed widths).
