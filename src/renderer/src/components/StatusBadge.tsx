/**
 * src/renderer/src/components/StatusBadge.tsx
 * ===========================================
 *
 * The at-a-glance state pill used for the log watcher and the OBS connection.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. The tone tints the pill, but the state is always
 * spelled out in the label ("Tailing", "File missing", "Read error") and the specifics
 * live in the detail line. That keeps the badge readable for colour-blind users and,
 * just as importantly, keeps a screenshot of it useful in a bug report.
 *
 * `role="status"` (implicitly `aria-live="polite"`) sits on the element itself rather
 * than a wrapper, and the element persists across re-renders, so a transition from
 * tailing to read-error is announced without interrupting whatever the user is typing.
 */

import type { ReactElement } from 'react'

/** Severity, purely presentational. `idle` means "nothing wrong, nothing happening". */
export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'idle'

/** What a `describe*` mapper returns for a status union. */
export interface BadgeDescriptor {
  readonly tone: BadgeTone
  readonly label: string
  readonly detail: string
}

export interface StatusBadgeProps {
  readonly tone: BadgeTone
  readonly label: string
  readonly detail?: string | undefined
  /** Prefix read out before the label, e.g. `"Log watcher"`. */
  readonly srPrefix?: string | undefined
}

export function StatusBadge({ tone, label, detail, srPrefix }: StatusBadgeProps): ReactElement {
  return (
    <div className="status" role="status">
      <span className={`badge badge--${tone}`}>
        <span className="badge__dot" aria-hidden="true" />
        {srPrefix !== undefined && <span className="sr-only">{srPrefix}: </span>}
        {label}
      </span>
      {detail !== undefined && detail !== '' && <span className="status__detail">{detail}</span>}
    </div>
  )
}
