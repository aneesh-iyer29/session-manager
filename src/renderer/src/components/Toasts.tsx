import { AnimatePresence, motion } from 'motion/react'
import { useToasts } from '../hooks/useToasts'
import { spring } from '../lib/motion'

/** Toasts enter from the top edge and leave the same way; reduced motion turns that into a fade. */
export function Toasts() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast${t.tone === 'error' ? ' toast--error' : ''}`}
            role={t.tone === 'error' ? 'alert' : 'status'}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={spring}
          >
            <span>{t.message}</span>
            <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
