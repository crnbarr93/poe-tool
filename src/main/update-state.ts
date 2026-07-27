/**
 * src/main/update-state.ts
 * ========================
 *
 * The auto-updater's state machine, extracted as pure functions.
 *
 * NO `electron` IMPORT AND NO `electron-updater` IMPORT - not even a type-only one.
 * That is the entire reason this file exists as a separate module. `src/main/updater.ts`
 * imports `electron` (for `app.isPackaged`) and `electron-updater` (whose type graph
 * reaches into `electron` for `AuthInfo` and `Session`), so it cannot be loaded under
 * vitest the way `src/main/log/**` can. Everything worth testing - which updater event
 * produces which {@link UpdateState}, and what a garbage percent turns into - lives
 * here instead, and `test/update-state.test.ts` exercises it directly with no mocks.
 *
 * The ONE import is the `UpdateState` type from the shared IPC contract, and it is
 * type-only: the state union has to be declared over there because the renderer
 * consumes it and `tsconfig.web.json` cannot see `src/main/**`. That mirrors how
 * `ObsConnectionState` is declared in `src/shared/ipc.ts` while `src/main/obs/obs-client.ts`
 * owns the transitions between its members.
 *
 *
 * WHY A REDUCER RATHER THAN `#state = ...` SCATTERED THROUGH THE LISTENERS
 * -----------------------------------------------------------------------
 * Two rules below are easy to state and easy to get wrong if each listener assigns for
 * itself, and both of them are about NOT LYING TO THE USER:
 *
 *  1. `disabled-in-dev` is TERMINAL. Nothing reaches it in a packaged build, and in dev
 *     nothing may move it - there are no listeners attached in dev, but a reducer that
 *     enforces it makes that a property of the logic rather than of the wiring.
 *  2. `ready` OUTRANKS a later error. Once the installer is on disk it WILL be applied on
 *     quit, whatever a subsequent check does. Letting a stray `error` overwrite `ready`
 *     would tell the user their update failed while it sat downloaded and armed.
 *
 *
 * IDENTITY IS THE THROTTLE
 * ------------------------
 * {@link reduceUpdateState} returns `previous` BY REFERENCE when nothing changed, and
 * `src/main/updater.ts` skips the emit on a reference match. That is not a
 * micro-optimisation: `download-progress` fires per network chunk, and without this
 * every one of them would become an IPC push and a React render. Because
 * {@link clampPercent} rounds to whole percent first, a download emits at most 101
 * times no matter how chatty the transport is.
 */

import type { UpdateState } from '../shared/ipc'

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Lower bound for {@link clampPercent}. */
export const PERCENT_MIN = 0

/** Upper bound for {@link clampPercent}. */
export const PERCENT_MAX = 100

/**
 * Longest error message allowed onto `push:update`.
 *
 * electron-updater's `error` event carries `(error, message?)` where `message` is
 * `(error.stack || error).toString()` - routinely a few kilobytes of frames. That is a
 * diagnostic, not a sentence, and it must not be pasted into a 12px status line.
 */
export const MAX_UPDATE_ERROR_LENGTH = 200

// ---------------------------------------------------------------------------
// The events the state machine consumes
// ---------------------------------------------------------------------------

/**
 * One thing the updater told us, normalised.
 *
 * Deliberately NOT electron-updater's own event payloads: those are `UpdateInfo` /
 * `ProgressInfo` objects with a dozen fields each and a type graph that pulls in
 * `electron`. `src/main/updater.ts` narrows each event down to the two or three values
 * that matter before handing it here, which is also the point at which untrusted data
 * from a release manifest gets checked.
 *
 * Discriminated on `type`, matching the convention `PoeEvent` uses for occurrences.
 * (Status unions - `WatcherStatus`, `ObsConnectionState`, {@link UpdateState} - use
 * `state`. The two discriminants are different on purpose, so an event can never be
 * mistaken for a status.)
 */
export type UpdaterEvent =
  /** A check started. */
  | { readonly type: 'checking' }
  /** A newer release exists; the download begins on its own. */
  | { readonly type: 'available'; readonly version: string }
  /** We are already on the newest release. */
  | { readonly type: 'not-available' }
  /** Download progress. `percent` is raw and unvalidated - see {@link clampPercent}. */
  | { readonly type: 'progress'; readonly percent: number }
  /** The installer is on disk and armed for install-on-quit. */
  | { readonly type: 'downloaded'; readonly version: string }
  /** The download was cancelled before it finished. */
  | { readonly type: 'cancelled' }
  /** The check or the download failed. */
  | { readonly type: 'error'; readonly message: string }

// ---------------------------------------------------------------------------
// Canonical states
// ---------------------------------------------------------------------------

/**
 * The starting state of a packaged build: nothing checked yet, nothing to say.
 *
 * Frozen because it is handed out by reference to every caller and pushed across IPC.
 */
export const IDLE_UPDATE_STATE: UpdateState = Object.freeze({ state: 'idle' })

/**
 * The one and only state an unpackaged build ever reports. Terminal - see the file
 * header, rule 1.
 */
export const DISABLED_UPDATE_STATE: UpdateState = Object.freeze({ state: 'disabled-in-dev' })

// ---------------------------------------------------------------------------
// Value normalisation (pure, total, never throws)
// ---------------------------------------------------------------------------

/**
 * A whole percent inside `[0, 100]`.
 *
 * EVERY input here is hostile. `ProgressInfo.percent` is computed as
 * `transferred / total * 100` inside electron-updater, and `total` comes from a
 * `Content-Length` header on a release asset - so a zero or missing length yields `NaN`
 * or `Infinity`, and a proxy that over-reports yields something past 100. Typed as
 * `number` because that is what the library declares; treated as arbitrary because that
 * is what actually arrives.
 *
 *  - `NaN` -> {@link PERCENT_MIN}. There is no information in it, and 0 is the honest
 *    "we do not know how far along this is" rather than an invented figure.
 *  - `-Infinity`, anything below 0 -> {@link PERCENT_MIN}.
 *  - `+Infinity`, anything above 100 -> {@link PERCENT_MAX}.
 *  - everything else is rounded to the nearest whole percent.
 *
 * The `<=` on the lower bound is load-bearing, not sloppy: `Math.round(-0.4)` is `-0` in
 * JavaScript, `-0 < 0` is false, and `-0` would survive a `<` test and travel across IPC
 * to be rendered as `-0%`.
 */
export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return PERCENT_MIN
  const rounded = Math.round(value)
  if (rounded <= PERCENT_MIN) return PERCENT_MIN
  if (rounded >= PERCENT_MAX) return PERCENT_MAX
  return rounded
}

/**
 * `42.4` -> `"42%"`. Used for the main-process diagnostic line during a download.
 *
 * The renderer does NOT go through this: by the time a percent is inside an
 * `UpdateDownloadingState` it has already been through {@link clampPercent}, so the UI
 * renders it directly. Formatting it twice would be the kind of duplicated rule that
 * eventually disagrees with itself.
 */
export function formatUpdatePercent(value: number): string {
  return `${String(clampPercent(value))}%`
}

/**
 * A version string safe to put in a sentence, or `""` when there is not one.
 *
 * The value originates in a release manifest fetched over the network. The type says
 * `string`; the `typeof` check is what makes that true at runtime, and `""` is a state
 * the renderer explicitly handles ("An update is ready…" instead of "Update  ready").
 */
export function normalizeVersion(value: string): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * A renderable one-line reason for a failed check or download.
 *
 * Prefers `error.message` over electron-updater's second `message` argument, because
 * that argument is the stack trace. Truncates hard - see {@link MAX_UPDATE_ERROR_LENGTH}.
 *
 * Never throws, for any input, including a thrown string, `null` or a plain object.
 */
export function describeUpdateError(error: unknown, fallback?: string): string {
  const candidates: readonly unknown[] = [
    error instanceof Error ? error.message : undefined,
    typeof error === 'string' ? error : undefined,
    fallback
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const text = candidate.trim()
    if (text === '') continue
    return text.length > MAX_UPDATE_ERROR_LENGTH
      ? `${text.slice(0, MAX_UPDATE_ERROR_LENGTH - 1)}…`
      : text
  }

  return 'The update check failed.'
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * The version a state is talking about, or null when it is not talking about one.
 *
 * Exists so a `download-progress` event - which carries bytes and nothing else - can
 * keep displaying the version the preceding `update-available` announced.
 */
function versionOf(state: UpdateState): string | null {
  switch (state.state) {
    case 'available':
    case 'ready':
    case 'downloading':
      return state.version
    case 'disabled-in-dev':
    case 'idle':
    case 'checking':
    case 'error':
      return null
  }
}

/** The download percent a state carries, or null for the six states that carry none. */
function percentOf(state: UpdateState): number | null {
  return state.state === 'downloading' ? state.percent : null
}

/** The failure message a state carries, or null for the six states that carry none. */
function messageOf(state: UpdateState): string | null {
  return state.state === 'error' ? state.message : null
}

/**
 * Structural equality, used only to decide whether an emit is worth making.
 *
 * Compared through the three projections rather than with a per-member switch: once the
 * discriminants match, `version` + `percent` + `message` are between them EVERY field
 * any member of the union has, so this is exact - and a new member with a new field
 * fails `versionOf`'s exhaustive switch rather than silently comparing equal here.
 */
function sameState(a: UpdateState, b: UpdateState): boolean {
  if (a.state !== b.state) return false
  return versionOf(a) === versionOf(b) && percentOf(a) === percentOf(b) && messageOf(a) === messageOf(b)
}

/**
 * Applies one {@link UpdaterEvent} to the current state.
 *
 * PURE and TOTAL: no clock, no I/O, never throws, same inputs always give the same
 * output. Returns `previous` BY REFERENCE when the result is unchanged - callers use
 * that reference match to decide whether to emit (see the file header).
 *
 * The two precedence rules are checked before the event is even looked at:
 *
 *  1. `disabled-in-dev` swallows everything. An unpackaged build has no updater
 *     listeners at all, so this is belt to that braces - but it means the invariant is
 *     testable without standing up an `AppUpdater`.
 *  2. `ready` swallows everything EXCEPT a `downloaded` for a different version. The
 *     installer is on disk; it is going to be applied on quit; a later failed check
 *     saying "error" would be a false statement about a thing that already succeeded.
 *     A second `downloaded` naming a NEWER version does win, because that is the file
 *     that will actually be installed.
 */
export function reduceUpdateState(previous: UpdateState, event: UpdaterEvent): UpdateState {
  if (previous.state === 'disabled-in-dev') return previous

  if (previous.state === 'ready') {
    if (event.type !== 'downloaded') return previous
    const version = normalizeVersion(event.version)
    return version === previous.version ? previous : { state: 'ready', version }
  }

  const next = nextState(previous, event)
  return sameState(previous, next) ? previous : next
}

/** The transition table proper. Split out so {@link reduceUpdateState} stays readable. */
function nextState(previous: UpdateState, event: UpdaterEvent): UpdateState {
  switch (event.type) {
    case 'checking':
      return { state: 'checking' }

    case 'available':
      return { state: 'available', version: normalizeVersion(event.version) }

    // "You are already up to date" and "the download you started was cancelled" are the
    // same thing to a user who was never told a download had begun: nothing is
    // happening and nothing is wrong. Both land on `idle`, which the UI renders as
    // silence.
    case 'not-available':
    case 'cancelled':
      return IDLE_UPDATE_STATE

    case 'progress':
      return {
        state: 'downloading',
        // Carried forward from `available` (or from the previous progress tick) so the
        // line can name the version it is fetching. Null is a legitimate answer, not a
        // failure - see `UpdateDownloadingState.version`.
        version: versionOf(previous),
        percent: clampPercent(event.percent)
      }

    case 'downloaded':
      return { state: 'ready', version: normalizeVersion(event.version) }

    case 'error':
      return { state: 'error', message: event.message }
  }
}
