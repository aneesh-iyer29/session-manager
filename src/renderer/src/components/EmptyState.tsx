import type { Actions } from '../hooks/useActions'
import type { LoginState } from '../hooks/useLogin'
import { Button } from './Button'

interface Props {
  actions: Actions
  login: LoginState
}

/** No accounts yet: the hero slot becomes a quiet invitation. No illustration, one sentence. */
export function EmptyState({ actions, login }: Props) {
  const capturing = actions.busy.has('capture')
  return (
    <section className="card empty" aria-label="No accounts">
      <div className="empty__title">No accounts yet</div>
      <p className="empty__body">
        Add the account Claude Code is logged in with, or log in to another one. Once two are here, Session Manager watches their
        Fable runway and can switch before a window throttles you.
      </p>
      <div className="empty__actions">
        <Button variant="primary" disabled={capturing} onClick={() => actions.captureActive()}>
          {capturing ? 'Capturing…' : 'Capture current login'}
        </Button>
        {login.pending ? (
          <Button variant="quiet" onClick={() => login.cancel()}>
            Cancel login
          </Button>
        ) : (
          <Button onClick={() => login.start()}>Log in with browser</Button>
        )}
      </div>
    </section>
  )
}
