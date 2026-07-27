/**
 * test/settings-store.test.ts
 * ===========================
 *
 * Every test gets its own `mkdtemp` directory, so nothing here touches a real
 * userData folder and the cases can run in any order.
 *
 * The theme running through the load tests: a settings file the user has broken by
 * hand - or that a crash truncated - must degrade to defaults, never to an exception.
 * A settings store that throws on startup takes the whole app with it, including the
 * settings UI the user would need to repair the damage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SETTINGS_FILE_NAME, SettingsStore } from '../src/main/settings/store'
import {
  DEBOUNCE_MS_MAX,
  DEBOUNCE_MS_MIN,
  DEFAULT_SETTINGS,
  POLL_INTERVAL_MS_MAX,
  POLL_INTERVAL_MS_MIN,
  PORT_MAX,
  PORT_MIN,
  type AppSettings,
  type DeepPartial
} from '../src/shared/settings'

/** Stand-in for `app.getPath('videos') + '/poe-tool/clips'`. */
const LIBRARY_DIR = '/tmp/poe-tool-test-videos/poe-tool/clips'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poe-tool-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeStore(overrides: { dir?: string; defaultLibraryDir?: string } = {}): SettingsStore {
  return new SettingsStore({
    dir: overrides.dir ?? dir,
    defaultLibraryDir: overrides.defaultLibraryDir ?? LIBRARY_DIR
  })
}

/** `DEFAULT_SETTINGS` with the library directory the store is expected to substitute. */
function resolvedDefaults(libraryDir: string = LIBRARY_DIR): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    clips: { ...DEFAULT_SETTINGS.clips, libraryDir }
  }
}

function writeSettingsFile(contents: string): void {
  writeFileSync(join(dir, SETTINGS_FILE_NAME), contents, 'utf8')
}

function readSettingsFile(): string {
  return readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')
}

// ---------------------------------------------------------------------------

describe('SettingsStore.load - degradation to defaults', () => {
  it('yields defaults when the file does not exist', () => {
    const store = makeStore()

    expect(store.load()).toEqual(resolvedDefaults())
  })

  it('does not create the file merely by loading', () => {
    makeStore().load()

    expect(readdirSync(dir)).toEqual([])
  })

  it('yields defaults for corrupt JSON without throwing', () => {
    writeSettingsFile('{ "log": { "path": "C:\\\\Client.txt"  <-- truncated by a crash')
    const store = makeStore()

    expect(() => store.load()).not.toThrow()
    expect(store.load()).toEqual(resolvedDefaults())
  })

  it('yields defaults for an empty file', () => {
    writeSettingsFile('')

    expect(makeStore().load()).toEqual(resolvedDefaults())
  })

  it('yields defaults for JSON that is not an object', () => {
    for (const contents of ['null', '"hello"', '[1, 2, 3]', '42', 'true']) {
      writeSettingsFile(contents)
      expect(makeStore().load()).toEqual(resolvedDefaults())
    }
  })

  it('yields defaults when the settings path is unreadable', () => {
    // A directory where the file should be: readFileSync raises EISDIR. Simulates any
    // read failure (permissions, a locked file) portably, without needing chmod.
    mkdirSync(join(dir, SETTINGS_FILE_NAME))
    const store = makeStore()

    expect(() => store.load()).not.toThrow()
    expect(store.load()).toEqual(resolvedDefaults())
  })

  it('yields defaults when the settings directory does not exist', () => {
    const store = makeStore({ dir: join(dir, 'never', 'created') })

    expect(store.load()).toEqual(resolvedDefaults())
  })

  it('survives a UTF-8 BOM, which Notepad adds to any file it saves', () => {
    writeSettingsFile(`\uFEFF${JSON.stringify({ character: { override: 'Notepadded' } })}`)

    expect(makeStore().load().character.override).toBe('Notepadded')
  })
})

describe('SettingsStore.load - the pre-0.2 character.name migration', () => {
  // `validateSettings` carries a non-empty legacy `character.name` into
  // `character.override`. Losing it would make `isSelf` false everywhere and stop death
  // clipping with no error anywhere, so the contract is pinned here rather than left to
  // the reader of settings.ts.
  it('migrates a legacy character.name into character.override', () => {
    writeSettingsFile(JSON.stringify({ character: { name: 'Exile' } }))

    const loaded = makeStore().load()

    expect(loaded.character.override).toBe('Exile')
    expect('name' in loaded.character).toBe(false)
  })

  it('lets an explicit override win over the stale legacy key', () => {
    writeSettingsFile(JSON.stringify({ character: { name: 'Stale', override: 'Current' } }))

    expect(makeStore().load().character.override).toBe('Current')
  })

  it('drops the legacy key on the next write, so it cannot come back', () => {
    writeSettingsFile(JSON.stringify({ character: { name: 'Exile' } }))
    const store = makeStore()
    store.load()
    store.save({})

    const parsed: unknown = JSON.parse(readSettingsFile())

    expect(parsed).toEqual(store.get())
    expect(JSON.stringify(parsed)).not.toContain('"name"')
  })
})

describe('SettingsStore.load - merging', () => {
  it('merges a partial file over the defaults', () => {
    writeSettingsFile(
      JSON.stringify({
        log: { path: 'C:\\Games\\PoE\\logs\\Client.txt' },
        character: { override: 'FyascoWorbinTime' }
      })
    )

    expect(makeStore().load()).toEqual({
      ...resolvedDefaults(),
      log: { path: 'C:\\Games\\PoE\\logs\\Client.txt', pollIntervalMs: 500 },
      // The three `detected*` siblings must survive an override-only file untouched.
      character: {
        override: 'FyascoWorbinTime',
        detected: null,
        detectedClass: null,
        detectedLevel: null
      }
    })
  })

  it('ignores unknown extra keys at every level', () => {
    writeSettingsFile(
      JSON.stringify({
        log: { path: 'C:\\Client.txt', legacyTailMode: 'aggressive' },
        obs: { port: 4455, sceneName: 'Main' },
        telemetry: { enabled: true },
        version: 3
      })
    )

    const loaded = makeStore().load()

    expect(Object.keys(loaded).sort()).toEqual(['character', 'clips', 'log', 'obs'])
    expect(Object.keys(loaded.log).sort()).toEqual(['path', 'pollIntervalMs'])
    expect('sceneName' in loaded.obs).toBe(false)
    expect(loaded.log.path).toBe('C:\\Client.txt')
  })

  it('falls back per-field when a value has the wrong type', () => {
    writeSettingsFile(
      JSON.stringify({
        log: { path: 12345, pollIntervalMs: 'not a number' },
        character: { override: { first: 'Bob' }, detected: 42, detectedLevel: 'ninety' },
        obs: { autoConnect: 'false' },
        clips: { enabled: null }
      })
    )

    const loaded = makeStore().load()

    expect(loaded.log.path).toBe(DEFAULT_SETTINGS.log.path)
    expect(loaded.log.pollIntervalMs).toBe(DEFAULT_SETTINGS.log.pollIntervalMs)
    expect(loaded.character.override).toBe('')
    // A junk detection degrades to "never detected" rather than to a name no death can
    // ever match.
    expect(loaded.character.detected).toBeNull()
    expect(loaded.character.detectedLevel).toBeNull()
    // "false" as a string is a legitimate hand-edit and is honoured.
    expect(loaded.obs.autoConnect).toBe(false)
    expect(loaded.clips.enabled).toBe(DEFAULT_SETTINGS.clips.enabled)
  })

  it('normalises a blank log path to null rather than the empty string', () => {
    writeSettingsFile(JSON.stringify({ log: { path: '   ' } }))

    expect(makeStore().load().log.path).toBeNull()
  })
})

describe('SettingsStore.load - clamping', () => {
  it('clamps an out-of-range pollIntervalMs', () => {
    writeSettingsFile(JSON.stringify({ log: { pollIntervalMs: 1 } }))
    expect(makeStore().load().log.pollIntervalMs).toBe(POLL_INTERVAL_MS_MIN)

    writeSettingsFile(JSON.stringify({ log: { pollIntervalMs: 900_000 } }))
    expect(makeStore().load().log.pollIntervalMs).toBe(POLL_INTERVAL_MS_MAX)
  })

  it('clamps an out-of-range OBS port', () => {
    writeSettingsFile(JSON.stringify({ obs: { port: 0 } }))
    expect(makeStore().load().obs.port).toBe(PORT_MIN)

    writeSettingsFile(JSON.stringify({ obs: { port: 70_000 } }))
    expect(makeStore().load().obs.port).toBe(PORT_MAX)
  })

  it('clamps an out-of-range debounceMs', () => {
    writeSettingsFile(JSON.stringify({ clips: { debounceMs: -1000 } }))
    expect(makeStore().load().clips.debounceMs).toBe(DEBOUNCE_MS_MIN)

    writeSettingsFile(JSON.stringify({ clips: { debounceMs: 10 * 60_000 } }))
    expect(makeStore().load().clips.debounceMs).toBe(DEBOUNCE_MS_MAX)
  })

  it('restores the default (not a clamp bound) for a non-finite number', () => {
    // JSON has no NaN/Infinity literal, so this is what a hand-edit or a bad
    // serialiser actually produces.
    writeSettingsFile('{ "log": { "pollIntervalMs": 1e999 } }')

    expect(makeStore().load().log.pollIntervalMs).toBe(DEFAULT_SETTINGS.log.pollIntervalMs)
  })

  it('clamps on save as well as on load', () => {
    const store = makeStore()
    store.load()

    const saved = store.save({ log: { pollIntervalMs: 5 }, obs: { port: 99_999 } })

    expect(saved.log.pollIntervalMs).toBe(POLL_INTERVAL_MS_MIN)
    expect(saved.obs.port).toBe(PORT_MAX)
    expect(makeStore().load().log.pollIntervalMs).toBe(POLL_INTERVAL_MS_MIN)
  })
})

describe('SettingsStore - clips.libraryDir resolution', () => {
  it('substitutes the injected default when the file has no libraryDir', () => {
    expect(makeStore().load().clips.libraryDir).toBe(LIBRARY_DIR)
  })

  it('keeps an explicitly configured libraryDir', () => {
    writeSettingsFile(JSON.stringify({ clips: { libraryDir: 'D:\\Clips' } }))

    expect(makeStore().load().clips.libraryDir).toBe('D:\\Clips')
  })

  it('treats a whitespace-only libraryDir as unset', () => {
    writeSettingsFile(JSON.stringify({ clips: { libraryDir: '   ' } }))

    expect(makeStore().load().clips.libraryDir).toBe(LIBRARY_DIR)
  })

  it('leaves libraryDir blank when no default was injected either', () => {
    expect(makeStore({ defaultLibraryDir: '' }).load().clips.libraryDir).toBe('')
  })

  it('re-substitutes the default when the user clears the field', () => {
    const store = makeStore()
    store.load()
    store.save({ clips: { libraryDir: 'D:\\Clips' } })

    expect(store.save({ clips: { libraryDir: '' } }).clips.libraryDir).toBe(LIBRARY_DIR)
  })
})

describe('SettingsStore.get', () => {
  it('returns resolved defaults before load has been called', () => {
    expect(makeStore().get()).toEqual(resolvedDefaults())
  })

  it('reflects the last load', () => {
    writeSettingsFile(JSON.stringify({ character: { override: 'Exile' } }))
    const store = makeStore()
    store.load()

    expect(store.get().character.override).toBe('Exile')
  })

  it('reflects the last save', () => {
    const store = makeStore()
    store.load()
    store.save({ obs: { port: 4460 } })

    expect(store.get().obs.port).toBe(4460)
  })

  it('performs no I/O - it still works after the directory is deleted', () => {
    const store = makeStore()
    store.load()
    rmSync(dir, { recursive: true, force: true })

    expect(store.get()).toEqual(resolvedDefaults())
  })
})

describe('SettingsStore.save', () => {
  it('round-trips through a second store on the same directory', () => {
    const first = makeStore()
    first.load()
    const saved = first.save({
      log: { path: 'C:\\PoE\\logs\\Client.txt', pollIntervalMs: 250 },
      character: {
        override: 'FyascoWorbinTime',
        detected: 'LargeThumbThomasReturns',
        detectedClass: 'Berserker',
        detectedLevel: 92
      },
      obs: { host: '192.168.1.50', port: 4466, password: 'hunter2', autoConnect: false },
      clips: { enabled: false, libraryDir: 'E:\\Clips', debounceMs: 1500, writeSidecar: false }
    })

    expect(makeStore().load()).toEqual(saved)
  })

  it('merges over the current settings, not over the defaults', () => {
    writeSettingsFile(JSON.stringify({ character: { override: 'Exile' } }))
    const store = makeStore()
    store.load()

    const saved = store.save({ obs: { port: 4460 } })

    expect(saved.character.override).toBe('Exile')
    expect(saved.obs.port).toBe(4460)
    expect(saved.obs.host).toBe(DEFAULT_SETTINGS.obs.host)
  })

  it('accumulates across successive calls', () => {
    const store = makeStore()
    store.load()
    store.save({ character: { override: 'Exile' } })
    store.save({ log: { pollIntervalMs: 200 } })

    const reloaded = makeStore().load()

    expect(reloaded.character.override).toBe('Exile')
    expect(reloaded.log.pollIntervalMs).toBe(200)
  })

  it('leaves siblings untouched when only one field of a section is patched', () => {
    const store = makeStore()
    store.load()
    store.save({ obs: { host: '10.0.0.2', port: 4470, password: 'p', autoConnect: false } })

    const saved = store.save({ obs: { port: 4480 } })

    expect(saved.obs).toEqual({
      host: '10.0.0.2',
      port: 4480,
      password: 'p',
      autoConnect: false
    })
  })

  it('treats an explicitly undefined field as "no change"', () => {
    const store = makeStore()
    store.load()
    store.save({ character: { override: 'Exile' } })

    expect(store.save({ character: { override: undefined } }).character.override).toBe('Exile')
  })

  it('distinguishes an undefined detection from an explicitly cleared one', () => {
    // `null` is a real value for `detected` ("never detected"), not the absence of one.
    // Collapsing the two would make clearing a detection impossible - or, worse, make a
    // patch that names only `override` silently wipe the persisted detection that the
    // sparse-level-up design depends on.
    const store = makeStore()
    store.load()
    store.save({ character: { detected: 'Burgertrash', detectedClass: 'Slayer', detectedLevel: 84 } })

    expect(store.save({ character: { override: 'OneLongToe' } }).character.detected).toBe(
      'Burgertrash'
    )
    expect(store.save({ character: { detected: null } }).character.detected).toBeNull()
  })

  it('returns the unchanged settings for an empty patch', () => {
    const store = makeStore()
    const before = store.load()

    expect(store.save({})).toEqual(before)
  })

  it('drops unknown keys instead of persisting them', () => {
    const store = makeStore()
    store.load()
    // The cast is confined to this test: it exercises what happens when a malformed
    // patch arrives over IPC from an older renderer build, which the type system
    // cannot prevent at runtime.
    const rogue = { obs: { port: 4455, sceneName: 'Main' } } as DeepPartial<AppSettings>
    store.save(rogue)

    expect(readSettingsFile()).not.toContain('sceneName')
  })

  it('creates the settings directory on demand', () => {
    const nested = join(dir, 'userData', 'poe-tool')
    const store = makeStore({ dir: nested })
    store.load()
    store.save({ character: { override: 'Exile' } })

    expect(readFileSync(join(nested, SETTINGS_FILE_NAME), 'utf8')).toContain('Exile')
  })

  it('writes human-editable JSON', () => {
    const store = makeStore()
    store.load()
    store.save({ character: { override: 'Exile' } })

    const contents = readSettingsFile()

    expect(contents.endsWith('\n')).toBe(true)
    expect(contents).toContain('\n  "log": {')
    expect(JSON.parse(contents)).toEqual(store.get())
  })

  it('stores the OBS password in plaintext (known limitation, pinned deliberately)', () => {
    // Documents the current behaviour so that wiring safeStorage later is a visible,
    // intentional change to this expectation rather than a silent one. See the
    // security note in src/main/settings/store.ts.
    const store = makeStore()
    store.load()
    store.save({ obs: { password: 'correct horse battery staple' } })

    expect(readSettingsFile()).toContain('correct horse battery staple')
  })
})

describe('SettingsStore.save - atomicity', () => {
  it('leaves no .tmp file behind after a successful write', () => {
    const store = makeStore()
    store.load()
    store.save({ character: { override: 'Exile' } })
    store.save({ obs: { port: 4460 } })

    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME])
  })

  it('never leaves a partially written settings.json readable', () => {
    // The rename is what guarantees this; the assertion is that the file on disk is
    // always complete and parseable after every save.
    const store = makeStore()
    store.load()

    for (let i = 0; i < 5; i++) {
      store.save({ obs: { port: 4455 + i } })
      const parsed: unknown = JSON.parse(readSettingsFile())
      expect(parsed).toEqual(store.get())
    }
  })

  it('overwrites an existing settings file rather than failing on the rename', () => {
    writeSettingsFile(JSON.stringify({ character: { override: 'Old' } }))
    const store = makeStore()
    store.load()
    store.save({ character: { override: 'New' } })

    expect(makeStore().load().character.override).toBe('New')
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME])
  })

  it('throws and leaves the in-memory settings untouched when the write fails', () => {
    // A regular file where the settings DIRECTORY should be: mkdirSync raises EEXIST.
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not a directory', 'utf8')

    const store = makeStore({ dir: blocked })
    const before = store.load()

    expect(() => store.save({ character: { override: 'Exile' } })).toThrow()
    // Transactional: memory still agrees with disk, so the session cannot silently
    // diverge from the settings file.
    expect(store.get()).toEqual(before)
    expect(readdirSync(dir)).toEqual(['blocked'])
  })
})
