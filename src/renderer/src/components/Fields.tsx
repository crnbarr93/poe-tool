/**
 * src/renderer/src/components/Fields.tsx
 * ======================================
 *
 * The three form controls the whole config UI is built from.
 *
 * ACCESSIBILITY: every control gets a real `<label for>` bound to a `useId()`-
 * generated id, and every hint is wired up with `aria-describedby` so a screen reader
 * reads the explanation along with the field instead of stranding it as loose text.
 *
 *
 * WHY THESE FIELDS KEEP THEIR OWN DRAFT STATE
 * -------------------------------------------
 * They are not plain controlled inputs. The value that comes back down is validated:
 * `validateSettings` trims `character.name` and `obs.host`, clamps `pollIntervalMs`
 * into 100..10000, and turns a blank path into `null`. A naively controlled input
 * therefore fights the user - type a space and it vanishes, type `1` on the way to
 * `1000` and it snaps to `100` with the caret thrown to the end.
 *
 * So each field mirrors the incoming value into local text state and RE-SYNCS ONLY
 * WHILE UNFOCUSED. The user owns the field while their caret is in it; the moment they
 * leave, the canonical (trimmed/clamped) value takes over, which is also the clearest
 * possible feedback that clamping happened at all.
 */

import type { ChangeEvent, ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

interface FieldShellProps {
  readonly id: string
  readonly hintId: string
  readonly label: string
  readonly hint?: string | undefined
  readonly problem?: string | undefined
  readonly children: ReactElement
}

/** Label + control + hint + (optional) inline problem note. */
function FieldShell({
  id,
  hintId,
  label,
  hint,
  problem,
  children
}: FieldShellProps): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {problem !== undefined && <p className="field__problem">{problem}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (next: string) => void
  /** Called when the field loses focus - used to flush the debounced write early. */
  readonly onCommit?: (() => void) | undefined
  readonly hint?: string | undefined
  readonly problem?: string | undefined
  readonly placeholder?: string | undefined
  /** `password` masks the value. Everything else is plain text. */
  readonly kind?: 'text' | 'password' | undefined
  /** Render in a monospace face - correct for filesystem paths. */
  readonly mono?: boolean | undefined
}

export function TextField({
  label,
  value,
  onChange,
  onCommit,
  hint,
  problem,
  placeholder,
  kind = 'text',
  mono = false
}: TextFieldProps): ReactElement {
  const id = useId()
  const hintId = `${id}-hint`
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value)
    onChange(event.target.value)
  }

  const handleBlur = (): void => {
    focused.current = false
    setDraft(value)
    onCommit?.()
  }

  return (
    <FieldShell id={id} hintId={hintId} label={label} hint={hint} problem={problem}>
      <input
        className={mono ? 'input input--mono' : 'input'}
        id={id}
        type={kind === 'password' ? 'password' : 'text'}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={handleChange}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={handleBlur}
      />
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

export interface NumberFieldProps {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly onChange: (next: number) => void
  readonly onCommit?: (() => void) | undefined
  readonly hint?: string | undefined
  readonly unit?: string | undefined
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
  hint,
  unit
}: NumberFieldProps): ReactElement {
  const id = useId()
  const hintId = `${id}-hint`
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const text = event.target.value
    setDraft(text)

    // A half-typed value ("", "-", "1e") must not be pushed upstream: the validator
    // would read it as garbage and reset the setting to its factory default while the
    // user is still mid-keystroke. Silence until it parses.
    if (text.trim() === '') return
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    onChange(Math.round(parsed))
  }

  const handleBlur = (): void => {
    focused.current = false
    setDraft(String(value))
    onCommit?.()
  }

  return (
    <FieldShell id={id} hintId={hintId} label={label} hint={hint}>
      <span className="input-wrap">
        <input
          className="input input--number"
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={handleChange}
          onFocus={() => {
            focused.current = true
          }}
          onBlur={handleBlur}
        />
        {unit !== undefined && <span className="input-wrap__unit">{unit}</span>}
      </span>
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export interface ToggleFieldProps {
  readonly label: string
  readonly checked: boolean
  /** Toggles persist immediately - a click is a decision, not a keystroke. */
  readonly onChange: (next: boolean) => void
  readonly hint?: string | undefined
}

export function ToggleField({ label, checked, onChange, hint }: ToggleFieldProps): ReactElement {
  const id = useId()
  const hintId = `${id}-hint`

  return (
    <div className="field field--toggle">
      <div className="toggle">
        <input
          className="toggle__input"
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onChange(event.target.checked)
          }}
        />
        <label className="toggle__label" htmlFor={id}>
          {label}
        </label>
      </div>
      {hint !== undefined && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}
