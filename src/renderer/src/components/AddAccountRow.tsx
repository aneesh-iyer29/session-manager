import type { Actions } from '../hooks/useActions'
import type { LoginState } from '../hooks/useLogin'
import { Button } from './Button'

interface Props {
  actions: Actions
  login: LoginState
}

/** The two ways in: copy Claude Code's current login, or run the browser OAuth flow. */
export function AddAccountRow({ actions, login }: Props) {
  const capturing = actions.busy.has('capture')
  return (
    <div className="add-row" role="group" aria-label="Add account">
      <span className="add-row__label">Add account</span>
      <Button size="sm" disabled={capturing} onClick={() => actions.captureActive()}>
        {capturing ? 'Capturing…' : 'Capture current login'}
      </Button>
      {login.pending ? (
        <>
          <span className="add-row__hint">Waiting for the browser…</span>
          <Button size="sm" variant="quiet" onClick={() => login.cancel()}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => login.start()}>
          Log in with browser
        </Button>
      )}
    </div>
  )
}
