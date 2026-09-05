import { motion, useReducedMotion } from 'motion/react'
import type { UsageWindow } from '@shared/types'
import { clampPct, formatCountdown, formatPercent, headroomBucket, type Bucket } from '../lib/format'
import { spring } from '../lib/motion'

interface MeterProps {
  /** Used percent, 0-100. */
  pct: number | null
  bucket?: Bucket
  hero?: boolean
  /** Autoswap threshold; drawn as a tick on hero meters so "near limit" is visible. */
  threshold?: number
  label: string
}

/**
 * A horizontal fill showing *used* percent, coloured by headroom. The fill
 * animates width on data change; under reduced motion it snaps.
 */
export function Meter({ pct, bucket, hero = false, threshold, label }: MeterProps) {
  const reduced = useReducedMotion()
  const used = pct == null ? 0 : clampPct(pct)
  const tone = bucket ?? headroomBucket(pct == null ? null : 100 - used)
  return (
    <div
      className={`meter${hero ? ' meter--hero' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(used)}
      aria-valuetext={pct == null ? 'unknown' : `${Math.round(used)}% used`}
    >
      <motion.div
        className={`meter__fill meter__fill--${tone}`}
        initial={false}
        animate={{ width: `${used}%` }}
        transition={reduced ? { duration: 0 } : spring}
      />
      {hero && threshold != null ? <div className="meter__tick" style={{ left: `${clampPct(threshold)}%` }} aria-hidden /> : null}
    </div>
  )
}

interface RowProps {
  window: UsageWindow
  now: Date
  threshold?: number
}

/** "5-hour ▓▓░░ 21%  2h 14m" — the quiet secondary meters under a gauge. */
export function MeterRow({ window: w, now, threshold }: RowProps) {
  const headroom = 100 - clampPct(w.pct)
  const bucket = headroomBucket(headroom, threshold != null && w.pct >= threshold)
  return (
    <div className="meter-row">
      <span className="meter-row__label">{w.label}</span>
      <Meter pct={w.pct} bucket={bucket} label={`${w.label} used`} />
      <span className="meter-row__pct">{formatPercent(w.pct)}</span>
      <span className="meter-row__reset">
        {formatCountdown(w.resetsAt, now)}
      </span>
    </div>
  )
}
