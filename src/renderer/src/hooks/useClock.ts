/**
 * A shared 1 s tick for countdowns and "12 s ago". One interval for the whole
 * tree keeps every timer in lockstep so numbers never change out of phase.
 */
import { useEffect, useState } from 'react'

export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
