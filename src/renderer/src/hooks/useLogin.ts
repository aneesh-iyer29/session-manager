/**
 * Browser login is the one multi-step flow: start, then poll `loginStatus`
 * every second until it settles. The main process opens the browser itself;
 * the renderer only reports progress and offers Cancel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoginStatus } from '@shared/types'
import { getApi } from '../api'
import { displayName } from '../lib/format'
import { errorMessage } from './useActions'
import { useToasts } from './useToasts'

export interface LoginState {
  pending: LoginStatus | null
  start: () => Promise<void>
  cancel: () => Promise<void>
}

export function useLogin(): LoginState {
  const { push } = useToasts()
  const [pending, setPending] = useState<LoginStatus | null>(null)
  const timer = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (timer.current != null) window.clearInterval(timer.current)
    timer.current = null
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const start = useCallback(async () => {
    const api = getApi()
    try {
      const status = await api.startLogin()
      setPending(status)
      push('Finish logging in in your browser')
      timer.current = window.setInterval(async () => {
        try {
          const next = await api.loginStatus(status.id)
          if (next.status === 'pending') return
          stopPolling()
          setPending(null)
          if (next.status === 'done') push(next.account ? `Added ${displayName(next.account)}` : 'Added account')
          else push(next.error ?? 'Login failed', 'error')
        } catch (err) {
          stopPolling()
          setPending(null)
          push(errorMessage(err), 'error')
        }
      }, 1000)
    } catch (err) {
      push(errorMessage(err), 'error')
    }
  }, [push, stopPolling])

  const cancel = useCallback(async () => {
    if (!pending) return
    stopPolling()
    setPending(null)
    try {
      await getApi().cancelLogin(pending.id)
      push('Login cancelled')
    } catch (err) {
      push(errorMessage(err), 'error')
    }
  }, [pending, push, stopPolling])

  return { pending, start, cancel }
}
