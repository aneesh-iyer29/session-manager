/**
 * Toast queue. Kept in context so any component can report an outcome without
 * threading callbacks; the stack itself is rendered once in App.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastTone = 'info' | 'error'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
}

interface ToastApi {
  toasts: Toast[]
  push: (message: string, tone?: ToastTone) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const TTL_MS: Record<ToastTone, number> = { info: 3200, error: 7000 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = ++seq.current
      // Three at most: older ones give way rather than piling up.
      setToasts((list) => [...list.slice(-2), { id, tone, message }])
      window.setTimeout(() => dismiss(id), TTL_MS[tone])
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss])
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToasts outside ToastProvider')
  return ctx
}
