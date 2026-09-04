import { motion } from 'motion/react'
import { spring } from '../lib/motion'

interface Props {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

/** A macOS-style switch row. The label is the accessible name; the knob slides on the shared spring. */
export function Toggle({ checked, onChange, label, hint, disabled }: Props) {
  return (
    <div className="toggle-row">
      <div>
        <div className="toggle-row__label">{label}</div>
        {hint ? <div className="toggle-row__hint">{hint}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <motion.span className="switch__knob" animate={{ x: checked ? 14 : 0 }} transition={spring} />
      </button>
    </div>
  )
}
