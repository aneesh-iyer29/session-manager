import type { CodexState, Settings } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatAgo, formatPlan } from '../lib/format'
import { Button } from './Button'
import { MeterRow } from './Meter'
import { RefreshButton } from './RefreshButton'

interface Props {
  codex: CodexState
  settings: Settings
  now: Date
  actions: Actions
}

/**
 * Read-only quota for the one Codex login. Nothing here switches anything.
 * The header's Refresh re-fetches only Codex, so after `codex login` the new
 * account shows up without waiting for the next poll; the toolbar's Refresh
 * leaves Codex alone.
 */
export function CodexPanel({ codex, settings, now, actions }: Props) {
  const refreshing = actions.busy.has('refresh:codex')
  const fetchedAt = codex.usage?.fetchedAt ?? null
  return (
    <section className="section" aria-label="Codex">
      <div className="section__head">
        <span className="eyebrow">Codex</span>
        <div className="section__actions">
          {settings.codexEnabled ? (
            <>
              {fetchedAt ? <span className="section__age">{formatAgo(fetchedAt, now)}</span> : null}
              <RefreshButton variant="quiet" spinning={refreshing} onClick={() => actions.refreshCodex()} label="Refresh" ariaLabel="Refresh Codex usage" />
            </>
          ) : null}
          <Button
            variant="quiet"
            size="sm"
            onClick={() => actions.updateSettings({ codexEnabled: !settings.codexEnabled }, settings.codexEnabled ? 'Codex hidden' : 'Codex shown')}
          >
            {settings.codexEnabled ? 'Hide' : 'Show'}
          </Button>
        </div>
      </div>
      <div className="card">
        <CodexBody codex={codex} enabled={settings.codexEnabled} now={now} />
      </div>
    </section>
  )
}

function CodexBody({ codex, enabled, now }: { codex: CodexState; enabled: boolean; now: Date }) {
  if (!enabled) return <p className="card__note" style={{ marginTop: 0 }}>Hidden. Codex usage isn't polled.</p>
  if (!codex.configured)
    return (
      <p className="card__note" style={{ marginTop: 0 }}>
        Not logged in. Run <span className="mono">codex login</span> to see its quota here.
      </p>
    )
  if (codex.mode === 'apikey')
    return <p className="card__note" style={{ marginTop: 0 }}>Using an API key. Usage limits don't apply.</p>

  const usage = codex.usage
  return (
    <>
      <div className="codex__identity">
        {codex.plan ? <span className="card__meta" style={{ color: 'var(--text)', fontWeight: 600 }}>{formatPlan(codex.plan)}</span> : null}
        <span className="card__email" title={codex.email ?? undefined}>
          {codex.email ?? 'ChatGPT login'}
        </span>
      </div>
      {usage?.ok ? (
        <div className="meter-list meter-list--compact">
          {usage.windows.map((w) => (
            <MeterRow key={w.key} window={w} now={now} />
          ))}
        </div>
      ) : (
        <p className="card__note card__note--danger">{usage?.error ?? 'Usage not fetched yet'}</p>
      )}
    </>
  )
}
