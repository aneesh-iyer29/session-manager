/**
 * Mirrors the backend's AppState. The renderer never polls: it asks once on
 * mount and then relies on `onState` pushes, exactly as the architecture doc
 * describes. Returning `null` until the first snapshot lets App render nothing
 * instead of a flash of empty state.
 */
import { useEffect, useState } from 'react'
import type { AppState } from '@shared/types'
import { getApi } from '../api'

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    const api = getApi()
    let alive = true
    const off = api.onState((s) => {
      if (alive) setState(s)
    })
    api.getState().then((s) => {
      if (alive) setState(s)
    }, () => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}
