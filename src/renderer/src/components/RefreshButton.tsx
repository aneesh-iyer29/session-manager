import { Button } from './Button'

interface Props {
  /** True while the refresh this button triggers is in flight: the glyph spins and the button is disabled. */
  spinning: boolean
  onClick: () => void
  /** Visible label, e.g. "Refresh Claude". */
  label: string
  /** Accessible name, e.g. "Refresh Claude usage". */
  ariaLabel: string
  variant?: 'default' | 'quiet'
}

/**
 * The circular-arrow button. The toolbar (Claude accounts) and the Codex panel
 * each have one, so the two refreshes look the same and spin the same way.
 */
export function RefreshButton({ spinning, onClick, label, ariaLabel, variant = 'default' }: Props) {
  return (
    <Button size="sm" variant={variant} onClick={onClick} disabled={spinning} aria-label={ariaLabel}>
      <svg
        className={`btn__glyph${spinning ? ' btn__glyph--spin' : ''}`}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      {label}
    </Button>
  )
}
