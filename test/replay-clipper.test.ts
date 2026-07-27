/**
 * test/replay-clipper.test.ts
 * ===========================
 *
 * The death -> clip pipeline, driven through a REAL `TypedEmitter<PoeEventMap>`
 * rather than a stand-in bus: `ReplayClipper` claims to be wireable to the app bus,
 * and emitting on the real emitter is what actually proves that.
 *
 * The two collaborators that talk to the outside world are hand-written stubs - no
 * mocking library, per the project constraints. They are deliberately more than
 * call-counters:
 *
 *  - {@link FakeObsClient} hands back a DIFFERENT path per save, so the order the
 *    moves happened in is visible in the assertions rather than merely counted.
 *  - {@link FakeClipLibrary} tracks concurrent entries into `moveClip`, which is the
 *    only way to actually observe the serialisation queue. A test that just checked
 *    "both moves happened" would pass just as happily with the queue deleted.
 *
 * The clock is injected everywhere, so the 5s debounce window is exercised in
 * microseconds and no test is timing-dependent.
 */

import { describe, expect, it } from 'vitest'

import type { CurrentZone, DeathEvent, LogLineMeta, PoeEventMap } from '../src/shared/events'
import type { ClipRecord } from '../src/shared/ipc'
import { DEFAULT_SETTINGS, type AppSettings, type ClipSettings } from '../src/shared/settings'
import { TypedEmitter } from '../src/main/events/typed-emitter'
import type { MoveClipOptions } from '../src/main/obs/clip-library'
import type { ObsError, ObsResult, SavedReplay } from '../src/main/obs/obs-client'
import {
  ReplayClipper,
  isClipFailure,
  type ClipOutcome,
  type ClipOutcomeKind,
  type ClipperObsClient,
  type ClipTarget
} from '../src/main/obs/replay-clipper'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_DEATH_LINE =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'

/** Epoch ms used for `SavedReplay.savedAt`; drives the clip filename stamp. */
const SAVED_AT = new Date(2026, 6, 26, 19, 26, 32).getTime()

const KARUI_SHORES: CurrentZone = {
  displayName: 'Karui Shores',
  areaId: '2_11_endgame_town',
  areaLevel: 69,
  seed: 1,
  enteredAt: 1_700_000_000_000
}

const LIONEYE_WATCH: CurrentZone = {
  displayName: "Lioneye's Watch",
  areaId: '1_1_town',
  areaLevel: 1,
  seed: 1,
  enteredAt: 1_700_000_500_000
}

const DEATH_META: LogLineMeta = {
  raw: RAW_DEATH_LINE,
  timestamp: new Date(2026, 6, 26, 19, 26, 31),
  clientMs: 1_018_412_156,
  threadTag: 'cffb0658',
  level: 'INFO',
  subsystem: 'Client',
  pid: 50396,
  isSystemMessage: true,
  body: 'FyascoWorbinTime has been slain.'
}

function death(overrides: Partial<DeathEvent> = {}): DeathEvent {
  return {
    type: 'death',
    meta: DEATH_META,
    detectedAt: 1_700_000_000_000,
    backlog: false,
    characterName: 'FyascoWorbinTime',
    isSelf: true,
    ...overrides
  }
}

function settings(clips: Partial<ClipSettings> = {}, characterName = 'FyascoWorbinTime'): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    character: { name: characterName },
    clips: { ...DEFAULT_SETTINGS.clips, libraryDir: '/library', ...clips }
  }
}

/** A macrotask boundary, so overlapping work would genuinely overlap if unserialised. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class FakeObsClient implements ClipperObsClient {
  connected = true
  isRemoteObs = false
  bufferActive = true

  statusCalls = 0
  saveCalls = 0

  /** Non-null overrides the default success result. */
  result: ObsResult<SavedReplay> | null = null
  /** Simulates a collaborator breaking its "never throws" contract. */
  throwOnSave: Error | null = null
  /** Held across a macrotask so concurrency is observable. */
  saveDelayMs = 0

  async isReplayBufferActive(): Promise<boolean> {
    this.statusCalls += 1
    await delay(0)
    return this.bufferActive
  }

  async saveReplayBuffer(): Promise<ObsResult<SavedReplay>> {
    this.saveCalls += 1
    const index = this.saveCalls
    await delay(this.saveDelayMs)
    if (this.throwOnSave !== null) throw this.throwOnSave
    if (this.result !== null) return this.result
    return {
      ok: true,
      value: {
        savedReplayPath: `C:\\Users\\me\\Videos\\Replay-${index}.mkv`,
        savedAt: SAVED_AT
      }
    }
  }
}

class FakeClipLibrary implements ClipTarget {
  readonly calls: MoveClipOptions[] = []

  /** Live count of concurrent `moveClip` bodies, and its high-water mark. */
  active = 0
  maxActive = 0
  moveDelayMs = 0

  /** Non-null makes the move "fail" the way the real library reports failure. */
  failWithNote: string | null = null
  /** Non-null makes `moveClip` break its "never rejects" contract. */
  throwWith: Error | null = null

  async moveClip(options: MoveClipOptions): Promise<ClipRecord> {
    this.calls.push(options)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      await delay(this.moveDelayMs)
      if (this.throwWith !== null) throw this.throwWith

      const core = {
        savedAt: options.when.getTime(),
        originalPath: options.sourcePath,
        zoneName: options.zone.displayName,
        areaId: options.zone.areaId,
        areaLevel: options.zone.areaLevel,
        characterName: options.characterName
      }
      if (this.failWithNote !== null) {
        return { ...core, moved: false, finalPath: null, note: this.failWithNote }
      }
      const basename = options.sourcePath.slice(options.sourcePath.lastIndexOf('\\') + 1)
      return { ...core, moved: true, finalPath: `/library/${basename}`, note: null }
    } finally {
      this.active -= 1
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly bus: TypedEmitter<PoeEventMap>
  readonly obs: FakeObsClient
  readonly library: FakeClipLibrary
  readonly clipper: ReplayClipper
  readonly outcomes: ClipOutcome[]
  readonly clips: ClipRecord[]
  readonly kinds: () => ClipOutcomeKind[]
  readonly last: () => ClipOutcome
  readonly setNow: (ms: number) => void
  readonly setSettings: (next: AppSettings) => void
  readonly setZone: (next: CurrentZone) => void
  /** Emits a death on the real bus and waits for the pipeline to go quiet. */
  readonly die: (overrides?: Partial<DeathEvent>) => Promise<void>
}

function harness(initial: AppSettings = settings()): Harness {
  const bus = new TypedEmitter<PoeEventMap>()
  const obs = new FakeObsClient()
  const library = new FakeClipLibrary()
  const outcomes: ClipOutcome[] = []
  const clips: ClipRecord[] = []

  let now = 0
  let current = initial
  let zone = KARUI_SHORES

  const clipper = new ReplayClipper({
    bus,
    obs,
    library,
    getSettings: () => current,
    getZone: () => zone,
    clock: () => now
  })
  clipper.on('outcome', (outcome) => outcomes.push(outcome))
  clipper.on('clip', (record) => clips.push(record))

  return {
    bus,
    obs,
    library,
    clipper,
    outcomes,
    clips,
    kinds: () => outcomes.map((outcome) => outcome.kind),
    last: () => {
      const outcome = outcomes.at(-1)
      if (outcome === undefined) throw new Error('no outcome was emitted')
      return outcome
    },
    setNow: (ms) => {
      now = ms
    },
    setSettings: (next) => {
      current = next
    },
    setZone: (next) => {
      zone = next
    },
    die: async (overrides = {}) => {
      bus.emit('death:self', death(overrides))
      await clipper.idle()
    }
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('ReplayClipper - the happy path', () => {
  it('saves the replay buffer on the first death and files the clip', async () => {
    const h = harness()

    await h.die()

    expect(h.obs.statusCalls).toBe(1)
    expect(h.obs.saveCalls).toBe(1)
    expect(h.library.calls).toHaveLength(1)
    expect(h.kinds()).toEqual(['clipped'])

    const record = h.clips.at(0)
    expect(record?.moved).toBe(true)
    expect(record?.finalPath).toBe('/library/Replay-1.mkv')
    expect(record?.zoneName).toBe('Karui Shores')
  })

  it('hands the zone, character name and sidecar setting to the library', async () => {
    const h = harness(settings({ writeSidecar: true }, 'FyascoWorbinTime'))
    h.obs.isRemoteObs = true

    await h.die()

    const move = h.library.calls.at(0)
    expect(move?.zone).toEqual(KARUI_SHORES)
    expect(move?.characterName).toBe('FyascoWorbinTime')
    expect(move?.writeSidecar).toBe(true)
    expect(move?.isRemoteObs).toBe(true)
    // `when` is when OBS reported the file, matching ClipRecord.savedAt's contract.
    expect(move?.when.getTime()).toBe(SAVED_AT)
  })

  it('snapshots the zone at the moment of death, not when the save comes back', async () => {
    // PoE resurrects you in town a second or two after you die, so the tracker's
    // "current zone" has already moved on by the time OBS reports the file.
    const h = harness()
    h.obs.saveDelayMs = 5

    h.bus.emit('death:self', death())
    h.setZone(LIONEYE_WATCH)
    await h.clipper.idle()

    expect(h.library.calls.at(0)?.zone).toEqual(KARUI_SHORES)
    expect(h.clips.at(0)?.zoneName).toBe('Karui Shores')
  })

  it('emits an outcome that is not a failure', async () => {
    const h = harness()

    await h.die()

    expect(isClipFailure(h.last())).toBe(false)
    expect(h.last().message).toContain('FyascoWorbinTime')
  })
})

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('ReplayClipper - leading-edge debounce', () => {
  it('swallows a second death one second after the first', async () => {
    const h = harness()

    await h.die()
    h.setNow(1_000)
    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.library.calls).toHaveLength(1)
    expect(h.kinds()).toEqual(['clipped', 'skipped-debounced'])

    const skipped = h.last()
    expect(skipped.kind).toBe('skipped-debounced')
    if (skipped.kind === 'skipped-debounced') {
      expect(skipped.debounceMs).toBe(5_000)
      expect(skipped.remainingMs).toBe(4_000)
    }
    // Not a failure: this is the pipeline working as designed.
    expect(isClipFailure(skipped)).toBe(false)
  })

  it('clips again once the window has passed', async () => {
    const h = harness()

    await h.die()
    h.setNow(1_000)
    await h.die()
    h.setNow(6_000)
    await h.die()

    expect(h.obs.saveCalls).toBe(2)
    expect(h.library.calls).toHaveLength(2)
    expect(h.kinds()).toEqual(['clipped', 'skipped-debounced', 'clipped'])
  })

  it('fires the FIRST death immediately rather than waiting out the window', async () => {
    // Leading edge, not trailing: no timers are involved at all, so the save has
    // already been requested by the time the pipeline goes quiet.
    const h = harness(settings({ debounceMs: 60_000 }))

    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.kinds()).toEqual(['clipped'])
  })

  it('treats debounceMs: 0 as no debouncing at all', async () => {
    const h = harness(settings({ debounceMs: 0 }))

    await h.die()
    await h.die()

    expect(h.obs.saveCalls).toBe(2)
    expect(h.kinds()).toEqual(['clipped', 'clipped'])
  })

  it('reopens the window when the system clock jumps backwards', async () => {
    // An NTP correction or a DST change must not swallow every death until the
    // clock catches up again.
    const h = harness()

    await h.die()
    h.setNow(-3_600_000)
    await h.die()

    expect(h.obs.saveCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Deaths that must never clip
// ---------------------------------------------------------------------------

describe('ReplayClipper - deaths that must not clip', () => {
  it('never clips a backlog death', async () => {
    const h = harness()

    await h.die({ backlog: true })

    expect(h.obs.statusCalls).toBe(0)
    expect(h.obs.saveCalls).toBe(0)
    expect(h.library.calls).toHaveLength(0)
    expect(h.clips).toHaveLength(0)
    expect(h.kinds()).toEqual(['skipped-backlog'])
  })

  it('does not let a backlog death consume the debounce window', async () => {
    // Startup catch-up can replay dozens of deaths; the first LIVE death after them
    // must still clip immediately.
    const h = harness()

    await h.die({ backlog: true })
    await h.die({ backlog: true })
    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.kinds()).toEqual(['skipped-backlog', 'skipped-backlog', 'clipped'])
  })

  it('does nothing when clips are disabled, and does not consume the window', async () => {
    const h = harness(settings({ enabled: false }))

    await h.die()

    expect(h.obs.saveCalls).toBe(0)
    expect(h.kinds()).toEqual(['skipped-disabled'])

    h.setSettings(settings({ enabled: true }))
    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.kinds()).toEqual(['skipped-disabled', 'clipped'])
  })

  it('reads settings fresh on every death', async () => {
    const h = harness(settings({ debounceMs: 0 }))

    await h.die()
    h.setSettings(settings({ enabled: false, debounceMs: 0 }))
    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.kinds()).toEqual(['clipped', 'skipped-disabled'])
  })

  it('stops clipping once disposed', async () => {
    const h = harness(settings({ debounceMs: 0 }))

    await h.clipper.dispose()
    h.bus.emit('death:self', death())
    await h.clipper.idle()

    expect(h.clipper.running).toBe(false)
    expect(h.obs.saveCalls).toBe(0)
  })

  it('finishes every death admitted before dispose() instead of dropping it silently', async () => {
    // REGRESSION: `#enqueue` schedules the work as a MICROTASK, and `dispose()` sets
    // its flag synchronously before awaiting the queue - so a `#disposed` guard at
    // the top of the processing step discarded both admitted deaths before either
    // link ran: no clip, no outcome, nothing in the log. In production this is the
    // `before-quit` path, where `dispose()` is awaited ahead of the OBS teardown
    // precisely so in-flight clips can finish, and OBS is still connected.
    const h = harness(settings({ debounceMs: 0 }))

    h.bus.emit('death:self', death())
    h.bus.emit('death:self', death())
    await h.clipper.dispose()

    // Exactly one outcome per admitted death - the class's headline contract.
    expect(h.kinds()).toEqual(['clipped', 'clipped'])
    expect(h.obs.saveCalls).toBe(2)
    expect(h.library.calls).toHaveLength(2)
    expect(h.clips).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Failure surfaces
// ---------------------------------------------------------------------------

describe('ReplayClipper - OBS not connected', () => {
  it('reports its own outcome and asks nothing of OBS', async () => {
    const h = harness()
    h.obs.connected = false

    await h.die()

    expect(h.obs.statusCalls).toBe(0)
    expect(h.obs.saveCalls).toBe(0)
    expect(h.library.calls).toHaveLength(0)
    expect(h.kinds()).toEqual(['obs-not-connected'])
    expect(isClipFailure(h.last())).toBe(true)
    expect(h.last().message).toContain('not connected to OBS')
  })

  it('reports a socket lost between the status check and the save', async () => {
    const notConnected: ObsError = {
      kind: 'not-connected',
      message: 'Not connected to OBS, so poe-tool could not save a replay clip.'
    }
    const h = harness()
    h.obs.result = { ok: false, error: notConnected }

    await h.die()

    expect(h.kinds()).toEqual(['obs-not-connected'])
    expect(h.library.calls).toHaveLength(0)
  })
})

describe('ReplayClipper - replay buffer not active', () => {
  it('produces the buffer-inactive outcome and never attempts a save or a move', async () => {
    const h = harness()
    h.obs.bufferActive = false

    await h.die()

    expect(h.obs.statusCalls).toBe(1)
    expect(h.obs.saveCalls).toBe(0)
    expect(h.library.calls).toHaveLength(0)
    expect(h.clips).toHaveLength(0)
    expect(h.kinds()).toEqual(['replay-buffer-inactive'])
  })

  it('tells the user to start the replay buffer in OBS, and never starts it itself', async () => {
    const h = harness()
    h.obs.bufferActive = false

    await h.die()

    const message = h.last().message
    expect(message).toContain('replay buffer is not running')
    expect(message).toContain('Start Replay Buffer')
    expect(message).toContain('never starts the replay buffer for you')
    expect(isClipFailure(h.last())).toBe(true)
  })

  it('maps OBS answering RequestStatus 501 to the same outcome', async () => {
    // The user can stop the buffer in the moment between our status probe and the
    // save request; OBS then answers `buffer-inactive` itself.
    const h = harness()
    h.obs.result = {
      ok: false,
      error: { kind: 'buffer-inactive', message: 'The OBS replay buffer is not running.' }
    }

    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.library.calls).toHaveLength(0)
    expect(h.kinds()).toEqual(['replay-buffer-inactive'])
    expect(h.last().message).toContain('Start Replay Buffer')
  })
})

describe('ReplayClipper - save failures', () => {
  it('reports a rejected save request with the underlying error attached', async () => {
    const rejected: ObsError = {
      kind: 'request-failed',
      message: 'The OBS request SaveReplayBuffer failed (code 604): request cancelled.',
      code: 604,
      requestType: 'SaveReplayBuffer'
    }
    const h = harness()
    h.obs.result = { ok: false, error: rejected }

    await h.die()

    expect(h.library.calls).toHaveLength(0)
    expect(h.clips).toHaveLength(0)
    const outcome = h.last()
    expect(outcome.kind).toBe('save-rejected')
    if (outcome.kind === 'save-rejected') {
      expect(outcome.error).toEqual(rejected)
    }
    expect(outcome.message).toContain('refused to save')
    expect(isClipFailure(outcome)).toBe(true)
  })

  it('gives a timed-out ReplayBufferSaved its own outcome', async () => {
    const h = harness()
    h.obs.result = {
      ok: false,
      error: {
        kind: 'save-timeout',
        message:
          'OBS accepted the save but did not report a file within 10000ms. The clip may still have been written - check the OBS recording folder.',
        timeoutMs: 10_000
      }
    }

    await h.die()

    expect(h.obs.saveCalls).toBe(1)
    expect(h.library.calls).toHaveLength(0)
    expect(h.clips).toHaveLength(0)

    const outcome = h.last()
    expect(outcome.kind).toBe('save-timeout')
    if (outcome.kind === 'save-timeout') {
      expect(outcome.timeoutMs).toBe(10_000)
    }
    // The wording must not claim the clip is gone - it may well be on disk.
    expect(outcome.message).toContain('may still have been written')
    expect(isClipFailure(outcome)).toBe(true)
  })

  it('does not throw when the OBS client breaks its never-throws contract', async () => {
    const h = harness()
    h.obs.throwOnSave = new Error('socket exploded')

    await expect(h.die()).resolves.toBeUndefined()

    expect(h.kinds()).toEqual(['internal-error'])
    expect(h.library.calls).toHaveLength(0)
    expect(isClipFailure(h.last())).toBe(true)
  })
})

describe('ReplayClipper - move failures', () => {
  it('reports a failed move without throwing, and still publishes the clip', async () => {
    const note =
      'Could not move the clip into /library: EBUSY: simulated EBUSY. The original file is untouched at C:\\Users\\me\\Videos\\Replay-1.mkv.'
    const h = harness()
    h.library.failWithNote = note

    await expect(h.die()).resolves.toBeUndefined()

    expect(h.kinds()).toEqual(['move-failed'])
    expect(h.last().message).toBe(note)
    expect(isClipFailure(h.last())).toBe(true)

    // `finalPath: null` means "still at originalPath", never "no clip" - so the
    // record is published either way.
    const record = h.clips.at(0)
    expect(record?.moved).toBe(false)
    expect(record?.finalPath).toBeNull()
    expect(record?.originalPath).toBe('C:\\Users\\me\\Videos\\Replay-1.mkv')
  })

  it('survives a library that rejects, and synthesises a record pointing at the OBS file', async () => {
    const h = harness()
    h.library.throwWith = new Error('EPERM: operation not permitted')

    await expect(h.die()).resolves.toBeUndefined()

    expect(h.kinds()).toEqual(['move-failed'])
    const record = h.clips.at(0)
    expect(record?.moved).toBe(false)
    expect(record?.finalPath).toBeNull()
    expect(record?.originalPath).toBe('C:\\Users\\me\\Videos\\Replay-1.mkv')
    expect(record?.note).toContain('EPERM')
    expect(record?.zoneName).toBe('Karui Shores')
  })

  it('does not stop the next death from clipping', async () => {
    const h = harness(settings({ debounceMs: 0 }))
    h.library.failWithNote = 'nope'

    await h.die()
    h.library.failWithNote = null
    await h.die()

    expect(h.kinds()).toEqual(['move-failed', 'clipped'])
  })
})

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('ReplayClipper - serialisation', () => {
  it('never lets two rapid deaths interleave their moves', async () => {
    // Debouncing off is the only way two deaths reach the queue at once; this is the
    // configuration the promise chain exists for.
    const h = harness(settings({ debounceMs: 0 }))
    h.obs.saveDelayMs = 5
    h.library.moveDelayMs = 5

    h.bus.emit('death:self', death())
    h.bus.emit('death:self', death())
    await h.clipper.idle()

    expect(h.library.maxActive).toBe(1)
    expect(h.library.calls).toHaveLength(2)
    // In order, and each move got its own OBS file rather than both seeing the same.
    expect(h.library.calls.map((call) => call.sourcePath)).toEqual([
      'C:\\Users\\me\\Videos\\Replay-1.mkv',
      'C:\\Users\\me\\Videos\\Replay-2.mkv'
    ])
    expect(h.clips.map((clip) => clip.finalPath)).toEqual([
      '/library/Replay-1.mkv',
      '/library/Replay-2.mkv'
    ])
  })

  it('keeps processing after a link in the chain fails', async () => {
    const h = harness(settings({ debounceMs: 0 }))
    h.library.throwWith = new Error('first one explodes')

    h.bus.emit('death:self', death())
    await h.clipper.idle()
    h.library.throwWith = null
    h.bus.emit('death:self', death())
    await h.clipper.idle()

    expect(h.kinds()).toEqual(['move-failed', 'clipped'])
  })
})

// ---------------------------------------------------------------------------
// Robustness of the emit path
// ---------------------------------------------------------------------------

describe('ReplayClipper - listener and collaborator robustness', () => {
  it('does not let a throwing outcome listener break the pipeline', async () => {
    const h = harness(settings({ debounceMs: 0 }))
    h.clipper.on('outcome', () => {
      throw new Error('listener exploded')
    })

    await expect(h.die()).resolves.toBeUndefined()
    await expect(h.die()).resolves.toBeUndefined()

    expect(h.obs.saveCalls).toBe(2)
    expect(h.kinds()).toEqual(['clipped', 'clipped'])
  })

  it('never throws out of the bus emit, whatever the settings reader does', () => {
    const bus = new TypedEmitter<PoeEventMap>()
    const clipper = new ReplayClipper({
      bus,
      obs: new FakeObsClient(),
      library: new FakeClipLibrary(),
      getSettings: () => {
        throw new Error('settings.json is on fire')
      },
      getZone: () => KARUI_SHORES,
      clock: () => 0
    })
    const outcomes: ClipOutcome[] = []
    clipper.on('outcome', (outcome) => outcomes.push(outcome))

    expect(() => bus.emit('death:self', death())).not.toThrow()
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['internal-error'])
  })

  it('falls back to an unknown zone when the tracker throws', async () => {
    const bus = new TypedEmitter<PoeEventMap>()
    const library = new FakeClipLibrary()
    const clipper = new ReplayClipper({
      bus,
      obs: new FakeObsClient(),
      library,
      getSettings: () => settings(),
      getZone: () => {
        throw new Error('tracker exploded')
      },
      clock: () => 0
    })

    bus.emit('death:self', death())
    await clipper.idle()

    expect(library.calls.at(0)?.zone.displayName).toBeNull()
    expect(library.calls).toHaveLength(1)
  })
})
