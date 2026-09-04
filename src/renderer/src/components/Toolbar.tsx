import type { AppState } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatAgo } from '../lib/format'
import { Button } from './Button'

interface Props {
  state: AppState
  now: Date
  actions: Actions
}

export type ArmedState = 'armed' | 'dry' | 'off'

export function armedState(settings: AppState['settings']): ArmedState {
  if (!settings.autoswapEnabled) return 'off'
  return settings.dryRun ? 'dry' : 'armed'
}

/**
 * Translucent title strip under the hidden macOS title bar. The whole strip
 * drags the window; the controls opt out so clicks reach them.
 */
export function Toolbar({ state, now, actions }: Props) {
  const armed = armedState(state.settings)
  const refreshing = actions.busy.has('refresh') || state.polling.inFlight
  return (
    <header className="toolbar">
      <span className="toolbar__title">Claude Swapper</span>
      <div className="toolbar__controls">
        <ArmedPill armed={armed} />
        <span className="toolbar__age" aria-live="polite" title={state.polling.lastPollAt ? `Last poll ${new Date(state.polling.lastPollAt).toLocaleTimeString()}` : undefined}>
          {formatAgo(state.polling.lastPollAt, now)}
        </span>
        <Button size="sm" onClick={() => actions.refresh()} disabled={refreshing} aria-label="Refresh usage">
          <span className={`btn__glyph${refreshing ? ' btn__glyph--spin' : ''}`} aria-hidden>
            ⟳
          </span>
          Refresh
        </Button>
      </div>
    </header>
  )
}

export function ArmedPill({ armed }: { armed: ArmedState }) {
  if (armed === 'armed')
    return (
      <span className="pill pill--armed">
        <span className="pill__dot" aria-hidden />
        Auto-swap armed
      </span>
    )
  if (armed === 'dry')
    return (
      <span className="pill pill--dry">
        <span className="pill__dot" aria-hidden />
        Auto-swap dry run
      </span>
    )
  return <span className="pill">Auto-swap off</span>
}
