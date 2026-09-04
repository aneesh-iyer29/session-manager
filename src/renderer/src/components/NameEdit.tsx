import { useEffect, useRef, useState } from 'react'
import type { Account } from '@shared/types'
import { displayName } from '../lib/format'

interface Props {
  account: Account
  onSave: (alias: string) => Promise<void>
}

/**
 * Click the name to rename in place. Enter saves, Escape cancels, blur saves —
 * a modal for a one-word alias would be out of proportion.
 */
export function NameEdit({ account, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(account.alias)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const begin = () => {
    setDraft(account.alias)
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    if (draft.trim() !== account.alias.trim()) void onSave(draft)
  }

  if (!editing) {
    return (
      <button type="button" className="card__name name-edit__button" onClick={begin} title="Rename" aria-label={`Rename ${displayName(account)}`}>
        {displayName(account)}
      </button>
    )
  }

  return (
    <span className="name-edit">
      <input
        ref={input}
        className="name-edit__input"
        value={draft}
        placeholder={account.email.split('@')[0]}
        aria-label="Alias"
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(account.alias)
            setEditing(false)
          }
        }}
      />
    </span>
  )
}
