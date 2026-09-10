import { useState } from 'react'
import type { SwapperEvent } from '@shared/types'
import { formatClock, formatDay } from '../lib/format'
import { Button } from './Button'

interface Props {
  events: SwapperEvent[]
  now: Date
}

/**
 * Rows shown before the log folds. The backend sends up to a hundred events;
 * a dozen is about one screen of the right column, so the panel stays a
 * glance rather than a scroll. The rest is one click away.
 */
export const ACTIVITY_VISIBLE = 12

/** The log, newest first. Mono so times align; a day prefix only when it isn't today. */
export function ActivityPanel({ events, now }: Props) {
  const [expanded, setExpanded] = useState(false)
  const today = now.toDateString()
  const hidden = Math.max(0, events.length - ACTIVITY_VISIBLE)
  const shown = expanded ? events : events.slice(0, ACTIVITY_VISIBLE)
  return (
    <section className="section" aria-label="Activity">
      <div className="section__head">
        <span className="eyebrow">Activity</span>
        {events.length > 0 ? <span className="badge">{events.length}</span> : null}
      </div>
      <div className="card">
        {events.length === 0 ? (
          <p className="activity__empty" style={{ margin: 0 }}>
            Nothing yet. Swaps and errors show up here.
          </p>
        ) : (
          <>
            <ol className="activity" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {shown.map((e) => {
                const sameDay = new Date(e.at).toDateString() === today
                return (
                  <li key={e.id} className="activity__row">
                    <span className="activity__time" title={new Date(e.at).toLocaleString()}>
                      {sameDay ? formatClock(e.at) : formatDay(e.at)}
                    </span>
                    <span className={`activity__dot activity__dot--${e.kind}`} aria-hidden />
                    <span className={`activity__msg${e.kind === 'error' ? ' activity__msg--error' : ''}`}>{e.message}</span>
                  </li>
                )
              })}
            </ol>
            {hidden > 0 ? (
              <div className="activity__more">
                <Button variant="quiet" size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Show less' : `Show ${hidden} more`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
