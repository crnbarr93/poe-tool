/**
 * src/renderer/src/components/StatusPill.tsx
 * ==========================================
 *
 * The readiness pill in the window header: "Capturing 3 / 4".
 *
 * ALL OF THE THINKING IS IN `../readiness.ts`; this file is the rendering.
 *
 * That split is not tidiness. The first version of this component decided for itself what
 * "OBS is ready" meant, chose `state === 'connected'`, and therefore read "Capturing 4 / 4"
 * while OBS sat connected with its REPLAY BUFFER STOPPED - the single most common way this
 * app appears broken, and a state in which not one clip can be saved. A rule that lives in
 * a component is a rule that cannot be unit-tested; `test/readiness.test.ts` now pins it,
 * including that exact case.
 *
 * WHAT THE PARTS MEAN
 * -------------------
 *  - THE COUNT is `checks.filter(ok).length` over the four conditions that have to hold
 *    before a death of yours becomes a clip on disk (log tailing, OBS able to save,
 *    clipping enabled, a character resolved). Never a constant.
 *  - THE LABEL is about the log alone: "Capturing" is claimed only while the watcher is
 *    actually tailing, because that is the one condition under which poe-tool is doing
 *    something right now rather than being prepared to. The count keeps its honest value
 *    in the "Not watching" state too - pinning it to zero would hide that three quarters
 *    of the setup is already correct.
 *  - THE TOOLTIP is the four `detail` strings, one per line, carrying main's own words:
 *    "file missing — No log file at C:\…", "read error — EACCES: …", "connected, REPLAY
 *    BUFFER NOT RUNNING — no clip can be saved". Anything worse than that is the pill
 *    throwing away the only explanation the user has.
 *
 * The three faults that are worth more than a tooltip get a banner in the shell as well -
 * see `ShellAlerts`. This pill is the summary, not the alarm.
 *
 * `role="status"` on a persistently mounted element, matching StatusBadge and UpdateStatus:
 * transitions are announced politely rather than interrupting typing, and the live region
 * exists before it has anything to announce.
 */

import type { ReactElement } from 'react'

import type { Readiness } from '../readiness'

export interface StatusPillProps {
  /** From `computeReadiness` - the checks, the count and whether we are tailing. */
  readonly readiness: Readiness
}

export function StatusPill({ readiness }: StatusPillProps): ReactElement {
  const { checks, ready, total, watching } = readiness

  // Hover detail, so the number is never a mystery the user has to go and reverse-engineer
  // by opening four settings tabs.
  const title = checks.map((check) => `${check.label}: ${check.detail}`).join('\n')

  return (
    <div className="pill" role="status" title={title}>
      <span
        className={`pill__dot ${watching ? 'pill__dot--live' : 'pill__dot--idle'}`}
        aria-hidden="true"
      />
      <span>{watching ? 'Capturing' : 'Not watching'}</span>
      <span className="pill__count">
        {ready} / {total}
      </span>
      {/*
        The screen-reader version says the same thing the tooltip does. A count on its own
        is not usable without the four reasons, and a `title` is not reliably announced.
      */}
      <span className="sr-only">
        {String(ready)} of {String(total)} capture requirements ready.{' '}
        {checks.map((check) => `${check.label}: ${check.detail}.`).join(' ')}
      </span>
    </div>
  )
}
