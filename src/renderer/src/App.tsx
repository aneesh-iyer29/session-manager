import { LayoutGroup, MotionConfig, motion } from 'motion/react'
import type { AppState } from '@shared/types'
import { AccountCard } from './components/AccountCard'
import { ActivityPanel } from './components/ActivityPanel'
import { AddAccountRow } from './components/AddAccountRow'
import { AutoswapPanel } from './components/AutoswapPanel'
import { CodexPanel } from './components/CodexPanel'
import { EmptyState } from './components/EmptyState'
import { HeroCard } from './components/HeroCard'
import { Toasts } from './components/Toasts'
import { Toolbar } from './components/Toolbar'
import { useActions } from './hooks/useActions'
import { useAppState } from './hooks/useAppState'
import { useClock } from './hooks/useClock'
import { useLogin } from './hooks/useLogin'
import { ToastProvider } from './hooks/useToasts'
import { fade } from './lib/motion'

export function App() {
  return (
    <ToastProvider>
      {/* reducedMotion="user" drops transforms and layout moves; opacity fades stay. */}
      <MotionConfig reducedMotion="user">
        <Shell />
        <Toasts />
      </MotionConfig>
    </ToastProvider>
  )
}

function Shell() {
  const state = useAppState()
  if (!state) return null
  return <Dashboard state={state} />
}

function Dashboard({ state }: { state: AppState }) {
  const now = useClock()
  const actions = useActions()
  const login = useLogin()

  const active = state.accounts.find((a) => a.active) ?? state.accounts.find((a) => a.id === state.activeId) ?? null
  const standby = state.accounts
    .filter((a) => a.id !== active?.id)
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || (b.headroom ?? -1) - (a.headroom ?? -1))

  return (
    <motion.div className="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade}>
      <Toolbar state={state} now={now} actions={actions} />
      <main className="main">
        <LayoutGroup>
          {/* layoutScroll: this column scrolls, so layout animations must account for its offset. */}
          <motion.div className="col col--left" layoutScroll>
            <section className="section" aria-label="Active">
              <div className="section__head">
                <span className="eyebrow">Active</span>
              </div>
              {active ? <HeroCard account={active} settings={state.settings} now={now} actions={actions} nudge={state.nudge.pending} /> : null}
              {!active && state.accounts.length === 0 ? <EmptyState actions={actions} login={login} /> : null}
              {!active && state.accounts.length > 0 ? (
                <div className="card">
                  <p className="card__note" style={{ marginTop: 0 }}>
                    None of these accounts matches Claude Code's current login. Switch to one, or capture the current login.
                  </p>
                </div>
              ) : null}
            </section>

            {standby.length > 0 ? (
              <section className="section" aria-label="Standby">
                <div className="section__head">
                  <span className="eyebrow">Standby ({standby.length})</span>
                </div>
                <div className="standby-grid">
                  {standby.map((a) => (
                    <AccountCard key={a.id} account={a} settings={state.settings} now={now} actions={actions} />
                  ))}
                </div>
              </section>
            ) : null}

            {state.accounts.length > 0 ? <AddAccountRow actions={actions} login={login} /> : null}
          </motion.div>
        </LayoutGroup>

        <aside className="col col--right">
          <CodexPanel codex={state.codex} settings={state.settings} now={now} actions={actions} />
          <AutoswapPanel state={state} now={now} actions={actions} />
          <ActivityPanel events={state.events} now={now} />
        </aside>
      </main>
    </motion.div>
  )
}
