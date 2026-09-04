import { useEffect, useState, type ChangeEvent } from 'react'
import type { AppState, Decision, Settings, Strategy } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatAgo, formatDuration } from '../lib/format'
import { Button } from './Button'
import { Toggle } from './Toggle'

interface Props {
  state: AppState
  now: Date
  actions: Actions
}

type Draft = Pick<Settings, 'strategy' | 'threshold' | 'margin' | 'cooldownSeconds' | 'pollIntervalSeconds' | 'model'>

const pick = (s: Settings): Draft => ({
  strategy: s.strategy,
  threshold: s.threshold,
  margin: s.margin,
  cooldownSeconds: s.cooldownSeconds,
  pollIntervalSeconds: s.pollIntervalSeconds,
  model: s.model,
})

const same = (a: Draft, b: Draft) => (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k])

/**
 * Policy knobs. Numeric fields edit a local draft with one Save (so a half-
 * typed threshold never triggers a swap); the toggles save immediately because
 * each is a complete decision on its own.
 */
export function AutoswapPanel({ state, now, actions }: Props) {
  const settings = state.settings
  const [draft, setDraft] = useState<Draft>(() => pick(settings))
  const saving = actions.busy.has('settings')

  // Adopt backend changes (tray toggles, another window) unless the user is mid-edit.
  const dirty = !same(draft, pick(settings))
  const [seen, setSeen] = useState(settings)
  useEffect(() => {
    if (seen === settings) return
    const before = pick(seen)
    setSeen(settings)
    // Only clobber the draft when it still equals what we last saw from the backend.
    if (same(draft, before)) setDraft(pick(settings))
  }, [settings, seen, draft])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const num = (key: keyof Draft, fallback: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.valueAsNumber
    set(key, (Number.isNaN(v) ? fallback : v) as never)
  }

  const quick = (patch: Partial<Settings>, message: string) => actions.updateSettings(patch, message)

  return (
    <section className="section panel" aria-label="Auto-swap">
      <div className="section__head">
        <span className="eyebrow">Auto-swap</span>
      </div>

      <div className="card panel">
        <div className="panel__summary">
          threshold {settings.threshold} · margin {settings.margin} · cooldown {formatDuration(settings.cooldownSeconds)} · every{' '}
          {formatDuration(settings.pollIntervalSeconds)}
        </div>
        <DecisionLine decision={state.autoswap.lastDecision} state={state} now={now} />

        <div className="toggle-list">
          <Toggle
            label="Auto-swap"
            hint={settings.autoswapEnabled ? 'Switches accounts on its own' : 'Off. Usage is still watched.'}
            checked={settings.autoswapEnabled}
            disabled={saving}
            onChange={(v) => quick({ autoswapEnabled: v }, v ? 'Auto-swap armed' : 'Auto-swap off')}
          />
          <Toggle
            label="Dry run"
            hint="Log decisions without switching"
            checked={settings.dryRun}
            disabled={saving}
            onChange={(v) => quick({ dryRun: v }, v ? 'Dry run on' : 'Dry run off')}
          />
          <Toggle
            label="Notifications"
            checked={settings.notify}
            disabled={saving}
            onChange={(v) => quick({ notify: v }, v ? 'Notifications on' : 'Notifications off')}
          />
        </div>
      </div>

      <div className="card panel">
        <div className="field-grid">
          <label className="field field--wide">
            <span className="field__label">Strategy</span>
            <select className="field__input" value={draft.strategy} onChange={(e) => set('strategy', e.target.value as Strategy)}>
              <option value="best">Best headroom</option>
              <option value="consume_first">Consume soonest reset first</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">Threshold (%)</span>
            <input className="field__input" type="number" min={50} max={100} step={1} value={draft.threshold} onChange={num('threshold', settings.threshold)} />
          </label>
          <label className="field">
            <span className="field__label">Margin (%)</span>
            <input className="field__input" type="number" min={0} max={50} step={1} value={draft.margin} onChange={num('margin', settings.margin)} />
          </label>
          <label className="field">
            <span className="field__label">Cooldown (s)</span>
            <input className="field__input" type="number" min={0} step={30} value={draft.cooldownSeconds} onChange={num('cooldownSeconds', settings.cooldownSeconds)} />
          </label>
          <label className="field">
            <span className="field__label">Poll every (s)</span>
            <input className="field__input" type="number" min={15} step={15} value={draft.pollIntervalSeconds} onChange={num('pollIntervalSeconds', settings.pollIntervalSeconds)} />
          </label>
          <label className="field field--wide">
            <span className="field__label">Gating model window</span>
            <input className="field__input" type="text" value={draft.model} maxLength={40} onChange={(e) => set('model', e.target.value)} />
          </label>
        </div>
        <div className="panel__actions">
          <span className="spacer" />
          {dirty ? (
            <Button variant="quiet" size="sm" onClick={() => setDraft(pick(settings))}>
              Revert
            </Button>
          ) : null}
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => actions.updateSettings(draft)}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="card panel">
        <div className="toggle-list">
          <Toggle
            label="Launch at login"
            checked={settings.launchAtLogin}
            disabled={saving}
            onChange={(v) => quick({ launchAtLogin: v }, v ? 'Will launch at login' : "Won't launch at login")}
          />
          <Toggle
            label="Show in Dock"
            hint={settings.showInDock ? undefined : 'Menu bar only'}
            checked={settings.showInDock}
            disabled={saving}
            onChange={(v) => quick({ showInDock: v }, v ? 'Shown in Dock' : 'Hidden from Dock')}
          />
        </div>
      </div>
    </section>
  )
}

function DecisionLine({ decision, state, now }: { decision: Decision | null; state: AppState; now: Date }) {
  if (!decision) return <div className="panel__decision">No decision yet.</div>
  const target = decision.targetId ? state.accounts.find((a) => a.id === decision.targetId) : null
  const label = decision.action === 'switch' && target ? `switch → ${target.alias || target.email}` : decision.action
  return (
    <div className="panel__decision" title={`Decided ${formatAgo(decision.at, now)}`}>
      <span className={`panel__decision-action panel__decision-action--${decision.action}`}>{label}</span>
      <span>— {decision.reason}</span>
    </div>
  )
}
