import { motion } from 'motion/react'
import type { Account, Settings } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatClock, formatPlan, secondaryWindows } from '../lib/format'
import { spring } from '../lib/motion'
import { Button } from './Button'
import { Gauge } from './Gauge'
import { TokenBadge } from './HeroCard'
import { MeterRow } from './Meter'
import { NameEdit } from './NameEdit'
import { RemoveButton } from './RemoveButton'

interface Props {
  account: Account
  settings: Settings
  now: Date
  actions: Actions
}

/** A standby account: the same gauge at card scale plus the three actions. */
export function AccountCard({ account, settings, now, actions }: Props) {
  const secondary = secondaryWindows(account.usage, account.bindingWindow)
  const switching = actions.busy.has(`switch:${account.id}`)
  const disabling = actions.busy.has(`disable:${account.id}`)
  const removing = actions.busy.has(`remove:${account.id}`)
  const usage = account.usage
  const dead = account.tokenStatus === 'dead'

  return (
    <motion.article
      layout
      layoutId={account.id}
      transition={spring}
      className={`card${account.disabled ? ' card--disabled' : ''}`}
      aria-label={`Standby account ${account.email}`}
    >
      <header className="card__head">
        <div className="card__identity">
          <NameEdit account={account} onSave={(alias) => actions.setAlias(account, alias)} />
          {account.plan ? <span className="card__meta">{formatPlan(account.plan)}</span> : null}
        </div>
        <TokenBadge status={account.tokenStatus} />
        {account.disabled ? <span className="badge">Held out</span> : null}
      </header>

      <div className="card__email" title={account.email} style={{ marginTop: -8, marginBottom: 12 }}>
        {account.email}
      </div>

      <Gauge account={account} now={now} threshold={settings.threshold} />

      {secondary.length > 0 ? (
        <div className="meter-list meter-list--compact">
          {secondary.map((w) => (
            <MeterRow key={w.key} window={w} now={now} threshold={settings.threshold} />
          ))}
        </div>
      ) : null}

      {usage && !usage.ok && usage.error && usage.windows.length > 0 ? (
        <p className="card__note card__note--warn">
          {usage.error} · numbers from {formatClock(usage.fetchedAt)}
        </p>
      ) : null}

      <div className="card__actions">
        <Button variant="primary" size="sm" disabled={switching || dead} onClick={() => actions.switchTo(account)} title={dead ? 'Log in again to use this account' : undefined}>
          {switching ? 'Switching…' : 'Switch to this account'}
        </Button>
        <Button variant="quiet" size="sm" disabled={disabling} onClick={() => actions.setDisabled(account, !account.disabled)}>
          {account.disabled ? 'Return to rotation' : 'Hold out of rotation'}
        </Button>
        <span className="spacer" />
        <RemoveButton disabled={removing} onConfirm={() => actions.removeAccount(account)} />
      </div>
    </motion.article>
  )
}
