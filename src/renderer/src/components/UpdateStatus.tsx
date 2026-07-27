/**
 * src/renderer/src/components/UpdateStatus.tsx
 * ============================================
 *
 * One line in the footer telling the user where auto-update has got to.
 *
 * DELIBERATELY NOT A SECTION, NOT A BANNER, AND NEVER A MODAL
 * ----------------------------------------------------------
 * The numbered sections above it are things the user configures. Auto-update is not one
 * of them: it has no settings, it needs no decision, and interrupting someone who opened
 * this window to fix their OBS password in order to announce a background download would
 * be exactly the nagging this app avoids. So it is a 12px line in the footer, next to
 * the "poe-tool only reads one log file" sentence, and it is SILENT in the steady state.
 *
 * WHAT EACH STATE IS ALLOWED TO SAY
 * ---------------------------------
 *  - `idle` and the not-yet-loaded `null` render NOTHING AT ALL. "No update available"
 *    is the overwhelmingly common case and is not news.
 *  - `ready` is the one message that matters, and it is the one that must be
 *    unambiguous: the update is NOT being applied now, it will be applied when the user
 *    quits, and until then nothing changes. A user who reads that line knows they can
 *    keep mapping.
 *  - `error` is stated once, quietly, WITH the reassurance that capture is unaffected -
 *    because an "update failed" line with no context, in a window whose whole job is to
 *    report on a capture pipeline, reads like the capture broke. The underlying message
 *    is on the `title` attribute rather than on screen: it is a diagnostic for a bug
 *    report, not something to make a user act on.
 *  - `disabled-in-dev` is unreachable in a shipped installer. It exists so a developer
 *    running `electron-vite dev` reads "off by design" instead of assuming this is broken.
 *
 * `role="status"` (implicitly `aria-live="polite"`) sits on the persistent wrapper, not
 * on the message, so a transition is announced without interrupting whatever the user is
 * typing - the same reasoning as `StatusBadge`.
 */

import type { ReactElement } from 'react'

import type { PoeToolApi, UpdateState } from '../../../shared/ipc'
import { useUpdateState } from '../hooks'

/** Tone class suffix. Mirrors `BadgeTone`, kept local because this is not a badge. */
type UpdateTone = 'idle' | 'info' | 'ok' | 'warn'

interface UpdateLine {
  readonly tone: UpdateTone
  readonly text: string
  /** Hover-only detail. `undefined` renders no `title`. */
  readonly title?: string | undefined
}

/**
 * Renders one state as at most one sentence. `null` means "say nothing".
 *
 * Exhaustive over the `UpdateState` union - a new member is a compile error here rather
 * than a state the footer silently ignores.
 */
function describeUpdate(state: UpdateState): UpdateLine | null {
  switch (state.state) {
    case 'idle':
      // The steady state, and the boring one. Nothing to report is reported as nothing.
      return null

    case 'disabled-in-dev':
      return {
        tone: 'idle',
        text: 'Auto-update is off in development builds.',
        title: 'A packaged installer updates itself from GitHub Releases; a dev build has no update manifest to read.'
      }

    case 'checking':
      return { tone: 'idle', text: 'Checking for updates…' }

    case 'available':
      return {
        tone: 'info',
        text:
          state.version === ''
            ? 'An update is available — downloading it in the background.'
            : `Update ${state.version} is available — downloading it in the background.`
      }

    case 'downloading':
      // `percent` arrives already clamped to 0-100 and rounded to a whole number by
      // main (see `src/main/update-state.ts`); rendering it raw is correct, and
      // re-clamping here would be a second copy of a rule that could drift.
      //
      // BOTH `null` and `""` mean "no version to name", and both have to be handled:
      // null when no `update-available` was seen at all, `""` when one was seen but its
      // manifest had no usable version. Testing only for null would render a double
      // space in the second case.
      return {
        tone: 'info',
        text:
          state.version === null || state.version === ''
            ? `Downloading update — ${String(state.percent)}%`
            : `Downloading update ${state.version} — ${String(state.percent)}%`
      }

    case 'ready':
      // THE line. Says what happened, says what will happen, and says when - so nobody
      // has to wonder whether the app is about to restart on them mid-map.
      return {
        tone: 'ok',
        text:
          state.version === ''
            ? 'An update is ready — it will install when you quit poe-tool.'
            : `Update ${state.version} ready — it will install when you quit poe-tool.`
      }

    case 'error':
      return {
        tone: 'warn',
        text: 'Could not check for updates — capture is unaffected.',
        title: state.message
      }
  }
}

export interface UpdateStatusProps {
  readonly api: PoeToolApi
}

export function UpdateStatus({ api }: UpdateStatusProps): ReactElement {
  const state = useUpdateState(api)
  const line = state === null ? null : describeUpdate(state)

  // The wrapper is rendered unconditionally, even when there is nothing to say, so that
  // `role="status"` has a stable element to announce into. A live region that is added
  // to the DOM at the same moment its first content appears is frequently missed by
  // screen readers.
  return (
    <p className="update" role="status">
      {line !== null && (
        <span className={`update__line update__line--${line.tone}`} title={line.title}>
          {line.text}
        </span>
      )}
    </p>
  )
}
