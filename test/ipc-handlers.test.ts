/**
 * test/ipc-handlers.test.ts
 * =========================
 *
 * The character half of the wire protocol: `character:active`, `character:suggestions`,
 * the `push:character` broadcast, and the `refreshOverride()` poke that a settings write
 * owes the tracker.
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
 * The three ports that are NOT the subject (settings, obs, clipper, watcher) are stubs,
 * because dragging `SettingsStore` in would put a real disk write in the middle of an
 * assertion about a broadcast.
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
  IpcInvokeChannel,
  ObsConnectionState,
  ObsTestRequest,
  ObsTestResult
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

  const deps: IpcHandlerDeps = {
    settings: {
      get: () => settings,
      save: (patch) => {
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
      on: () => undefined,
      off: () => undefined
    },
    watcher: {
      status: { state: 'idle', path: null, since: T0 } satisfies WatcherStatus,
      reconfigure: () => undefined
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
