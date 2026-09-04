import { useEffect, useState } from 'react'
import { Button } from './Button'

interface Props {
  onConfirm: () => void
  disabled?: boolean
  label?: string
}

const CONFIRM_WINDOW_MS = 4000

/**
 * Destructive action without a modal: the first click arms the button and a
 * second click within four seconds fires. Leaving it alone disarms it.
 */
export function RemoveButton({ onConfirm, disabled, label = 'Remove' }: Props) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS)
    return () => window.clearTimeout(id)
  }, [armed])

  return (
    <Button
      variant="danger"
      size="sm"
      confirming={armed}
      disabled={disabled}
      aria-label={armed ? `Confirm ${label.toLowerCase()}` : label}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? 'Click again to remove' : label}
    </Button>
  )
}
