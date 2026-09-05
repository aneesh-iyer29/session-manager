import type { Account } from '@shared/types'
import { bindingWindowOf, formatCountdown, headroomBucket } from '../lib/format'
import { Meter } from './Meter'

interface Props {
  account: Account
  now: Date
  threshold: number
  hero?: boolean
}

/**
 * The signature element: one number (headroom of the binding window), the
 * window's name and reset countdown, and the meter. The hero variant adds the
 * autoswap threshold tick so the user sees how close the swap is.
 */
export function Gauge({ account, now, threshold, hero = false }: Props) {
  const binding = bindingWindowOf(account)
  const headroom = account.headroom
  const atThreshold = binding != null && binding.pct >= threshold
  const bucket = headroomBucket(headroom, atThreshold)
  const usage = account.usage

  return (
    <div className={`gauge${hero ? ' gauge--hero' : ''}`}>
      <div className="gauge__row">
        <span className={`gauge__number gauge__number--${bucket}`} aria-label={headroom == null ? 'Headroom unknown' : `${headroom}% headroom`}>
          {headroom == null ? '—' : `${binding?.estimated ? '≈' : ''}${Math.round(headroom)}%`}
        </span>
        <span className="gauge__unit">headroom</span>
      </div>
      <div className="gauge__window">
        {binding ? (
          <>
            <span>{binding.label}</span>
            <span aria-hidden>·</span>
            <span>resets in</span>
            <span className="mono">{formatCountdown(binding.resetsAt, now)}</span>
          </>
        ) : usage && !usage.ok ? (
          <span>{usage.error ?? 'Usage unavailable'}</span>
        ) : (
          <span>Usage not fetched yet</span>
        )}
      </div>
      {hero ? (
        <Meter pct={binding?.pct ?? null} bucket={bucket} hero threshold={threshold} label={binding ? `${binding.label} used` : 'Usage'} />
      ) : null}
    </div>
  )
}
