import { motion } from 'motion/react'
import type { Account, NudgeFlag, Settings } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatPlan, secondaryWindows } from '../lib/format'
import { spring } from '../lib/motion'
import { Button } from './Button'
import { Gauge } from './Gauge'
import { MeterRow } from './Meter'
import { NameEdit } from './NameEdit'

interface Props {
  account: Account
  settings: Settings
  now: Date
  actions: Actions
  nudge?: NudgeFlag | null
}

/**
 * The active account. `layoutId` matches the standby card for the same id so
 * a swap animates the card into this slot instead of cutting.
 */
export function HeroCard({ account, settings, now, actions, nudge = null }: Props) {
  const secondary = secondaryWindows(account.usage, account.bindingWindow)
  const disabling = actions.busy.has(`disable:${account.id}`)
  const usage = account.usage

  return (
    <motion.section
      layout
      layoutId={account.id}
      transition={spring}
      className={`card card--hero${account.disabled ? ' card--disabled' : ''}`}
      aria-label={`Active account ${account.email}`}
    >
      <header className="card__head">
        <div className="card__identity">
          <NameEdit account={account} onSave={(alias) => actions.setAlias(account, alias)} />
          <span className="card__email" title={account.email}>
            {account.email}
          </span>
          {account.plan ? <span className="card__meta">{formatPlan(account.plan)}</span> : null}
        </div>
        <TokenBadge status={account.tokenStatus} />
        {account.disabled ? <span className="badge">Held out</span> : null}
        <span className="pill pill--active">Active</span>
      </header>

      <Gauge account={account} now={now} threshold={settings.threshold} hero />

      {secondary.length > 0 ? (
        <div className="meter-list">
          {secondary.map((w) => (
            <MeterRow key={w.key} window={w} now={now} threshold={settings.threshold} />
          ))}
        </div>
      ) : null}

      {usage && !usage.ok && usage.error ? <p className="card__note card__note--danger">{usage.error}</p> : null}

      {nudge && nudge.accountId === account.id ? (
        <div className="notice" role="status">
          <span className="notice__label">Swap soon</span>
          <span className="notice__body">
            {nudge.window} is at {nudge.pct}%. Run <code>/compact</code> in Claude Code before the swap so the conversation isn't re-cached on the next account.
          </span>
        </div>
      ) : null}

      <div className="card__actions">
        <Button size="sm" disabled={disabling} onClick={() => actions.setDisabled(account, !account.disabled)}>
          {account.disabled ? 'Return to rotation' : 'Hold out of rotation'}
        </Button>
      </div>
    </motion.section>
  )
}

export function TokenBadge({ status }: { status: Account['tokenStatus'] }) {
  if (status === 'dead') return <span className="badge badge--danger">Needs login</span>
  if (status === 'expired') return <span className="badge badge--warn">Token expired</span>
  if (status === 'unknown') return <span className="badge">Token unchecked</span>
  return null
}
