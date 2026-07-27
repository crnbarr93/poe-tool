/**
 * test/update-state.test.ts
 * =========================
 *
 * The auto-updater's decision-making, tested without electron.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `src/main/updater.ts`
 * ---------------------------------------------------------
 * `updater.ts` imports `electron` (for `app.isPackaged`) and `electron-updater`, whose
 * type graph reaches back into electron for `Session` and `AuthInfo`. Neither can be
 * loaded under vitest the way `src/main/log/**` can, and mocking the whole of
 * electron-updater would prove only that the mock behaves like the mock. So every
 * decision worth checking was extracted into `src/main/update-state.ts` - a module with
 * one type-only import - and this file drives it directly, with no mocks at all.
 *
 * What is NOT covered here is the WIRING - that the `error` listener really is attached
 * first, that `app.isPackaged` really gates construction, that every `on` really has a
 * matching `off`. That half now lives in `test/updater.test.ts`, which mocks both
 * modules for exactly those assertions and nothing else. What IS covered here is every
 * state the UI can be asked to render and how it got there.
 */

import { describe, expect, it } from 'vitest'

import type { UpdateState } from '../src/shared/ipc'
import {
  clampPercent,
  describeUpdateError,
  DISABLED_UPDATE_STATE,
  formatUpdatePercent,
  IDLE_UPDATE_STATE,
  MAX_UPDATE_ERROR_LENGTH,
  normalizeVersion,
  PERCENT_MAX,
  PERCENT_MIN,
  reduceUpdateState,
  type UpdaterEvent
} from '../src/main/update-state'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feeds a whole sequence of events through the reducer, returning the final state. */
function run(initial: UpdateState, ...events: readonly UpdaterEvent[]): UpdateState {
  let state = initial
  for (const event of events) state = reduceUpdateState(state, event)
  return state
}

/** The happy path up to "downloading", used as the starting point by several tests. */
const CHECKING: UpdaterEvent = { type: 'checking' }
const AVAILABLE: UpdaterEvent = { type: 'available', version: '0.2.0' }
const DOWNLOADED: UpdaterEvent = { type: 'downloaded', version: '0.2.0' }

// ---------------------------------------------------------------------------
// clampPercent
// ---------------------------------------------------------------------------

describe('clampPercent', () => {
  it('rounds an ordinary percent to a whole number', () => {
    expect(clampPercent(0)).toBe(0)
    expect(clampPercent(42)).toBe(42)
    expect(clampPercent(42.4)).toBe(42)
    expect(clampPercent(42.6)).toBe(43)
    expect(clampPercent(100)).toBe(100)
  })

  it('clamps below zero up to PERCENT_MIN', () => {
    expect(clampPercent(-1)).toBe(PERCENT_MIN)
    expect(clampPercent(-0.4)).toBe(PERCENT_MIN)
    expect(clampPercent(-9999)).toBe(PERCENT_MIN)
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(PERCENT_MIN)
  })

  it('clamps above one hundred down to PERCENT_MAX', () => {
    expect(clampPercent(101)).toBe(PERCENT_MAX)
    expect(clampPercent(100.4)).toBe(PERCENT_MAX)
    expect(clampPercent(1e9)).toBe(PERCENT_MAX)
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(PERCENT_MAX)
  })

  it('maps NaN to PERCENT_MIN rather than propagating it', () => {
    // `ProgressInfo.percent` is `transferred / total * 100`, and `total` comes from a
    // Content-Length header. A missing or zero length produces NaN, which would render
    // as the literal string "NaN%" if it survived.
    expect(clampPercent(Number.NaN)).toBe(PERCENT_MIN)
  })

  it('never returns negative zero', () => {
    // `Math.round(-0.4)` is `-0`, and `-0 < 0` is false, so a `<` comparison would let
    // it through to be rendered as "-0%". `Object.is` is what makes this assertion real:
    // `expect(-0).toBe(0)` fails, which is the point.
    expect(Object.is(clampPercent(-0.4), 0)).toBe(true)
    expect(Object.is(clampPercent(-0), 0)).toBe(true)
  })
})

describe('formatUpdatePercent', () => {
  it('renders a clamped whole percent with a sign', () => {
    expect(formatUpdatePercent(0)).toBe('0%')
    expect(formatUpdatePercent(42.6)).toBe('43%')
    expect(formatUpdatePercent(100)).toBe('100%')
  })

  it('formats the out-of-range cases through the same clamp', () => {
    expect(formatUpdatePercent(-5)).toBe('0%')
    expect(formatUpdatePercent(150)).toBe('100%')
    expect(formatUpdatePercent(Number.NaN)).toBe('0%')
  })
})

// ---------------------------------------------------------------------------
// normalizeVersion / describeUpdateError
// ---------------------------------------------------------------------------

describe('normalizeVersion', () => {
  it('trims and passes through a real version', () => {
    expect(normalizeVersion('0.2.0')).toBe('0.2.0')
    expect(normalizeVersion('  1.0.0-rc.1  ')).toBe('1.0.0-rc.1')
  })

  it('yields the empty string for a blank one', () => {
    expect(normalizeVersion('')).toBe('')
    expect(normalizeVersion('   ')).toBe('')
  })
})

describe('describeUpdateError', () => {
  it('prefers the error message over the stack-trace fallback', () => {
    const error = new Error('net::ERR_INTERNET_DISCONNECTED')
    expect(describeUpdateError(error, 'Error: net::ERR...\n    at foo (bar.js:1:1)')).toBe(
      'net::ERR_INTERNET_DISCONNECTED'
    )
  })

  it('falls back to the message argument when the error has no usable message', () => {
    expect(describeUpdateError(new Error(''), 'Cannot check for updates')).toBe(
      'Cannot check for updates'
    )
  })

  it('handles a thrown string', () => {
    expect(describeUpdateError('rate limited')).toBe('rate limited')
  })

  it('has a sentence for values that carry nothing at all', () => {
    expect(describeUpdateError(null)).toBe('The update check failed.')
    expect(describeUpdateError(undefined)).toBe('The update check failed.')
    expect(describeUpdateError({})).toBe('The update check failed.')
    expect(describeUpdateError(new Error('   '))).toBe('The update check failed.')
  })

  it('truncates a stack trace instead of pasting kilobytes into a status line', () => {
    const long = 'x'.repeat(5_000)
    const described = describeUpdateError(new Error(long))
    expect(described.length).toBe(MAX_UPDATE_ERROR_LENGTH)
    expect(described.endsWith('…')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The state machine: the happy path
// ---------------------------------------------------------------------------

describe('reduceUpdateState: the happy path', () => {
  it('walks idle -> checking -> available -> downloading -> ready', () => {
    expect(reduceUpdateState(IDLE_UPDATE_STATE, CHECKING)).toEqual({ state: 'checking' })

    expect(run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE)).toEqual({
      state: 'available',
      version: '0.2.0'
    })

    expect(run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE, { type: 'progress', percent: 12.3 })).toEqual(
      { state: 'downloading', version: '0.2.0', percent: 12 }
    )

    expect(
      run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE, { type: 'progress', percent: 99 }, DOWNLOADED)
    ).toEqual({ state: 'ready', version: '0.2.0' })
  })

  it('returns to idle when there is nothing newer', () => {
    expect(run(IDLE_UPDATE_STATE, CHECKING, { type: 'not-available' })).toEqual({ state: 'idle' })
  })

  it('returns to idle when a download is cancelled', () => {
    expect(
      run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE, { type: 'progress', percent: 40 }, {
        type: 'cancelled'
      })
    ).toEqual({ state: 'idle' })
  })

  it('carries the version from `available` through every progress tick', () => {
    const state = run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE, { type: 'progress', percent: 5 }, {
      type: 'progress',
      percent: 60
    })
    expect(state).toEqual({ state: 'downloading', version: '0.2.0', percent: 60 })
  })

  it('reports a null version when progress arrives without a preceding `available`', () => {
    // A resumed download, or a listener attached late. Null is a legitimate answer and
    // the UI renders "Downloading update — 30%" without naming a version.
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'progress', percent: 30 })).toEqual({
      state: 'downloading',
      version: null,
      percent: 30
    })
  })

  it('clamps a percent on its way into the state', () => {
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'progress', percent: 250 })).toEqual({
      state: 'downloading',
      version: null,
      percent: PERCENT_MAX
    })
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'progress', percent: -7 })).toEqual({
      state: 'downloading',
      version: null,
      percent: PERCENT_MIN
    })
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'progress', percent: Number.NaN })).toEqual({
      state: 'downloading',
      version: null,
      percent: PERCENT_MIN
    })
  })

  it('normalises the version on both `available` and `downloaded`', () => {
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'available', version: ' 0.3.0 ' })).toEqual({
      state: 'available',
      version: '0.3.0'
    })
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'downloaded', version: '  ' })).toEqual({
      state: 'ready',
      version: ''
    })
  })
})

// ---------------------------------------------------------------------------
// The state machine: errors
// ---------------------------------------------------------------------------

describe('reduceUpdateState: errors', () => {
  it('moves to error from idle', () => {
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'error', message: 'offline' })).toEqual({
      state: 'error',
      message: 'offline'
    })
  })

  it('moves to error from checking', () => {
    expect(run(IDLE_UPDATE_STATE, CHECKING, { type: 'error', message: '404' })).toEqual({
      state: 'error',
      message: '404'
    })
  })

  it('moves to error from downloading, abandoning the percent', () => {
    expect(
      run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE, { type: 'progress', percent: 55 }, {
        type: 'error',
        message: 'connection reset'
      })
    ).toEqual({ state: 'error', message: 'connection reset' })
  })

  it('replaces one error message with a different one', () => {
    const first = reduceUpdateState(IDLE_UPDATE_STATE, { type: 'error', message: 'first' })
    expect(reduceUpdateState(first, { type: 'error', message: 'second' })).toEqual({
      state: 'error',
      message: 'second'
    })
  })

  it('recovers out of error on the next check', () => {
    // Nothing latches. A transient failure followed by a successful check must leave the
    // footer silent rather than pinned to a stale complaint.
    const failed = reduceUpdateState(IDLE_UPDATE_STATE, { type: 'error', message: 'offline' })
    expect(run(failed, CHECKING, { type: 'not-available' })).toEqual({ state: 'idle' })
  })
})

// ---------------------------------------------------------------------------
// The state machine: the two precedence rules
// ---------------------------------------------------------------------------

describe('reduceUpdateState: `disabled-in-dev` is terminal', () => {
  const events: readonly UpdaterEvent[] = [
    CHECKING,
    AVAILABLE,
    { type: 'not-available' },
    { type: 'progress', percent: 50 },
    DOWNLOADED,
    { type: 'cancelled' },
    { type: 'error', message: 'boom' }
  ]

  for (const event of events) {
    it(`ignores \`${event.type}\``, () => {
      // Identity, not just equality: a dev build must not even produce an emit.
      expect(reduceUpdateState(DISABLED_UPDATE_STATE, event)).toBe(DISABLED_UPDATE_STATE)
    })
  }
})

describe('reduceUpdateState: `ready` outranks everything except a newer download', () => {
  const ready = run(IDLE_UPDATE_STATE, CHECKING, AVAILABLE, DOWNLOADED)

  it('is reached with the downloaded version', () => {
    expect(ready).toEqual({ state: 'ready', version: '0.2.0' })
  })

  it('is not overwritten by a later failed check', () => {
    // The installer is on disk and WILL be applied on quit. Saying "update failed" over
    // the top of that would be a false statement about something that already succeeded.
    expect(reduceUpdateState(ready, { type: 'error', message: 'offline' })).toBe(ready)
  })

  it('is not overwritten by a later check, availability or progress', () => {
    expect(reduceUpdateState(ready, CHECKING)).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'available', version: '0.3.0' })).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'progress', percent: 10 })).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'not-available' })).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'cancelled' })).toBe(ready)
  })

  it('IS replaced by a download of a different version', () => {
    // A second, newer installer is the file that will actually be run on quit, so the
    // line has to name it.
    expect(reduceUpdateState(ready, { type: 'downloaded', version: '0.3.0' })).toEqual({
      state: 'ready',
      version: '0.3.0'
    })
  })

  it('is unchanged by a re-download of the same version', () => {
    expect(reduceUpdateState(ready, DOWNLOADED)).toBe(ready)
  })
})

// ---------------------------------------------------------------------------
// Identity: the throttle that keeps `download-progress` off the IPC channel
// ---------------------------------------------------------------------------

describe('reduceUpdateState: returns the previous state by reference when nothing moved', () => {
  it('collapses two progress events that round to the same whole percent', () => {
    // This is the whole reason `clampPercent` rounds. `download-progress` fires per
    // network chunk; `src/main/updater.ts` skips the emit on a reference match, so a
    // download costs at most 101 IPC pushes however chatty the transport is.
    const first = reduceUpdateState(IDLE_UPDATE_STATE, { type: 'progress', percent: 42.1 })
    expect(reduceUpdateState(first, { type: 'progress', percent: 42.4 })).toBe(first)
  })

  it('emits again once the whole percent actually changes', () => {
    const first = reduceUpdateState(IDLE_UPDATE_STATE, { type: 'progress', percent: 42.1 })
    const second = reduceUpdateState(first, { type: 'progress', percent: 43.0 })
    expect(second).not.toBe(first)
    expect(second).toEqual({ state: 'downloading', version: null, percent: 43 })
  })

  it('collapses a repeated `checking`', () => {
    const checking = reduceUpdateState(IDLE_UPDATE_STATE, CHECKING)
    expect(reduceUpdateState(checking, CHECKING)).toBe(checking)
  })

  it('collapses a repeated `available` for the same version', () => {
    const available = reduceUpdateState(IDLE_UPDATE_STATE, AVAILABLE)
    expect(reduceUpdateState(available, { type: 'available', version: '0.2.0' })).toBe(available)
  })

  it('collapses a repeated identical error', () => {
    const failed = reduceUpdateState(IDLE_UPDATE_STATE, { type: 'error', message: 'offline' })
    expect(reduceUpdateState(failed, { type: 'error', message: 'offline' })).toBe(failed)
  })

  it('collapses `not-available` when already idle', () => {
    expect(reduceUpdateState(IDLE_UPDATE_STATE, { type: 'not-available' })).toBe(IDLE_UPDATE_STATE)
  })

  it('emits when only the version changes under an unchanged discriminant', () => {
    const available = reduceUpdateState(IDLE_UPDATE_STATE, AVAILABLE)
    expect(reduceUpdateState(available, { type: 'available', version: '0.3.0' })).not.toBe(available)
  })
})

// ---------------------------------------------------------------------------
// The canonical states
// ---------------------------------------------------------------------------

describe('canonical states', () => {
  it('are frozen, because they are handed out by reference across IPC', () => {
    expect(Object.isFrozen(IDLE_UPDATE_STATE)).toBe(true)
    expect(Object.isFrozen(DISABLED_UPDATE_STATE)).toBe(true)
  })

  it('carry the discriminants the shared contract declares', () => {
    const idle: UpdateState = IDLE_UPDATE_STATE
    const disabled: UpdateState = DISABLED_UPDATE_STATE
    expect(idle.state).toBe('idle')
    expect(disabled.state).toBe('disabled-in-dev')
  })
})
