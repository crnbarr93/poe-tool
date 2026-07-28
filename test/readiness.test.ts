/**
 * test/readiness.test.ts
 * ======================
 *
 * The header pill's claim, and the three faults that get a banner.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The pill says "Capturing 4 / 4" on every screen of this app. That is a CLAIM about
 * whether the user's next death will be recorded, and it was briefly wrong in the worst
 * direction: OBS was counted as ready on `state === 'connected'` alone, so a connected OBS
 * with its REPLAY BUFFER STOPPED - which saves nothing, and is the most common way this
 * app appears broken - read as fully ready. `src/shared/ipc.ts` says so on the field
 * itself: "If this is false, clip requests will fail - the UI should warn."
 *
 * The rules therefore live in a pure module and are pinned here. There is no DOM test
 * environment in this frozen dependency set, which is the same reason `activity-derive.ts`
 * and `detection-swap.ts` are React-free.
 */

import { describe, expect, it } from 'vitest'

import type {
  ActiveCharacter,
  WatcherFileMissingStatus,
  WatcherReadErrorStatus,
  WatcherTailingStatus
} from '../src/shared/events'
import type { ObsConnectionState } from '../src/shared/ipc'
import {
  computeReadiness,
  describeLogReadiness,
  describeObsReadiness,
  shellFaults,
  type ReadinessInput
} from '../src/renderer/src/readiness'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AT = 1_800_000_000_000

const TAILING: WatcherTailingStatus = {
  state: 'tailing',
  path: 'C:\\PoE\\logs\\Client.txt',
  offset: 4096,
  since: AT,
  lastLineAt: AT,
  linesRead: 12
}

const FILE_MISSING: WatcherFileMissingStatus = {
  state: 'file-missing',
  path: 'C:\\PoE\\logs\\Client.txt',
  since: AT,
  message: 'No log file at C:\\PoE\\logs\\Client.txt'
}

const READ_ERROR: WatcherReadErrorStatus = {
  state: 'read-error',
  path: 'C:\\PoE\\logs\\Client.txt',
  offset: 4096,
  since: AT,
  code: 'EACCES',
  message: 'permission denied'
}

function connected(replayBufferActive: boolean | null): ObsConnectionState {
  return {
    state: 'connected',
    host: '127.0.0.1',
    port: 4455,
    obsVersion: '30.2.3',
    websocketVersion: '5.5.4',
    since: AT,
    replayBufferActive
  }
}

const RESOLVED: ActiveCharacter = {
  name: 'FyascoWorbinTime',
  className: 'Elementalist',
  level: 93,
  source: 'detected'
}

const NOBODY: ActiveCharacter = {
  name: null,
  className: null,
  level: null,
  source: 'none'
}

/** Everything green, so each test can knock out exactly one thing. */
const READY: ReadinessInput = {
  watcher: TAILING,
  obs: connected(true),
  clipsEnabled: true,
  character: RESOLVED
}

// ---------------------------------------------------------------------------
// The count
// ---------------------------------------------------------------------------

describe('computeReadiness', () => {
  it('counts a fully-armed setup as 4 / 4 and calls it capturing', () => {
    const readiness = computeReadiness(READY)

    expect(readiness.ready).toBe(4)
    expect(readiness.total).toBe(4)
    expect(readiness.watching).toBe(true)
  })

  /**
   * THE REGRESSION THIS MODULE WAS EXTRACTED FOR. A connected OBS whose replay buffer is
   * stopped cannot save a single clip, so it must not be counted as ready and must not be
   * described as merely "connected".
   */
  it('does NOT count OBS as ready when the replay buffer is stopped', () => {
    const readiness = computeReadiness({ ...READY, obs: connected(false) })

    expect(readiness.ready).toBe(3)

    const obs = readiness.checks.find((check) => check.label === 'OBS')
    expect(obs?.ok).toBe(false)
    expect(obs?.detail).toContain('REPLAY BUFFER NOT RUNNING')
  })

  /**
   * `null` is "we have not managed to ask yet", not "it is off". Failing the count there
   * would flash a false alarm at every healthy connection in its first moments - but the
   * detail must not claim the buffer is running either.
   */
  it('counts an unknown replay-buffer state as ready, while saying it is unknown', () => {
    const readiness = computeReadiness({ ...READY, obs: connected(null) })

    expect(readiness.ready).toBe(4)

    const obs = readiness.checks.find((check) => check.label === 'OBS')
    expect(obs?.ok).toBe(true)
    expect(obs?.detail).toBe('connected, replay buffer state not known yet')
  })

  /**
   * The label is about the log; the count is about readiness. A machine that is not
   * reading the log is "Not watching" however much of the rest is set up, and pinning the
   * count to zero there would hide that three quarters of the setup is already correct.
   */
  it('keeps an honest count while not watching', () => {
    const readiness = computeReadiness({ ...READY, watcher: FILE_MISSING })

    expect(readiness.watching).toBe(false)
    expect(readiness.ready).toBe(3)
  })

  it('counts nothing as ready before main has answered', () => {
    const readiness = computeReadiness({
      watcher: null,
      obs: null,
      clipsEnabled: false,
      character: null
    })

    expect(readiness.ready).toBe(0)
    expect(readiness.watching).toBe(false)
    // "Not answered yet" must not read as a negative answer.
    for (const check of readiness.checks) {
      if (check.label === 'Clips') continue
      expect(check.detail).toBe('waiting for the background process')
    }
  })

  it('counts clipping being switched off', () => {
    const readiness = computeReadiness({ ...READY, clipsEnabled: false })

    expect(readiness.ready).toBe(3)
    expect(readiness.checks.find((check) => check.label === 'Clips')?.ok).toBe(false)
  })

  it('counts an unresolved character', () => {
    const readiness = computeReadiness({ ...READY, character: NOBODY })

    expect(readiness.ready).toBe(3)
    const character = readiness.checks.find((check) => check.label === 'Character')
    expect(character?.ok).toBe(false)
    expect(character?.detail).toContain('nobody resolved')
  })
})

// ---------------------------------------------------------------------------
// Why, not just whether
// ---------------------------------------------------------------------------

describe('describeLogReadiness', () => {
  /**
   * The whole point of threading `WatcherStatus` into the pill instead of a boolean:
   * "file missing", "no path set", "permission denied" and "rotated" are four different
   * problems with four different fixes, and "not tailing" tells the user none of them.
   */
  it("carries main's own message for a missing file", () => {
    const check = describeLogReadiness(FILE_MISSING)

    expect(check.ok).toBe(false)
    expect(check.detail).toBe('file missing — No log file at C:\\PoE\\logs\\Client.txt')
  })

  it('carries the errno as well as the message for a read error', () => {
    const check = describeLogReadiness(READ_ERROR)

    expect(check.ok).toBe(false)
    expect(check.detail).toBe('read error — EACCES: permission denied')
  })

  it('falls back to the message alone when there is no errno', () => {
    const check = describeLogReadiness({ ...READ_ERROR, code: null })

    expect(check.detail).toBe('read error — permission denied')
  })

  it('tells an unconfigured watcher apart from a stopped one', () => {
    expect(describeLogReadiness({ state: 'idle', path: null, since: AT }).detail).toBe(
      'no Client.txt path set yet'
    )
    expect(
      describeLogReadiness({ state: 'idle', path: 'C:\\PoE\\Client.txt', since: AT }).detail
    ).toBe('watcher stopped')
  })
})

describe('describeObsReadiness', () => {
  it('reports a retrying error with its message', () => {
    const check = describeObsReadiness({
      state: 'error',
      message: 'connect ECONNREFUSED 127.0.0.1:4455',
      since: AT,
      willRetry: true
    })

    expect(check.ok).toBe(false)
    expect(check.detail).toBe('connect ECONNREFUSED 127.0.0.1:4455 (retrying)')
  })

  it('names the endpoint while connecting', () => {
    const check = describeObsReadiness({
      state: 'connecting',
      host: '127.0.0.1',
      port: 4455,
      since: AT,
      attempt: 3
    })

    expect(check.ok).toBe(false)
    expect(check.detail).toBe('connecting to 127.0.0.1:4455 (attempt 3)')
  })
})

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

describe('shellFaults', () => {
  it('reports nothing when everything is working', () => {
    expect(shellFaults(READY)).toEqual([])
  })

  /**
   * A fault is something that is WRONG NOW. An app that has simply not been set up yet is
   * not broken, and a banner that is up from first launch until setup is finished is a
   * banner nobody reads by the time it matters.
   */
  it('does not report an unconfigured app as a fault', () => {
    const faults = shellFaults({
      watcher: { state: 'idle', path: null, since: AT },
      obs: { state: 'disconnected', since: AT },
      clipsEnabled: false,
      character: null
    })

    expect(faults).toEqual([])
  })

  it('does not report a rotation, which the watcher heals by itself', () => {
    const faults = shellFaults({
      ...READY,
      watcher: {
        state: 'rotated',
        path: 'C:\\PoE\\Client.txt',
        previousOffset: 900,
        offset: 0,
        since: AT,
        message: 'Log file was replaced or truncated at offset 900; re-reading from the start.'
      }
    })

    expect(faults).toEqual([])
  })

  it('does not report a replay-buffer state it has not established', () => {
    expect(shellFaults({ ...READY, obs: connected(null) })).toEqual([])
  })

  it('reports a stopped replay buffer, pointing at the OBS tab', () => {
    const faults = shellFaults({ ...READY, obs: connected(false) })

    expect(faults).toHaveLength(1)
    expect(faults[0]?.id).toBe('obs-replay-buffer')
    expect(faults[0]?.tone).toBe('bad')
    expect(faults[0]?.tab).toBe('obs')
  })

  /** Not fatal - the game may not be running - but nothing is being parsed either. */
  it('reports a missing log file as a warning, with the path main reported', () => {
    const faults = shellFaults({ ...READY, watcher: FILE_MISSING })

    expect(faults).toHaveLength(1)
    expect(faults[0]?.id).toBe('log-missing')
    expect(faults[0]?.tone).toBe('warn')
    expect(faults[0]?.tab).toBe('log')
    expect(faults[0]?.detail).toBe('No log file at C:\\PoE\\logs\\Client.txt')
  })

  it('reports a read error as bad, with the errno', () => {
    const faults = shellFaults({ ...READY, watcher: READ_ERROR })

    expect(faults).toHaveLength(1)
    expect(faults[0]?.id).toBe('log-error')
    expect(faults[0]?.tone).toBe('bad')
    expect(faults[0]?.detail).toBe('EACCES: permission denied')
  })

  /**
   * The silent one: everything looks healthy and not a single clip will ever be saved,
   * because no death can be recognised as the user's.
   */
  it('reports an unresolved character, pointing at the tab that fixes it', () => {
    const faults = shellFaults({ ...READY, character: NOBODY })

    expect(faults).toHaveLength(1)
    expect(faults[0]?.id).toBe('character-none')
    expect(faults[0]?.tone).toBe('bad')
    expect(faults[0]?.tab).toBe('character')
  })

  it('reports several at once, in pipeline order', () => {
    const faults = shellFaults({
      watcher: READ_ERROR,
      obs: connected(false),
      clipsEnabled: true,
      character: NOBODY
    })

    expect(faults.map((fault) => fault.id)).toEqual([
      'log-error',
      'character-none',
      'obs-replay-buffer'
    ])
  })
})
