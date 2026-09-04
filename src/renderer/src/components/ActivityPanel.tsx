import type { SwapperEvent } from '@shared/types'
import { formatClock, formatDay } from '../lib/format'

interface Props {
  events: SwapperEvent[]
  now: Date
}

/** The log, newest first. Mono so times align; a day prefix only when it isn't today. */
export function ActivityPanel({ events, now }: Props) {
  const today = now.toDateString()
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
          <ol className="activity" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {events.map((e) => {
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
        )}
      </div>
    </section>
  )
}
