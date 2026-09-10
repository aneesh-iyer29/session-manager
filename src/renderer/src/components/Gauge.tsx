import type { Account, Settings } from '@shared/types'
import { bindingWindowOf, formatCountdown, headroomBucket, swapLineFor } from '../lib/format'
import { Meter } from './Meter'

interface Props {
  account: Account
  now: Date
  settings: Pick<Settings, 'fiveHourThreshold' | 'threshold'>
  hero?: boolean
}

/**
 * The signature element: one number (headroom of the binding window: the
 * 5-hour session, or a weekly window once it is the tighter one), the window's
 * name and reset countdown, and the meter. The hero variant adds the tick for
 * that window's swap line so the user sees how close the swap is.
 */
export function Gauge({ account, now, settings, hero = false }: Props) {
  const binding = bindingWindowOf(account)
  const headroom = account.headroom
  const threshold = swapLineFor(binding?.key ?? 'five_hour', settings)
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
