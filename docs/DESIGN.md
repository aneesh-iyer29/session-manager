# Design brief

Claude Swapper is a professional-grade macOS utility. Its single job: tell one developer, at a
glance, **which Claude account is live, how much Fable runway each account has, and whether the
auto-swap is armed**, and let them act in one click. The audience is the owner (a power user
running Fable agents all day); the register is Activity Monitor / Instruments, not a SaaS
dashboard. Every element must earn its place.

## Direction

**Runway, not usage.** The product's vocabulary is *runway*: how much room is left before a
window throttles you, and when that window resets. Meters show *used* percent (what the API
reports) but the copy and the numbers people scan say *headroom* and *resets in 2h 14m*.

**Signature element: the binding-window gauge.** The active account is the hero. Its card shows
one large number, the headroom of its *binding window* (the most constrained of 5-hour /
Weekly / Fable weekly), with the window name and reset countdown under it, and the other two
windows as quiet secondary meters. Every other account card repeats the same gauge at a
smaller scale. When a swap happens, the new active card rises to the hero slot with a
critically damped layout spring; this is the one orchestrated moment in the app.

**Native materials.** The window uses macOS vibrancy under a translucent toolbar
(`titleBarStyle: hiddenInset`), the system font stack (`-apple-system, "SF Pro Text"`) with
`font-variant-numeric: tabular-nums` on every number, and SF Mono for reset times and the
activity log. No custom web fonts, no gradients as decoration, no cards-inside-cards.

## Tokens

Colors are macOS semantic colors so the app feels at home in both appearances.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#F5F5F7` | `#1C1C1E` | window ground (under vibrancy, mostly translucent) |
| `--surface` | `rgba(255,255,255,0.72)` | `rgba(44,44,46,0.66)` | cards; `backdrop-filter: blur(20px) saturate(180%)` |
| `--text` | `#1D1D1F` | `#F5F5F7` | primary text |
| `--text-2` | `#6E6E73` | `#98989D` | secondary text, labels |
| `--hairline` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.10)` | dividers, card edges |
| `--accent` | `#5E5CE6` | `#6E6CF6` | system indigo, primary actions and the ACTIVE marker |
| `--ok` | `#34C759` | `#30D158` | headroom ≥ 30 |
| `--warn` | `#FF9500` | `#FF9F0A` | headroom 11–29 |
| `--danger` | `#FF3B30` | `#FF453A` | headroom ≤ 10 (or at/over threshold) |

Type scale (system font; tracking is size-specific):

| Role | Size / weight / tracking |
| --- | --- |
| Hero number | 56px / 600 / -0.03em, line-height 1 |
| Card number | 28px / 600 / -0.02em |
| Title | 17px / 600 / -0.01em |
| Body | 13px / 400 / 0 |
| Label / eyebrow | 11px / 500 / +0.04em, uppercase, `--text-2` |
| Mono | 12px SF Mono for times, ids, log lines |

Spacing: 4-pt grid. Card padding 16, gaps 12, section gaps 24. Radius 12 for cards, 8 for
controls, 999 for pills. Shadows only on the hero card: `0 1px 2px rgba(0,0,0,.06), 0 8px 24px
rgba(0,0,0,.08)`.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ●●●   Claude Swapper          [Auto-swap ● armed]  [Dry run]  ⟳ 12s ago  │  toolbar (translucent)
├──────────────────────────────────────┬───────────────────────────────────┤
│ ACTIVE                               │ CODEX                             │
│ ┌──────────────────────────────────┐ │ ┌───────────────────────────────┐ │
│ │ work@…  Max  · ACTIVE            │ │ │ pro · me@…   5h ▓▓▓░ 41%      │ │
│ │  37%  headroom                   │ │ │              wk ▓▓▓▓▓▓░ 71%   │ │
│ │  Fable weekly · resets in 2d 4h  │ │ └───────────────────────────────┘ │
│ │  5-hour ▓▓░░░ 21%  Weekly ▓▓▓░ 5│ │ AUTO-SWAP                         │
│ └──────────────────────────────────┘ │ threshold 90 · margin 10 · 5 min  │
│ STANDBY (2)                          │ last decision: stay — 37% > 10%   │
│ ┌───────────────┐ ┌───────────────┐  │ [strategy ▾] [threshold] [Save]   │
│ │ personal 82%  │ │ alt 9%  ⏸     │  │                                   │
│ │ Fable · 3d 1h │ │ resets 2h 05m │  │ ACTIVITY                          │
│ │ [Switch]      │ │ disabled      │  │ 18:42 switched work → personal    │
│ └───────────────┘ └───────────────┘  │ 18:41 autoswap: Fable at 91%      │
│ + Add account  (Capture · Browser)   │ 17:10 refreshed 3 accounts        │
└──────────────────────────────────────┴───────────────────────────────────┘
```

Left column (fluid, min 560): hero card, standby grid (2-up, 1-up under 960), add-account row.
Right column (320 fixed): Codex, Auto-swap, Activity. The right column scrolls independently.
Empty state (no accounts): the hero slot becomes a single quiet invitation with the two add
actions and one sentence about what happens next; no illustration.

## Motion

Springs only, via `motion/react`. Defaults: `type: 'spring', bounce: 0, duration: 0.4`
(critically damped). Layout reorder after a swap: `layout` with the same spring. Meter fills
animate width on data change. Press feedback: `scale: 0.97` on pointer-down (`whileTap`).
Toasts slide from the top edge and leave the same way. Respect `prefers-reduced-motion`: cross
fades only. Nothing loops. No entrance animations on initial load beyond a 150 ms fade.

## Copy

Sentence case. Verbs name outcomes: "Switch to this account", "Capture current login", "Log in
with browser", "Hold out of rotation" / "Return to rotation", "Remove". Toasts repeat the verb:
"Switched to personal". Errors say what happened and what to do: "Claude Code isn't logged in.
Run `claude` and sign in, then capture again." Empty activity: "Nothing yet. Swaps and errors
show up here."

## Quality floor

Keyboard focus visible (accent ring, 2px, offset 2px). Every control has an accessible name.
Contrast ≥ 4.5:1 for text on surfaces. Resizes cleanly to 860×600. Dark and light both
first-class; test both. No layout shift when numbers change (tabular nums, fixed widths).
