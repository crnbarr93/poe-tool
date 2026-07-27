/**
 * test/ipc-handlers.test.ts
 * =========================
 *
 * Two halves of the wire protocol:
 *
 *  1. THE CHARACTER HALF - `character:active`, `character:suggestions`, the
 *     `push:character` broadcast, and the `refreshOverride()` poke a settings write owes
 *     the tracker.
 *  2. THE SECRETS AND UPLOADS HALF - that a password crosses this boundary in ONE
 *     direction only, that an empty one in a patch means "leave the stored one alone",
 *     that `streamable:test` honours the master switch and falls back to the stored
 *     credential, and that `push:clip-upload` reaches the window and keeps
 *     `clips:recent` honest.
 *
 * The password rules are pinned here rather than left to review because every one of them
 * fails SILENTLY and in the expensive direction: a leak is invisible until someone reads
 * a devtools panel, and a wipe looks like the app randomly forgetting a credential.
 *
 * WHY THE REAL BUS AND THE REAL TRACKER ARE USED
 * ----------------------------------------------
 * `CharacterPort` is a STRUCTURAL port: nothing declares `implements`, so the only thing
 * proving `CharacterTracker` still satisfies it is a call site that passes one. A hand-
 * written stub would keep passing forever after the tracker's shape moved, which is
 * exactly the regression this file exists to catch. Same reasoning for `PoeEventBus`:
 * `character-changed` is emitted by the tracker and consumed here, and a test that faked
 * the middle would not prove the two agree on the channel name.
 *
 * The ports that are NOT the subject (settings, obs, clipper, watcher, updater,
 * streamable, uploads, credentials) are stubs, because dragging `SettingsStore` in would
 * put a real disk write in the middle of an assertion about a broadcast - and dragging
 * the Streamable client in would put a network call there.
 *
 * `electron` is mocked module-wide. `ipc-handlers.ts` is one of the three files allowed
 * to import it, and `ipcMain.handle` is the only part of it this file needs - so the mock
 * is a `Map` of channel -> handler that the tests then invoke directly, which is what the
 * renderer's `invoke` does anyway.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so `vi.mock('electron')` below does not have to provide it at runtime.
import type { BrowserWindow } from 'electron'

import type { ActiveCharacter, LevelUpEvent, PoeEvent, WatcherStatus } from '../src/shared/events'
import { IPC_INVOKE, IPC_PUSH } from '../src/shared/ipc'
import type {
  ClipRecord,
  ClipUploadUpdate,
  CredentialsStatusResult,
  IpcInvokeChannel,
  ObsConnectionState,
  ObsTestRequest,
  ObsTestResult,
  SessionStatsSnapshot,
  StreamableTestRequest,
  StreamableTestResult,
  UpdateState
} from '../src/shared/ipc'
import type { AppSettings, DeepPartial } from '../src/shared/settings'
import { applySettingsPatch, DEFAULT_SETTINGS } from '../src/shared/settings'

// ---------------------------------------------------------------------------
// electron
// ---------------------------------------------------------------------------

/**
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports and therefore
 * cannot close over an ordinary `const` declared below it.
 */
const { ipcMainMock } = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()

  return {
    ipcMainMock: {
      handlers,
      handle(channel: string, handler: Handler): void {
        handlers.set(channel, handler)
      },
      removeHandler(channel: string): void {
        handlers.delete(channel)
      }
    }
  }
})

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

// Imported AFTER the mock is declared; `vi.mock` is hoisted, so this still sees it.
import { PoeEventBus } from '../src/main/events/event-bus'
import { registerIpcHandlers, type IpcHandlerDeps } from '../src/main/ipc-handlers'
import { CharacterTracker } from '../src/main/log/character-tracker'
import { parseLine } from '../src/main/log/parse-line'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Verbatim from the reference Client.txt. */
const LEVEL_LINE =
  '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2'
/** Verbatim. A normal death. */
const SLAIN_LINE =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
/** Verbatim. PoE's `/kill`. */
const SUICIDE_LINE =
  '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : LargeThumbThomasReturns has committed suicide.'
/** Verbatim. Names a PLACE, not a person - must never reach the suggestion list. */
const ZONE_LINE =
  '2026/07/26 19:26:29 1018410000 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'

const T0 = 1_700_000_000_000

/** A real parsed event, so the fixtures carry a genuine envelope. */
function eventFrom(line: string): PoeEvent {
  const parsed = parseLine(line, { detectedAt: T0, backlog: false, selfName: '' })
  if (parsed.type === 'unmatched') throw new Error(`did not parse: ${line}`)
  return parsed
}

function levelUpFrom(line: string): LevelUpEvent {
  const event = eventFrom(line)
  if (event.type !== 'level-up') throw new Error(`not a level-up: ${line}`)
  return event
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One `webContents.send` call. */
interface Sent {
  readonly channel: string
  readonly payload: unknown
}

interface Harness {
  readonly bus: PoeEventBus
  readonly tracker: CharacterTracker
  readonly sent: Sent[]
  readonly settingsNow: () => AppSettings
  readonly dispose: () => void
  /** Calls a registered invoke handler exactly the way the renderer would. */
  readonly invoke: (channel: IpcInvokeChannel, ...args: unknown[]) => Promise<unknown>
  /**
   * Every credential main handed to the Streamable client, in order.
   *
   * The point of recording it is the NEGATIVE assertions: that nothing reaches the client
   * when the master switch is off, and that a blank from the renderer arrives as the
   * stored password rather than as an empty string.
   */
  readonly streamableCalls: readonly StreamableTestRequest[]
  readonly setStreamableResult: (result: StreamableTestResult) => void
  /** Make the client THROW instead of resolving, to exercise the crash path. */
  readonly breakStreamable: (error: unknown) => void
  readonly setCredentialStatus: (status: CredentialsStatusResult) => void
  /** Make `settings.save()` throw, the way a full or read-only disk does. */
  readonly breakSettingsSave: (error: unknown) => void
  /** Make `credentials:status` throw, to exercise the fallback. */
  readonly breakCredentials: (error: unknown) => void
  /** Make `app:version` throw, to check the window is told nothing rather than a guess. */
  readonly breakAppVersion: (error: unknown) => void
  /** Emit a clip the way `ReplayClipper` does. */
  readonly emitClip: (clip: ClipRecord) => void
  /** Emit an upload state change the way the upload queue does. */
  readonly emitUpload: (update: ClipUploadUpdate) => void
  /** How many times `settings:set` has poked the upload queue. */
  readonly uploadReconfigures: () => number
  /** Move the counters the way `SessionStats` does, then announce it. */
  readonly emitStats: (snapshot: SessionStatsSnapshot) => void
  /** Make `stats.snapshot` throw, which the port is contracted never to do. */
  readonly breakStats: (error: unknown) => void
}

/** Both slots healthy and empty - the state of a machine nobody has configured yet. */
const CREDENTIALS_EMPTY: CredentialsStatusResult = {
  obs: { status: 'ok', present: false },
  streamable: { status: 'ok', present: false }
}

/** A filed clip, in the state the clipper emits one: saved, moved, not yet uploaded. */
function clipRecord(id: string, upload: ClipRecord['upload']): ClipRecord {
  return {
    id,
    savedAt: T0,
    originalPath: 'C:\\obs\\Replay 2026-07-27.mkv',
    finalPath: 'D:\\clips\\poe-tool\\death.mkv',
    zoneName: 'Karui Shores',
    areaId: '2_11_endgame_town',
    areaLevel: 68,
    characterName: 'FyascoWorbinTime',
    cause: 'slain',
    moved: true,
    note: null,
    upload
  }
}

/** Every harness built in the current test, torn down by the shared `afterEach`. */
const live: Harness[] = []

/**
 * A real temp directory for the tests that need a real Client.txt on disk.
 *
 * `character:suggestions` sweeps the tail of `settings.log.path`, and the point of
 * those tests is that a file the app has NOT tailed still yields names - so the file
 * has to genuinely exist. Every other test leaves `log.path` null, where the sweep is
 * a no-op.
 */
let logDir = ''

beforeEach(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), 'poe-tool-ipc-'))
})

afterEach(async () => {
  while (live.length > 0) live.pop()?.dispose()
  await rm(logDir, { recursive: true, force: true })
})

function makeHarness(initial: DeepPartial<AppSettings> = {}): Harness {
  ipcMainMock.handlers.clear()

  const sent: Sent[] = []
  let settings: AppSettings = applySettingsPatch(DEFAULT_SETTINGS, initial)

  const bus = new PoeEventBus()

  const tracker = new CharacterTracker({
    bus,
    getOverride: () => settings.character.override,
    getPersisted: () => ({
      name: settings.character.detected,
      className: settings.character.detectedClass,
      level: settings.character.detectedLevel
    }),
    persist: (detection) => {
      settings = applySettingsPatch(settings, {
        character: {
          detected: detection.name,
          detectedClass: detection.className,
          detectedLevel: detection.level
        }
      })
    }
  })

  /**
   * Stands in for a `BrowserWindow`. The two `isDestroyed` guards and `webContents.send`
   * are the whole of what `makeSender` touches; the assertion is through `unknown` (never
   * `any`) and is confined to this one expression so the rest of the file stays typed.
   */
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown): void => {
        sent.push({ channel, payload })
      }
    }
  } as unknown as BrowserWindow

  // --- the stubs the second half of this file drives ------------------------

  const streamableCalls: StreamableTestRequest[] = []
  let streamableResult: StreamableTestResult = { ok: true }
  /** Non-null makes `testCredentials` throw, which it is contracted never to do. */
  let streamableThrows: { readonly error: unknown } | null = null

  let credentialStatus: CredentialsStatusResult = CREDENTIALS_EMPTY
  let credentialsThrows: { readonly error: unknown } | null = null

  let uploadReconfigureCount = 0

  // Sets rather than single slots so that `off()` failing to remove the exact listener
  // shows up as a broadcast after teardown rather than as a silent pass.
  const clipListeners = new Set<(clip: ClipRecord) => void>()
  const uploadListeners = new Set<(update: ClipUploadUpdate) => void>()
  const statsListeners = new Set<(snapshot: SessionStatsSnapshot) => void>()

  /** What `stats.snapshot` currently answers. Moved by `emitStats`. */
  let statsSnapshot: SessionStatsSnapshot = {
    startedAt: T0,
    uptimeMs: 0,
    areasEntered: 0,
    deaths: 0,
    suicides: 0,
    characterLevel: null
  }

  /** Non-null makes `stats.snapshot` throw, which the port is contracted never to do. */
  let statsThrows: { readonly error: unknown } | null = null

  /** Non-null makes every `save` throw, the way a read-only or full disk does. */
  let saveThrows: { readonly error: unknown } | null = null

  /** Non-null makes `appVersion` throw, which the port is contracted never to do. */
  let appVersionThrows: { readonly error: unknown } | null = null

  const deps: IpcHandlerDeps = {
    appVersion: () => {
      if (appVersionThrows !== null) throw appVersionThrows.error
      return '0.0.0-test'
    },
    settings: {
      get: () => settings,
      save: (patch) => {
        if (saveThrows !== null) throw saveThrows.error
        settings = applySettingsPatch(settings, patch)
        return settings
      }
    },
    bus,
    characters: tracker,
    obs: {
      state: { state: 'disconnected', since: T0 } satisfies ObsConnectionState,
      testConnection: (_config: ObsTestRequest): Promise<ObsTestResult> =>
        Promise.resolve({ ok: false, error: 'not used' }),
      connect: (): Promise<ObsConnectionState> =>
        Promise.resolve({ state: 'disconnected', since: T0 }),
      disconnect: (): Promise<void> => Promise.resolve(),
      on: () => undefined,
      off: () => undefined
    },
    clipper: {
      on: (_channel, listener) => clipListeners.add(listener),
      off: (_channel, listener) => clipListeners.delete(listener)
    },
    streamable: {
      testCredentials: (request: StreamableTestRequest): Promise<StreamableTestResult> => {
        streamableCalls.push(request)
        if (streamableThrows !== null) throw streamableThrows.error
        return Promise.resolve(streamableResult)
      }
    },
    uploads: {
      reconfigure: () => {
        uploadReconfigureCount += 1
      },
      on: (_channel, listener) => uploadListeners.add(listener),
      off: (_channel, listener) => uploadListeners.delete(listener)
    },
    credentials: {
      status: (): CredentialsStatusResult => {
        if (credentialsThrows !== null) throw credentialsThrows.error
        return credentialStatus
      }
    },
    watcher: {
      status: { state: 'idle', path: null, since: T0 } satisfies WatcherStatus,
      reconfigure: () => undefined
    },
    // Auto-update is not this file's subject; a stub in the state a dev build reports is
    // enough to satisfy the port. `test/update-state.test.ts` covers the state machine.
    updater: {
      state: { state: 'disabled-in-dev' } satisfies UpdateState,
      on: () => undefined,
      off: () => undefined
    },
    // The COUNTING rules are `test/session-stats.test.ts`'s subject, not this file's - so
    // the snapshot is a settable value rather than a real `SessionStats`. What IS this
    // file's subject is the wire: that the getter is read per request rather than
    // captured once, that a throw degrades to `null`, and that `push:stats` reaches the
    // window and stops at teardown. A `Set` of listeners rather than a single slot, so an
    // `off()` that removes the wrong one shows up as a broadcast after dispose.
    stats: {
      get snapshot(): SessionStatsSnapshot {
        if (statsThrows !== null) throw statsThrows.error
        return statsSnapshot
      },
      on: (_channel, listener) => statsListeners.add(listener),
      off: (_channel, listener) => statsListeners.delete(listener)
    },
    getWindow: () => window,
    onError: () => undefined
  }

  const dispose = registerIpcHandlers(deps)

  const harness: Harness = {
    bus,
    tracker,
    sent,
    settingsNow: () => settings,
    dispose,
    invoke: async (channel, ...args) => {
      const handler = ipcMainMock.handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
      return await handler(undefined, ...args)
    },
    streamableCalls,
    setStreamableResult: (result) => {
      streamableResult = result
    },
    breakStreamable: (error) => {
      streamableThrows = { error }
    },
    setCredentialStatus: (status) => {
      credentialStatus = status
    },
    breakSettingsSave: (error) => {
      saveThrows = { error }
    },
    breakCredentials: (error) => {
      credentialsThrows = { error }
    },
    breakAppVersion: (error) => {
      appVersionThrows = { error }
    },
    emitClip: (clip) => {
      for (const listener of clipListeners) listener(clip)
    },
    emitUpload: (update) => {
      for (const listener of uploadListeners) listener(update)
    },
    uploadReconfigures: () => uploadReconfigureCount,
    // Mirrors `SessionStats`: the counters move FIRST and the announcement follows, so a
    // handler that answered `stats:session` from a stale capture would disagree with the
    // push it just sent.
    emitStats: (snapshot) => {
      statsSnapshot = snapshot
      for (const listener of statsListeners) listener(snapshot)
    },
    breakStats: (error) => {
      statsThrows = { error }
    }
  }

  live.push(harness)
  return harness
}

/** Only the `push:character` payloads, in order. */
function characterPushes(sent: readonly Sent[]): readonly ActiveCharacter[] {
  const out: ActiveCharacter[] = []
  for (const item of sent) {
    if (item.channel !== IPC_PUSH.CHARACTER) continue
    // Narrowed by the channel, which the push contract pairs with this payload type.
    out.push(item.payload as ActiveCharacter)
  }
  return out
}

// ---------------------------------------------------------------------------
// app:version
// ---------------------------------------------------------------------------

describe('app:version', () => {
  it('hands the window the running build, not a number the layout was drawn with', async () => {
    const h = makeHarness()

    expect(await h.invoke(IPC_INVOKE.APP_VERSION)).toBe('0.0.0-test')
  })

  it('answers "" rather than a guess when the version cannot be read', async () => {
    const h = makeHarness()
    h.breakAppVersion(new Error('no app object'))

    // `''` is the documented "unknown" answer and the sidebar renders no version line for
    // it. A fallback value would send a bug report to the wrong release.
    expect(await h.invoke(IPC_INVOKE.APP_VERSION)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// stats:session / push:stats
// ---------------------------------------------------------------------------

/** Only the `push:stats` payloads, in order. */
function statsPushes(sent: readonly Sent[]): readonly SessionStatsSnapshot[] {
  const out: SessionStatsSnapshot[] = []
  for (const item of sent) {
    if (item.channel !== IPC_PUSH.STATS) continue
    // Narrowed by the channel, which the push contract pairs with this payload type.
    out.push(item.payload as SessionStatsSnapshot)
  }
  return out
}

/**
 * The session counters on the wire.
 *
 * The COUNTING is pinned in `test/session-stats.test.ts`. What is pinned here is the
 * transport, and the thing that makes it worth pinning is that the Activity view's stat
 * strip has no other source: if this channel silently answers a stale or zeroed snapshot,
 * the window shows a confident "0 deaths" for an evening that had six, and nothing
 * anywhere says otherwise.
 */
describe('stats:session', () => {
  it('reads the counters per request rather than capturing them at registration', async () => {
    const h = makeHarness()

    expect(await h.invoke(IPC_INVOKE.STATS_SESSION)).toMatchObject({
      areasEntered: 0,
      deaths: 0
    })

    h.emitStats({
      startedAt: T0,
      uptimeMs: 60_000,
      areasEntered: 4,
      deaths: 2,
      suicides: 1,
      characterLevel: 71
    })

    // The SECOND read has to see the movement. A handler closing over the snapshot at
    // registration time would still answer zeroes here, and a window opened mid-session
    // would then sit at 0/0 until the next push happened to arrive.
    expect(await h.invoke(IPC_INVOKE.STATS_SESSION)).toMatchObject({
      areasEntered: 4,
      deaths: 2,
      suicides: 1,
      characterLevel: 71
    })
  })

  it('answers null rather than a zeroed snapshot when the counters cannot be read', async () => {
    const h = makeHarness()
    h.breakStats(new Error('clock exploded'))

    // `null` is "we do not know"; `{ deaths: 0 }` would be the CLAIM that nothing has
    // happened, which the stat strip would print as confidently as a real reading. The
    // renderer shows em-dashes for null and that is the whole point of the distinction.
    expect(await h.invoke(IPC_INVOKE.STATS_SESSION)).toBeNull()
  })
})

describe('push:stats', () => {
  it('forwards a counter change to the window', () => {
    const h = makeHarness()

    const moved: SessionStatsSnapshot = {
      startedAt: T0,
      uptimeMs: 90_000,
      areasEntered: 7,
      deaths: 3,
      suicides: 0,
      characterLevel: 68
    }
    h.emitStats(moved)

    expect(statsPushes(h.sent)).toEqual([moved])
  })

  it('stops broadcasting once the handlers are disposed', () => {
    const h = makeHarness()

    h.dispose()
    h.emitStats({
      startedAt: T0,
      uptimeMs: 1,
      areasEntered: 1,
      deaths: 1,
      suicides: 0,
      characterLevel: 2
    })

    // A listener left attached to a `SessionStats` that outlives the window is a send to
    // a destroyed `webContents` on the next death.
    expect(statsPushes(h.sent)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// character:active
// ---------------------------------------------------------------------------

describe('character:active', () => {
  it('reports source "none" before anything has been detected or typed', async () => {
    const h = makeHarness()

    // The state the whole warning banner exists for: name null, so every `isSelf` is
    // false and the clipper never fires.
    expect(await h.invoke(IPC_INVOKE.CHARACTER_ACTIVE)).toEqual({
      name: null,
      className: null,
      level: null,
      source: 'none'
    })
  })

  it('reports the auto-detected character after a single level-up', async () => {
    const h = makeHarness()
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    expect(await h.invoke(IPC_INVOKE.CHARACTER_ACTIVE)).toEqual({
      name: 'LargeThumbThomasReturns',
      className: 'Marauder',
      level: 2,
      source: 'detected'
    })
  })

  it('resolves a persisted detection with no level-up this session', async () => {
    // The sparse-level-up case: one detection, months ago, read back off settings.json.
    const h = makeHarness({
      character: { detected: 'Burgertrash', detectedClass: 'Slayer', detectedLevel: 84 }
    })

    expect(await h.invoke(IPC_INVOKE.CHARACTER_ACTIVE)).toEqual({
      name: 'Burgertrash',
      className: 'Slayer',
      level: 84,
      source: 'detected'
    })
  })

  it('lets a manual override out-rank a detection, and says so in source', async () => {
    const h = makeHarness({ character: { override: 'OneLongToe' } })
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    // Group play: the level-up was a party member's, and the typed name wins.
    expect(await h.invoke(IPC_INVOKE.CHARACTER_ACTIVE)).toEqual({
      name: 'OneLongToe',
      className: null,
      level: null,
      source: 'override'
    })
  })

  it('is main that resolves, not the renderer: the raw settings still hold both halves', async () => {
    const h = makeHarness({ character: { override: 'OneLongToe' } })
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    const settings = await h.invoke(IPC_INVOKE.SETTINGS_GET)
    expect(settings).toMatchObject({
      character: { override: 'OneLongToe', detected: 'LargeThumbThomasReturns' }
    })
  })
})

// ---------------------------------------------------------------------------
// character:suggestions
// ---------------------------------------------------------------------------

describe('character:suggestions', () => {
  it('is empty when no log path is configured, which is a normal answer', async () => {
    const h = makeHarness()
    expect(await h.invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS)).toEqual({ names: [] })
  })

  it('offers the names in the log on a FRESH LAUNCH, before anything has been tailed', async () => {
    // REGRESSION, and the whole reason this channel exists. The picker is shown in
    // exactly one state - `source: 'none'`, where every death reads as somebody else's
    // and not one clip is ever saved - and that state is most common on a first run.
    // `LogWatcher` starts with `seekToEnd()`, so on a first run the session ring buffer
    // is empty and STAYS empty until the user's next death or level-up: harvesting only
    // from it answered "none yet, play for a bit and press Refresh" while every name
    // needed to fix the problem sat in the log file main already had open.
    const logPath = path.join(logDir, 'Client.txt')
    await writeFile(logPath, `${SLAIN_LINE}\r\n${ZONE_LINE}\r\n${LEVEL_LINE}\r\n`, 'utf8')

    const h = makeHarness({ log: { path: logPath } })

    // Nothing has been published onto the bus at all - this is a cold start.
    expect(await h.invoke(IPC_INVOKE.EVENTS_RECENT)).toEqual([])
    // One appearance each, so the tie-break decides: most recently seen first, which
    // needs the sweep to preserve file order.
    expect(await h.invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS)).toEqual({
      names: ['LargeThumbThomasReturns', 'FyascoWorbinTime']
    })
  })

  it('merges the log sweep with the session, counting both', async () => {
    const logPath = path.join(logDir, 'Client.txt')
    await writeFile(logPath, `${SLAIN_LINE}\r\n`, 'utf8')

    const h = makeHarness({ log: { path: logPath } })
    // Two live level-ups this session put LargeThumbThomasReturns ahead of the single
    // death sitting in the file; a tally over one source or the other would rank them
    // differently, so this pins that the two are counted together.
    h.bus.publish(eventFrom(LEVEL_LINE))
    h.bus.publish(eventFrom(SUICIDE_LINE))

    expect(await h.invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS)).toEqual({
      names: ['LargeThumbThomasReturns', 'FyascoWorbinTime']
    })
  })

  it('degrades to the session buffer when the configured log cannot be read', async () => {
    const h = makeHarness({ log: { path: path.join(logDir, 'nope', 'Client.txt') } })
    h.bus.publish(eventFrom(SLAIN_LINE))

    // A missing file is the normal "the game has never run" case. It must not cost the
    // user the names main HAS seen, and it must not reject the invoke.
    expect(await h.invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS)).toEqual({
      names: ['FyascoWorbinTime']
    })
  })

  it('harvests names from deaths and level-ups, most frequent first', async () => {
    const h = makeHarness()

    // Published onto `event`, which is the channel the ring buffer listens on.
    h.bus.publish(eventFrom(SLAIN_LINE))
    h.bus.publish(eventFrom(LEVEL_LINE))
    h.bus.publish(eventFrom(SUICIDE_LINE))
    h.bus.publish(eventFrom(LEVEL_LINE))

    // LargeThumbThomasReturns: 3 (two level-ups + a suicide). FyascoWorbinTime: 1.
    expect(await h.invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS)).toEqual({
      names: ['LargeThumbThomasReturns', 'FyascoWorbinTime']
    })
  })

  it('never offers a zone name as a character', async () => {
    const h = makeHarness()
    h.bus.publish(eventFrom(ZONE_LINE))

    expect(await h.invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS)).toEqual({ names: [] })
  })
})

// ---------------------------------------------------------------------------
// push:character
// ---------------------------------------------------------------------------

describe('push:character', () => {
  it('broadcasts when a level-up changes the resolved character', () => {
    const h = makeHarness()

    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    expect(characterPushes(h.sent)).toEqual([
      { name: 'LargeThumbThomasReturns', className: 'Marauder', level: 2, source: 'detected' }
    ])
  })

  it('does not re-broadcast an unchanged answer', () => {
    const h = makeHarness()

    // A rotation re-read legitimately replays the same level-up line.
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    expect(characterPushes(h.sent)).toHaveLength(1)
  })

  it('stops broadcasting after teardown', () => {
    const h = makeHarness()
    // A window torn down mid-session must not leave a listener that keeps sending into
    // it: `webContents.send` on a destroyed window throws, and this listener runs inside
    // the tail loop's thread of control.
    h.dispose()

    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    expect(characterPushes(h.sent)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// settings:set -> refreshOverride()
// ---------------------------------------------------------------------------

describe('settings:set and the character tracker', () => {
  it('pokes refreshOverride so the UI hears about a typed override', async () => {
    const h = makeHarness()

    await h.invoke(IPC_INVOKE.SETTINGS_SET, { character: { override: 'FyascoWorbinTime' } })

    // Without the refreshOverride() call the override would still take effect for
    // `isSelf` (the watcher re-reads it per line) but nothing would ever be pushed, so
    // the "no character detected" warning would stay on screen after the user fixed it.
    expect(characterPushes(h.sent)).toEqual([
      { name: 'FyascoWorbinTime', className: null, level: null, source: 'override' }
    ])
  })

  it('pushes again when the override is cleared and detection takes back over', async () => {
    const h = makeHarness()
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    await h.invoke(IPC_INVOKE.SETTINGS_SET, { character: { override: 'FyascoWorbinTime' } })
    await h.invoke(IPC_INVOKE.SETTINGS_SET, { character: { override: '' } })

    expect(characterPushes(h.sent).at(-1)).toEqual({
      name: 'LargeThumbThomasReturns',
      className: 'Marauder',
      level: 2,
      source: 'detected'
    })
  })

  it('does not let the renderer forge or clobber a detection', async () => {
    const h = makeHarness()
    h.tracker.handleLevelUp(levelUpFrom(LEVEL_LINE))

    // The renderer sends its WHOLE settings object as the patch, and its copy of
    // `detected` is routinely older than main's. Letting it through would roll back a
    // detection that may be the only one for weeks.
    await h.invoke(IPC_INVOKE.SETTINGS_SET, {
      character: { override: '', detected: 'ImpostorName', detectedClass: 'Witch', detectedLevel: 99 }
    })

    expect(h.settingsNow().character).toMatchObject({
      detected: 'LargeThumbThomasReturns',
      detectedClass: 'Marauder',
      detectedLevel: 2
    })
  })

  it('leaves an unrelated settings write alone', async () => {
    const h = makeHarness()

    await h.invoke(IPC_INVOKE.SETTINGS_SET, { log: { pollIntervalMs: 750 } })

    expect(characterPushes(h.sent)).toEqual([])
    expect(h.settingsNow().log.pollIntervalMs).toBe(750)
  })
})

// ---------------------------------------------------------------------------
// The password invariant
// ---------------------------------------------------------------------------

/** A Streamable account password, as the user would have typed it. */
const SECRET = 'correct horse battery staple'

/** Settings with Streamable configured and switched on. */
const CONFIGURED: DeepPartial<AppSettings> = {
  streamable: { enabled: true, email: 'exile@example.com', password: SECRET }
}

describe('secrets never travel main -> renderer', () => {
  it('blanks the Streamable password in settings:get while main keeps it', async () => {
    const h = makeHarness(CONFIGURED)

    // The renderer is a real web page in a public-source app; the account password is not
    // its business. What it gets is `''` - which deliberately says NOTHING about whether
    // one is stored (that is `credentials:status`).
    expect(await h.invoke(IPC_INVOKE.SETTINGS_GET)).toMatchObject({
      streamable: { email: 'exile@example.com', password: '' }
    })
    // Main still has the real one, or nothing could ever be uploaded.
    expect(h.settingsNow().streamable.password).toBe(SECRET)
  })

  it('blanks it in the settings:set reply too', async () => {
    const h = makeHarness(CONFIGURED)

    const reply = await h.invoke(IPC_INVOKE.SETTINGS_SET, { clips: { debounceMs: 1000 } })

    // The reply is a full AppSettings, so forgetting to redact HERE leaks the password on
    // every keystroke that saves - the busiest path in the whole app.
    expect(reply).toMatchObject({ streamable: { password: '' } })
  })

  it('reads an empty password in a patch as "no change", not as "clear it"', async () => {
    const h = makeHarness(CONFIGURED)

    // EXACTLY what the renderer sends: it holds a redacted blank and echoes its whole
    // settings object back on every edit. Treating `''` as a value would wipe the
    // credential every time the user touched an unrelated field.
    await h.invoke(IPC_INVOKE.SETTINGS_SET, {
      streamable: { enabled: true, email: 'exile@example.com', password: '', autoUpload: false }
    })

    expect(h.settingsNow().streamable.password).toBe(SECRET)
    // The rest of the patch still applied - "ignore the blank password" must not become
    // "ignore the section".
    expect(h.settingsNow().streamable.autoUpload).toBe(false)
  })

  it('stores a newly typed password without echoing it back', async () => {
    const h = makeHarness(CONFIGURED)

    const reply = await h.invoke(IPC_INVOKE.SETTINGS_SET, {
      streamable: { password: 'a different one' }
    })

    expect(h.settingsNow().streamable.password).toBe('a different one')
    expect(reply).toMatchObject({ streamable: { password: '' } })
  })

  it('leaves the OBS password alone, which is a deliberate asymmetry', async () => {
    const h = makeHarness({ obs: { password: 'obs-secret' } })

    // Not an oversight: an obs-websocket password controls a local OBS on 127.0.0.1, it
    // is frequently empty, and the settled config UI round-trips and displays it. The
    // Streamable one is an ACCOUNT credential with no revocable token. Pinning this stops
    // a future "redact everything" refactor from silently breaking the OBS form.
    expect(await h.invoke(IPC_INVOKE.SETTINGS_GET)).toMatchObject({
      obs: { password: 'obs-secret' }
    })
  })
})

// ---------------------------------------------------------------------------
// streamable:test
// ---------------------------------------------------------------------------

describe('streamable:test', () => {
  it('contacts nothing at all while uploading is switched off', async () => {
    const h = makeHarness({ streamable: { enabled: false, email: 'a@b.c', password: SECRET } })

    const result = await h.invoke(IPC_INVOKE.STREAMABLE_TEST, {
      email: 'a@b.c',
      password: 'typed'
    })

    // The master switch is a promise about network traffic, not a button state: a
    // compromised or buggy renderer must not be able to make this app talk to Streamable
    // when the user has said no.
    expect(h.streamableCalls).toEqual([])
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('substitutes the stored password when the renderer sends a blank', async () => {
    const h = makeHarness(CONFIGURED)

    // The everyday case: the window was reopened, so it holds a redacted `''`. Testing
    // that literal empty string would report "credentials rejected" about a password that
    // is perfectly good and send the user off to change it.
    await h.invoke(IPC_INVOKE.STREAMABLE_TEST, { email: '', password: '' })

    expect(h.streamableCalls).toEqual([{ email: 'exile@example.com', password: SECRET }])
  })

  it('prefers a freshly typed password over the stored one', async () => {
    const h = makeHarness(CONFIGURED)

    await h.invoke(IPC_INVOKE.STREAMABLE_TEST, { email: 'new@example.com', password: 'just typed' })

    expect(h.streamableCalls).toEqual([{ email: 'new@example.com', password: 'just typed' }])
  })

  it('answers locally when nothing is configured, without a round trip', async () => {
    const h = makeHarness({ streamable: { enabled: true } })

    const result = await h.invoke(IPC_INVOKE.STREAMABLE_TEST, { email: '', password: '' })

    expect(h.streamableCalls).toEqual([])
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('never puts the password in the failure message, even when the client throws', async () => {
    const h = makeHarness(CONFIGURED)
    // A thrown value is the one thing nobody has inspected, and an HTTP client's error can
    // carry a request dump - including an Authorization header.
    h.breakStreamable(new Error(`request failed: Basic ${SECRET}`))

    const result = await h.invoke(IPC_INVOKE.STREAMABLE_TEST, { email: '', password: '' })

    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('passes a genuine rejection straight through', async () => {
    const h = makeHarness(CONFIGURED)
    h.setStreamableResult({ ok: false, error: 'Streamable rejected those account details.' })

    expect(await h.invoke(IPC_INVOKE.STREAMABLE_TEST, { email: '', password: '' })).toEqual({
      ok: false,
      error: 'Streamable rejected those account details.'
    })
  })
})

// ---------------------------------------------------------------------------
// credentials:status
// ---------------------------------------------------------------------------

describe('credentials:status', () => {
  it('reports the store’s answer verbatim', async () => {
    const h = makeHarness()
    h.setCredentialStatus({
      obs: { status: 'ok', present: false },
      streamable: { status: 'undecryptable', present: false }
    })

    // `undecryptable` is the state the whole channel exists for: a password IS on disk,
    // this machine cannot read it, and the only fix is to type it again. Without it the
    // field just looks empty.
    expect(await h.invoke(IPC_INVOKE.CREDENTIALS_STATUS)).toEqual({
      obs: { status: 'ok', present: false },
      streamable: { status: 'undecryptable', present: false }
    })
  })

  it('degrades to "cannot vouch for it" rather than claiming everything is fine', async () => {
    const h = makeHarness()
    h.breakCredentials(new Error('store exploded'))

    // Not `ok`: that would leave a user believing uploads are configured when nothing has
    // been established. Not `undecryptable` either - that would tell them to retype a
    // password on the strength of an internal fault.
    expect(await h.invoke(IPC_INVOKE.CREDENTIALS_STATUS)).toEqual({
      obs: { status: 'unavailable', present: false },
      streamable: { status: 'unavailable', present: false }
    })
  })

  it('carries no secret, whatever the settings hold', async () => {
    const h = makeHarness(CONFIGURED)
    h.setCredentialStatus({
      obs: { status: 'ok', present: false },
      streamable: { status: 'ok', present: true }
    })

    const result = await h.invoke(IPC_INVOKE.CREDENTIALS_STATUS)

    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result).toMatchObject({ streamable: { present: true } })
  })
})

// ---------------------------------------------------------------------------
// push:clip-upload
// ---------------------------------------------------------------------------

/** Only the `push:clip-upload` payloads, in order. */
function uploadPushes(sent: readonly Sent[]): readonly unknown[] {
  return sent.filter((item) => item.channel === IPC_PUSH.CLIP_UPLOAD).map((item) => item.payload)
}

describe('push:clip-upload', () => {
  it('broadcasts every state change, addressed by clip id', () => {
    const h = makeHarness()
    h.emitClip(clipRecord('clip-1', { state: 'pending' }))

    h.emitUpload({ clipId: 'clip-1', upload: { state: 'uploading', percent: null } })
    h.emitUpload({
      clipId: 'clip-1',
      upload: { state: 'done', shortcode: 'abc123', url: 'https://streamable.com/abc123' }
    })

    expect(uploadPushes(h.sent)).toEqual([
      { clipId: 'clip-1', upload: { state: 'uploading', percent: null } },
      {
        clipId: 'clip-1',
        upload: { state: 'done', shortcode: 'abc123', url: 'https://streamable.com/abc123' }
      }
    ])
  })

  it('keeps clips:recent current, so a window opened later sees the finished upload', async () => {
    const h = makeHarness()
    h.emitClip(clipRecord('clip-1', { state: 'pending' }))
    h.emitUpload({
      clipId: 'clip-1',
      upload: { state: 'done', shortcode: 'abc123', url: 'https://streamable.com/abc123' }
    })

    // Main outlives every window. A buffer still holding the record as it was at save time
    // would answer `pending` forever, so a window opened after the upload finished would
    // show a feed of stalled uploads and no links.
    expect(await h.invoke(IPC_INVOKE.CLIPS_RECENT)).toEqual([
      clipRecord('clip-1', {
        state: 'done',
        shortcode: 'abc123',
        url: 'https://streamable.com/abc123'
      })
    ])
  })

  it('makes a failure as visible as a success', async () => {
    const h = makeHarness()
    h.emitClip(clipRecord('clip-1', { state: 'pending' }))
    h.emitUpload({ clipId: 'clip-1', upload: { state: 'failed', message: 'Network unreachable.' } })

    expect(uploadPushes(h.sent)).toEqual([
      { clipId: 'clip-1', upload: { state: 'failed', message: 'Network unreachable.' } }
    ])
    expect(await h.invoke(IPC_INVOKE.CLIPS_RECENT)).toEqual([
      clipRecord('clip-1', { state: 'failed', message: 'Network unreachable.' })
    ])
  })

  it('still pushes an update for a clip it has never seen', async () => {
    const h = makeHarness()

    // Normal, not an error: the clip may have aged out of the ring buffer, or been saved
    // before this registration existed. The renderer drops unknown ids by contract.
    h.emitUpload({ clipId: 'nobody', upload: { state: 'pending' } })

    expect(uploadPushes(h.sent)).toEqual([{ clipId: 'nobody', upload: { state: 'pending' } }])
    expect(await h.invoke(IPC_INVOKE.CLIPS_RECENT)).toEqual([])
  })

  it('stops broadcasting after teardown', () => {
    const h = makeHarness()
    h.emitClip(clipRecord('clip-1', { state: 'pending' }))
    h.dispose()

    // An upload in flight outlives the window it was being reported to; its next state
    // change must not reach a `webContents.send` for a window being destroyed.
    h.emitUpload({ clipId: 'clip-1', upload: { state: 'uploading', percent: null } })

    expect(uploadPushes(h.sent)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// settings:set -> the upload queue
// ---------------------------------------------------------------------------

describe('settings:set and the upload queue', () => {
  it('pokes the queue so a corrected password takes effect without a restart', async () => {
    const h = makeHarness(CONFIGURED)

    await h.invoke(IPC_INVOKE.SETTINGS_SET, { streamable: { password: 'fixed at last' } })

    // Nothing else tells the queue or the Streamable client that the store moved. Without
    // this poke the user would watch every upload fail with the old credential while the
    // window showed the new one.
    expect(h.uploadReconfigures()).toBe(1)
  })

  it('pokes it after any save, because a redacted patch is not diffable from here', async () => {
    const h = makeHarness(CONFIGURED)

    await h.invoke(IPC_INVOKE.SETTINGS_SET, { log: { pollIntervalMs: 750 } })

    // The queue compares and no-ops - the same contract the watcher has. A redundant poke
    // costs nothing next to an upload that quietly keeps using a stale credential.
    expect(h.uploadReconfigures()).toBe(1)
  })

  it('does not poke it when the save itself failed', async () => {
    const h = makeHarness(CONFIGURED)
    h.breakSettingsSave(new Error('EROFS: read-only file system'))

    const reply = await h.invoke(IPC_INVOKE.SETTINGS_SET, { streamable: { password: 'nope' } })

    // Nothing was written, so there is nothing for the queue to adopt - and telling it to
    // re-read would only make it re-read the value it already has. The renderer gets the
    // settings that are actually in effect (still redacted), so the user sees their edit
    // revert instead of believing it took hold.
    expect(h.uploadReconfigures()).toBe(0)
    expect(h.settingsNow().streamable.password).toBe(SECRET)
    expect(reply).toMatchObject({ streamable: { password: '' } })
  })
})
