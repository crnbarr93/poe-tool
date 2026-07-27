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
 *
 * The same theme runs through the encryption tests at the bottom, one level sharper: a
 * password that cannot be decrypted must cost the user THAT PASSWORD and nothing else -
 * not the file, not the other settings, and never silently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SETTINGS_FILE_NAME, SettingsStore, type SettingsCrypto } from '../src/main/settings/store'
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

function makeStore(
  overrides: {
    dir?: string
    defaultLibraryDir?: string
    homeDir?: string
    crypto?: SettingsCrypto
  } = {}
): SettingsStore {
  return new SettingsStore({
    dir: overrides.dir ?? dir,
    defaultLibraryDir: overrides.defaultLibraryDir ?? LIBRARY_DIR,
    // Spread rather than pass `undefined`: both are optional properties and
    // `exactOptionalPropertyTypes` rejects an explicit undefined.
    ...(overrides.homeDir === undefined ? {} : { homeDir: overrides.homeDir }),
    ...(overrides.crypto === undefined ? {} : { crypto: overrides.crypto })
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

/**
 * `settings` as it is expected to look ON DISK when neither password is stored.
 *
 * The persisted document is deliberately NOT an `AppSettings`: the two `password` fields
 * are removed and replaced (when there is a secret to store) by a `passwordEnc`
 * ciphertext. Tests that assert "disk agrees with memory" have to compare against that
 * shape, or they are really just asserting that encryption has not been implemented.
 */
function withoutPasswords(settings: AppSettings): unknown {
  const { password: _obsPassword, ...obs } = settings.obs
  const { password: _streamablePassword, ...streamable } = settings.streamable
  return { ...settings, obs, streamable }
}

/** True for plain objects only - rejects `null` and arrays, both `typeof 'object'`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One section of the RAW on-disk document, for asserting on what was actually written
 * rather than on what the store says it holds. Narrowed rather than cast - the file is
 * untrusted input here exactly as it is in production.
 */
function persistedSection(name: 'obs' | 'streamable'): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readSettingsFile())
  const section: unknown = isRecord(parsed) ? parsed[name] : undefined
  if (!isRecord(section)) throw new Error(`settings.json has no ${name} section`)
  return section
}

// ---------------------------------------------------------------------------
// Fake ciphers
// ---------------------------------------------------------------------------

/**
 * The default fake "key". Ciphertext is prefixed with it so that a blob written by one
 * key is visibly, deterministically unreadable by another - which is the whole scenario
 * `'undecryptable'` exists for, and the one thing a fake cipher has to model honestly.
 */
const KEY_A = 'key-a:'

/** A second machine, or the same machine after Windows rotated its DPAPI key. */
const KEY_B = 'key-b:'

/**
 * A reversible stand-in for `safeStorage`: base64 behind a key marker.
 *
 * Base64 rather than plaintext because the assertions below check that a password does
 * not appear in the file's BYTES, and an "encryption" that left the secret legible would
 * pass a weaker test while proving nothing. Decrypting a blob written by a different key
 * THROWS, exactly as DPAPI does.
 */
function fakeCrypto(key: string = KEY_A): SettingsCrypto {
  return {
    available: true,
    encrypt: (plain: string): string => `${key}${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher: string): string => {
      if (!cipher.startsWith(key)) {
        throw new Error('the key used to encrypt this data is not available')
      }
      return Buffer.from(cipher.slice(key.length), 'base64').toString('utf8')
    }
  }
}

/**
 * `safeStorage.isEncryptionAvailable()` returned false: no keyring, no DPAPI, nothing to
 * protect a secret with. Both halves throw, because nothing should be calling them.
 */
function unavailableCrypto(): SettingsCrypto {
  return {
    available: false,
    encrypt: (): string => {
      throw new Error('encryption is not available on this machine')
    },
    decrypt: (): string => {
      throw new Error('encryption is not available on this machine')
    }
  }
}

/**
 * Claims to be available and then fails on write - a locked keyring, or a profile that
 * changed under a running session. The store must not answer that with plaintext.
 *
 * DECRYPT STILL WORKS, deliberately: that is what the failure actually looks like when it
 * arrives mid-session, and it is the difference between "we cannot store a NEW secret" and
 * "we have lost the old one". A fake that broke both halves would have made the
 * ciphertext-preservation tests below unwritable.
 */
function encryptFailsCrypto(key: string = KEY_A): SettingsCrypto {
  return {
    ...fakeCrypto(key),
    encrypt: (): string => {
      throw new Error('the keyring is locked')
    }
  }
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

    expect(parsed).toEqual(withoutPasswords(store.get()))
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

    expect(Object.keys(loaded).sort()).toEqual([
      'character',
      'clips',
      'log',
      'obs',
      'streamable'
    ])
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
    // Both stores share a cipher, because `obs.password` is part of the round trip and a
    // store with no cipher deliberately refuses to persist one at all - see the
    // encryption block at the bottom of this file.
    const first = makeStore({ crypto: fakeCrypto() })
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

    expect(makeStore({ crypto: fakeCrypto() }).load()).toEqual(saved)
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
    expect(JSON.parse(contents)).toEqual(withoutPasswords(store.get()))
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
      expect(parsed).toEqual(withoutPasswords(store.get()))
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

/**
 * A leading `~` is a SHELL convention, so node opens a directory literally named `~`
 * and reports ENOENT against a path the user is certain exists. This was hit for real
 * while running the app: pasting `~/Downloads/Client.txt` into the log path field gave
 * "ENOENT: no such file or directory, open '~/Downloads/Client.txt'".
 */
describe('home directory expansion', () => {
  const HOME = join('/', 'Users', 'someone')

  it('expands a leading ~/ in log.path', () => {
    const store = makeStore({ homeDir: HOME })
    const next = store.save({ log: { path: '~/Downloads/Client.txt' } })
    expect(next.log.path).toBe(join(HOME, 'Downloads', 'Client.txt'))
  })

  it('expands a leading ~/ in clips.libraryDir', () => {
    const store = makeStore({ homeDir: HOME })
    const next = store.save({ clips: { libraryDir: '~/Movies/clips' } })
    expect(next.clips.libraryDir).toBe(join(HOME, 'Movies', 'clips'))
  })

  it('expands a bare ~ to the home directory itself', () => {
    const store = makeStore({ homeDir: HOME })
    expect(store.save({ log: { path: '~' } }).log.path).toBe(HOME)
  })

  it('expands on load, not just on save', () => {
    writeFileSync(
      join(dir, SETTINGS_FILE_NAME),
      JSON.stringify({ log: { path: '~/Downloads/Client.txt' } }),
      'utf8'
    )
    expect(makeStore({ homeDir: HOME }).load().log.path).toBe(
      join(HOME, 'Downloads', 'Client.txt')
    )
  })

  it('leaves an absolute path untouched', () => {
    const absolute = join('/', 'Users', 'someone-else', 'Downloads', 'Client.txt')
    const store = makeStore({ homeDir: HOME })
    expect(store.save({ log: { path: absolute } }).log.path).toBe(absolute)
  })

  it('leaves a ~ that is not leading untouched', () => {
    // Windows 8.3 short names legitimately contain ~, e.g. C:\temp\file~1.txt.
    const windowsShortName = 'C:\\temp\\file~1.txt'
    const store = makeStore({ homeDir: HOME })
    expect(store.save({ log: { path: windowsShortName } }).log.path).toBe(windowsShortName)
  })

  it('leaves ~user verbatim rather than guessing', () => {
    // Resolving ~otheruser needs the passwd database; guessing would silently watch
    // the wrong file, so the error should name what was actually opened.
    const store = makeStore({ homeDir: HOME })
    expect(store.save({ log: { path: '~root/Client.txt' } }).log.path).toBe('~root/Client.txt')
  })

  it('leaves null log.path as null', () => {
    const store = makeStore({ homeDir: HOME })
    expect(store.save({ log: { path: null } }).log.path).toBeNull()
  })

  it('disables expansion when homeDir is empty', () => {
    const store = makeStore({ homeDir: '' })
    expect(store.save({ log: { path: '~/Downloads/Client.txt' } }).log.path).toBe(
      '~/Downloads/Client.txt'
    )
  })
})

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

/**
 * `obs.password` is a local obs-websocket credential; `streamable.password` is a real
 * ACCOUNT password, because Streamable has no revocable upload token. Neither may ever
 * reach the disk in the clear, and both take exactly the same path through the store, so
 * the tests below assert on both wherever the behaviour is shared.
 */
const OBS_PASSWORD = 'correct horse battery staple'
/** Trailing space on purpose: passwords are not trimmed, and encryption must not fix that. */
const STREAMABLE_PASSWORD = 'hunter2 '

describe('SettingsStore - passwords are encrypted at rest', () => {
  it('round-trips both passwords through the injected cipher', () => {
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()
    store.save({
      obs: { password: OBS_PASSWORD },
      streamable: { password: STREAMABLE_PASSWORD }
    })

    const reloaded = makeStore({ crypto: fakeCrypto() }).load()

    expect(reloaded.obs.password).toBe(OBS_PASSWORD)
    expect(reloaded.streamable.password).toBe(STREAMABLE_PASSWORD)
  })

  it('never writes a password into the file in the clear', () => {
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()
    store.save({
      obs: { password: OBS_PASSWORD },
      streamable: { password: STREAMABLE_PASSWORD }
    })

    // Asserted on the RAW TEXT, not on a parsed object: what is being prevented is a
    // secret sitting in a file that anything running as this user can open, and only the
    // bytes can prove it is not there.
    const raw = readSettingsFile()

    expect(raw).not.toContain(OBS_PASSWORD)
    expect(raw).not.toContain(STREAMABLE_PASSWORD)
    // The plaintext KEY is gone entirely, not present-and-empty - a `"password": ""`
    // would be a standing invitation to hand-edit a secret back in. The colon matters:
    // `"password"` on its own also matches `"passwordEnc"`.
    expect(raw).not.toContain('"password":')
    expect(raw).toContain('"passwordEnc":')
  })

  it('stores the two secrets separately, under passwordEnc', () => {
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()
    store.save({
      obs: { password: OBS_PASSWORD },
      streamable: { password: STREAMABLE_PASSWORD }
    })

    const obs = persistedSection('obs')
    const streamable = persistedSection('streamable')

    expect(typeof obs['passwordEnc']).toBe('string')
    expect(typeof streamable['passwordEnc']).toBe('string')
    expect(obs['passwordEnc']).not.toBe(streamable['passwordEnc'])
    expect('password' in obs).toBe(false)
    expect('password' in streamable).toBe(false)
    // The rest of each section is written exactly as before, in the clear.
    expect(obs['host']).toBe(DEFAULT_SETTINGS.obs.host)
    expect(obs['port']).toBe(DEFAULT_SETTINGS.obs.port)
  })

  it('writes no passwordEnc at all when there is no password to store', () => {
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()
    store.save({ obs: { port: 4460 } })

    expect('passwordEnc' in persistedSection('obs')).toBe(false)
    expect('passwordEnc' in persistedSection('streamable')).toBe(false)
    expect(readSettingsFile()).not.toContain('passwordEnc')
  })

  it('reports both slots as ok and present once they are stored', () => {
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()
    store.save({
      obs: { password: OBS_PASSWORD },
      streamable: { password: STREAMABLE_PASSWORD }
    })

    expect(store.credentials).toEqual({
      obs: { status: 'ok', present: true },
      streamable: { status: 'ok', present: true }
    })

    // And the same answer after a restart, which is the one that proves the ciphertext
    // was readable rather than merely written.
    const reloaded = makeStore({ crypto: fakeCrypto() })
    reloaded.load()
    expect(reloaded.credentials).toEqual({
      obs: { status: 'ok', present: true },
      streamable: { status: 'ok', present: true }
    })
  })

  it('reports ok-but-absent when nothing has ever been stored', () => {
    // "No password saved" is not a fault, so the status is still `ok`; `present` is what
    // distinguishes it. The renderer cannot tell from its own redacted copy.
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()

    expect(store.credentials).toEqual({
      obs: { status: 'ok', present: false },
      streamable: { status: 'ok', present: false }
    })
  })
})

describe('SettingsStore - migrating a pre-encryption settings.json', () => {
  it('honours a legacy plaintext password on load', () => {
    writeSettingsFile(
      JSON.stringify({
        obs: { host: '10.0.0.9', port: 4466, password: OBS_PASSWORD },
        streamable: { email: 'exile@example.com', password: STREAMABLE_PASSWORD }
      })
    )

    const loaded = makeStore({ crypto: fakeCrypto() }).load()

    // Losing it would silently break the user's OBS connection on upgrade, which is
    // exactly the "worked yesterday, no error anywhere" failure this project avoids.
    expect(loaded.obs.password).toBe(OBS_PASSWORD)
    expect(loaded.streamable.password).toBe(STREAMABLE_PASSWORD)
    expect(loaded.obs.host).toBe('10.0.0.9')
  })

  it('re-encrypts it and drops the plaintext key for good', () => {
    writeSettingsFile(JSON.stringify({ obs: { password: OBS_PASSWORD } }))
    const store = makeStore({ crypto: fakeCrypto() })
    store.load()

    // An unrelated save - the sort the character tracker performs on a level-up - must
    // also leave the file clean. (By this point `load` has already migrated; see the
    // block below, which is the guarantee that actually matters.)
    store.save({ character: { detected: 'Burgertrash' } })

    const raw = readSettingsFile()
    expect(raw).not.toContain(OBS_PASSWORD)
    expect(raw).not.toContain('"password":')
    expect(typeof persistedSection('obs')['passwordEnc']).toBe('string')
    // Still usable afterwards, which is the point of migrating rather than discarding.
    expect(makeStore({ crypto: fakeCrypto() }).load().obs.password).toBe(OBS_PASSWORD)
  })

  /**
   * THE MIGRATION HAS TO HAPPEN ON ITS OWN, and this is where that is pinned.
   *
   * "Re-encrypted by the next save" was the original design and it quietly meant "never":
   * `createServices` only calls `load()`, and the sole routine writer is a LEVEL-UP
   * persisting `character.detected` - which this codebase itself describes as sparse
   * enough that a level-98 character can play for weeks without producing one. A user who
   * upgraded, changed no setting and did not level up kept a clear-text account password
   * in `%APPDATA%` indefinitely, while `credentials:status` answered `'ok'` and the config
   * window told them it was encrypted.
   */
  describe('and the user then does nothing at all', () => {
    it('re-encrypts during load itself, without waiting for a save', () => {
      writeSettingsFile(
        JSON.stringify({
          obs: { host: '10.0.0.9', port: 4466, password: OBS_PASSWORD },
          streamable: { email: 'exile@example.com', password: STREAMABLE_PASSWORD }
        })
      )

      const store = makeStore({ crypto: fakeCrypto() })
      store.load()

      // Read back with NO further calls on the store: this is the state of the disk for a
      // user who launched the app and walked away.
      const raw = readSettingsFile()
      expect(raw).not.toContain(OBS_PASSWORD)
      expect(raw).not.toContain(STREAMABLE_PASSWORD)
      expect(raw).not.toContain('"password":')
      expect(typeof persistedSection('obs')['passwordEnc']).toBe('string')
      expect(typeof persistedSection('streamable')['passwordEnc']).toBe('string')
      // Nothing else was disturbed by the rewrite.
      expect(persistedSection('obs')['host']).toBe('10.0.0.9')
      expect(persistedSection('streamable')['email']).toBe('exile@example.com')
    })

    it('makes the ok it reports actually true', () => {
      writeSettingsFile(JSON.stringify({ streamable: { password: STREAMABLE_PASSWORD } }))
      const store = makeStore({ crypto: fakeCrypto() })
      store.load()

      // The UI renders `ok` + `present` as "saved and encrypted with this PC's own
      // encryption". Before the migration was forced, that sentence was a lie for exactly
      // as long as the user avoided a settings change.
      expect(store.credentials.streamable).toEqual({ status: 'ok', present: true })
      expect(readSettingsFile()).not.toContain(STREAMABLE_PASSWORD)
    })

    it('leaves the file completely alone when there is nothing to migrate', () => {
      // No unnecessary writes: a file with no legacy key must not be rewritten just
      // because it was read. Byte-for-byte, including the hand-written formatting.
      const original = `${JSON.stringify({ obs: { host: '10.0.0.9' } }, null, 4)}\n`
      writeSettingsFile(original)

      makeStore({ crypto: fakeCrypto() }).load()

      expect(readSettingsFile()).toBe(original)
    })

    it('does not delete the plaintext when there is no cipher to replace it with', () => {
      // The one case that costs the user something is deliberately NOT made worse. With no
      // keyring there is nothing to migrate TO, so rewriting the file would drop the
      // password immediately and hand back nothing. It is honoured for the session and
      // left where it was; `unavailable` is what warns them.
      const original = `${JSON.stringify({ obs: { password: OBS_PASSWORD } })}\n`
      writeSettingsFile(original)

      const store = makeStore({ crypto: unavailableCrypto() })

      expect(store.load().obs.password).toBe(OBS_PASSWORD)
      expect(readSettingsFile()).toBe(original)
      expect(store.credentials.obs).toEqual({ status: 'unavailable', present: true })
    })

    it('still loads when the migrating write cannot happen', () => {
      // A read-only or full disk must not turn a successful load into a throw - `load` is
      // documented as never throwing and the whole app is downstream of it.
      const blocked = join(dir, 'blocked')
      writeFileSync(blocked, 'a file where the settings directory should be', 'utf8')
      const store = makeStore({ dir: blocked, crypto: fakeCrypto() })

      expect(() => store.load()).not.toThrow()
      // Nothing was read either (the path is not a directory), so this is just the
      // defaults - the point is purely that it came back at all.
      expect(store.get()).toEqual(resolvedDefaults())
    })

    it('does not rewrite the file on a blank legacy password', () => {
      // `""` is not a secret, so there is nothing to migrate and no reason to touch a file
      // the user may be mid-edit on.
      const original = `${JSON.stringify({ obs: { password: '' } })}\n`
      writeSettingsFile(original)

      const store = makeStore({ crypto: fakeCrypto() })
      store.load()

      expect(readSettingsFile()).toBe(original)
      expect(store.credentials.obs).toEqual({ status: 'ok', present: false })
    })
  })

  it('prefers an encrypted blob over a stale plaintext sibling', () => {
    // The store never writes both; this is a hand-edit or a half-merged file. The field
    // the store maintains wins, so the outcome does not depend on which stale value
    // happens to look more plausible.
    writeSettingsFile(
      JSON.stringify({
        obs: {
          password: 'stale plaintext',
          passwordEnc: fakeCrypto().encrypt(OBS_PASSWORD)
        }
      })
    )

    expect(makeStore({ crypto: fakeCrypto() }).load().obs.password).toBe(OBS_PASSWORD)
  })
})

describe('SettingsStore - a password this machine cannot decrypt', () => {
  /** Writes a settings file whose passwords were encrypted with {@link KEY_A}. */
  function writeSettingsEncryptedWithKeyA(): void {
    const store = makeStore({ crypto: fakeCrypto(KEY_A) })
    store.load()
    store.save({
      log: { path: 'C:\\PoE\\logs\\Client.txt', pollIntervalMs: 250 },
      character: { override: 'FyascoWorbinTime' },
      obs: { host: '10.0.0.9', port: 4466, password: OBS_PASSWORD },
      clips: { libraryDir: 'E:\\Clips', debounceMs: 1500 },
      streamable: { enabled: true, email: 'exile@example.com', password: STREAMABLE_PASSWORD }
    })
  }

  it('does not throw, and keeps every other setting', () => {
    writeSettingsEncryptedWithKeyA()

    const store = makeStore({ crypto: fakeCrypto(KEY_B) })
    expect(() => store.load()).not.toThrow()

    const loaded = store.get()
    // THE POINT OF THE WHOLE RECOVERY PATH: a password that cannot be read costs the
    // user that password and nothing else. Not the file, not the log path, not the
    // library directory they configured six months ago.
    expect(loaded.log.path).toBe('C:\\PoE\\logs\\Client.txt')
    expect(loaded.log.pollIntervalMs).toBe(250)
    expect(loaded.character.override).toBe('FyascoWorbinTime')
    expect(loaded.obs.host).toBe('10.0.0.9')
    expect(loaded.obs.port).toBe(4466)
    expect(loaded.clips.libraryDir).toBe('E:\\Clips')
    expect(loaded.clips.debounceMs).toBe(1500)
    expect(loaded.streamable.enabled).toBe(true)
    expect(loaded.streamable.email).toBe('exile@example.com')
  })

  it('degrades to an empty password and says why', () => {
    writeSettingsEncryptedWithKeyA()

    const store = makeStore({ crypto: fakeCrypto(KEY_B) })
    store.load()

    expect(store.get().obs.password).toBe('')
    expect(store.get().streamable.password).toBe('')
    // `undecryptable`, NOT a silent `ok` + absent: "no password saved" and "your password
    // is on disk and unreadable here" need different sentences in front of the user, and
    // only one of them tells them what to do about it.
    expect(store.credentials).toEqual({
      obs: { status: 'undecryptable', present: false },
      streamable: { status: 'undecryptable', present: false }
    })
  })

  it('keeps saying so after an unrelated save', () => {
    writeSettingsEncryptedWithKeyA()
    const store = makeStore({ crypto: fakeCrypto(KEY_B) })
    store.load()

    store.save({ character: { detected: 'Burgertrash' } })

    expect(store.credentials.obs.status).toBe('undecryptable')
    expect(store.credentials.streamable.status).toBe('undecryptable')
  })

  it('does not destroy the blob it could not read', () => {
    // The scenario: settings.json synced between a desktop and a laptop. The laptop
    // cannot read the password, and a background save there (a level-up persisting
    // `character.detected`) must not delete the copy that still works on the desktop.
    writeSettingsEncryptedWithKeyA()

    const laptop = makeStore({ crypto: fakeCrypto(KEY_B) })
    laptop.load()
    laptop.save({ character: { detected: 'Burgertrash' } })

    const desktop = makeStore({ crypto: fakeCrypto(KEY_A) }).load()

    expect(desktop.obs.password).toBe(OBS_PASSWORD)
    expect(desktop.streamable.password).toBe(STREAMABLE_PASSWORD)
    expect(desktop.character.detected).toBe('Burgertrash')
  })

  it('is repaired by re-typing the password', () => {
    writeSettingsEncryptedWithKeyA()
    const store = makeStore({ crypto: fakeCrypto(KEY_B) })
    store.load()

    store.save({ obs: { password: 'a new password' } })

    expect(store.credentials.obs).toEqual({ status: 'ok', present: true })
    expect(makeStore({ crypto: fakeCrypto(KEY_B) }).load().obs.password).toBe('a new password')
    // Untouched slots keep reporting the truth about themselves.
    expect(store.credentials.streamable.status).toBe('undecryptable')
  })

  it('reports undecryptable for a blob that is not even the right shape', () => {
    // A hand-edit, a truncated sync, a base64 string from somewhere else entirely.
    writeSettingsFile(JSON.stringify({ obs: { passwordEnc: 'not ciphertext at all' } }))

    const store = makeStore({ crypto: fakeCrypto() })

    expect(() => store.load()).not.toThrow()
    expect(store.get().obs.password).toBe('')
    expect(store.credentials.obs.status).toBe('undecryptable')
  })

  it('ignores a blank passwordEnc rather than calling it undecryptable', () => {
    // Nothing is stored, so nothing failed. Saying "your password could not be
    // decrypted" here would send the user hunting for a password they never had.
    writeSettingsFile(JSON.stringify({ obs: { passwordEnc: '' } }))

    const store = makeStore({ crypto: fakeCrypto() })
    store.load()

    expect(store.credentials.obs).toEqual({ status: 'ok', present: false })
  })
})

describe('SettingsStore - when the OS cannot encrypt', () => {
  it('persists nothing rather than falling back to plaintext', () => {
    const store = makeStore({ crypto: unavailableCrypto() })
    store.load()
    store.save({
      obs: { password: OBS_PASSWORD },
      streamable: { password: STREAMABLE_PASSWORD }
    })

    const raw = readSettingsFile()

    expect(raw).not.toContain(OBS_PASSWORD)
    expect(raw).not.toContain(STREAMABLE_PASSWORD)
    expect(raw).not.toContain('passwordEnc')
    expect(raw).not.toContain('"password":')
  })

  it('keeps the password usable for the rest of the session', () => {
    // Refusing to persist must not mean refusing to work: the user typed a password and
    // OBS should connect with it right now. It is the NEXT LAUNCH that loses it, and
    // `unavailable` is what warns them.
    const store = makeStore({ crypto: unavailableCrypto() })
    store.load()
    const saved = store.save({ obs: { password: OBS_PASSWORD } })

    expect(saved.obs.password).toBe(OBS_PASSWORD)
    expect(store.get().obs.password).toBe(OBS_PASSWORD)
    expect(store.credentials.obs).toEqual({ status: 'unavailable', present: true })
    // ...and everything that is not a secret still persists normally.
    expect(persistedSection('obs')['host']).toBe(DEFAULT_SETTINGS.obs.host)
  })

  it('comes back empty on the next launch, still reporting unavailable', () => {
    const first = makeStore({ crypto: unavailableCrypto() })
    first.load()
    first.save({ obs: { password: OBS_PASSWORD } })

    const second = makeStore({ crypto: unavailableCrypto() })

    expect(second.load().obs.password).toBe('')
    expect(second.credentials.obs).toEqual({ status: 'unavailable', present: false })
  })

  it('treats an absent cipher exactly like an unavailable one', () => {
    // Failing CLOSED. The other reading of "no cipher injected" - write it in the clear -
    // would turn a wiring mistake in src/main/index.ts into a plaintext account password
    // on disk, silently, in an app whose repository is public.
    const store = makeStore()
    store.load()
    store.save({ obs: { password: OBS_PASSWORD } })

    expect(readSettingsFile()).not.toContain(OBS_PASSWORD)
    expect(store.credentials.obs).toEqual({ status: 'unavailable', present: true })
    expect(makeStore().load().obs.password).toBe('')
  })

  it('does not fall back to plaintext when encrypt throws mid-session', () => {
    const store = makeStore({ crypto: encryptFailsCrypto() })
    store.load()

    // The save itself must still succeed - the other settings in the patch are not the
    // cipher's business, and throwing here would surface as "your settings could not be
    // saved" for a password the user may not even have touched.
    expect(() => store.save({ obs: { password: OBS_PASSWORD, port: 4470 } })).not.toThrow()

    expect(readSettingsFile()).not.toContain(OBS_PASSWORD)
    expect(persistedSection('obs')['port']).toBe(4470)
    expect(store.credentials.obs).toEqual({ status: 'unavailable', present: true })
  })

  /**
   * THE CASE THE TEST ABOVE CANNOT REACH, and the bug it hid.
   *
   * That one starts from an EMPTY settings file, so there is no ciphertext for a failing
   * `encrypt` to destroy and "nothing was written" looks like the right answer. Start from
   * a file that already HOLDS a working password - which is every session after the first -
   * and the same code path deleted it: the store only remembered blobs it had FAILED to
   * decrypt, so after a successful load it had no memory of the ciphertext it had just
   * read, and a save with a broken keyring wrote the document out without it.
   *
   * Nothing the user does is needed to trigger it. `CharacterTracker.persist` saves on the
   * next level-up.
   */
  describe('and the password on disk was already good', () => {
    /** Stores both passwords with a healthy cipher, the way a previous session would. */
    function seedWorkingPasswords(): void {
      const healthy = makeStore({ crypto: fakeCrypto() })
      healthy.load()
      healthy.save({
        obs: { password: OBS_PASSWORD },
        streamable: { email: 'exile@example.com', password: STREAMABLE_PASSWORD }
      })
    }

    it('keeps the working ciphertext when encrypt breaks mid-session', () => {
      seedWorkingPasswords()
      const blobBefore = persistedSection('obs')['passwordEnc']

      // Session two: decrypt still works (so both passwords load), encrypt does not.
      const store = makeStore({ crypto: encryptFailsCrypto() })
      expect(store.load().obs.password).toBe(OBS_PASSWORD)

      // An UNRELATED background save - a level-up persisting the detected character.
      store.save({ character: { detected: 'Burgertrash' } })

      // The blob is still there, byte for byte. Writing the same bytes back stores exactly
      // what the caller asked for, and needs no cipher to do it.
      expect(persistedSection('obs')['passwordEnc']).toBe(blobBefore)
      expect(readSettingsFile()).not.toContain(OBS_PASSWORD)
      expect(readSettingsFile()).not.toContain(STREAMABLE_PASSWORD)

      // ...and the next launch, with a working keyring again, still has both passwords.
      const third = makeStore({ crypto: fakeCrypto() }).load()
      expect(third.obs.password).toBe(OBS_PASSWORD)
      expect(third.streamable.password).toBe(STREAMABLE_PASSWORD)
      expect(third.character.detected).toBe('Burgertrash')
    })

    it('still reports unavailable, because a NEW password could not be stored', () => {
      seedWorkingPasswords()
      const store = makeStore({ crypto: encryptFailsCrypto() })
      store.load()
      store.save({ character: { detected: 'Burgertrash' } })

      // Not `ok`: the honest warning is still owed, because anything the user types from
      // here on will not survive the restart. Preserving what already worked is a separate
      // question from advertising that encryption is healthy.
      expect(store.credentials).toEqual({
        obs: { status: 'unavailable', present: true },
        streamable: { status: 'unavailable', present: true }
      })
    })

    it('does NOT keep the old blob when the user actually changed the password', () => {
      // The other half of the rule. Silently restoring the password they just replaced
      // would be worse than an empty field, because on the next launch it looks like it
      // worked - and it would log them in with the credential they were rotating away from.
      seedWorkingPasswords()
      const store = makeStore({ crypto: encryptFailsCrypto() })
      store.load()

      store.save({ obs: { password: 'a different password' } })

      expect('passwordEnc' in persistedSection('obs')).toBe(false)
      expect(readSettingsFile()).not.toContain('a different password')
      expect(store.credentials.obs).toEqual({ status: 'unavailable', present: true })
      // The untouched slot keeps its blob: only the changed one lost anything.
      expect(typeof persistedSection('streamable')['passwordEnc']).toBe('string')
      expect(makeStore({ crypto: fakeCrypto() }).load().streamable.password).toBe(
        STREAMABLE_PASSWORD
      )
    })

    it('honours clearing a password even though encrypt is broken', () => {
      // An empty password is a real instruction, not an absence of one, and it must
      // actually remove the secret from the file rather than resurrect the old blob.
      seedWorkingPasswords()
      const store = makeStore({ crypto: encryptFailsCrypto() })
      store.load()

      store.save({ obs: { password: '' } })

      expect('passwordEnc' in persistedSection('obs')).toBe(false)
      expect(makeStore({ crypto: fakeCrypto() }).load().obs.password).toBe('')
    })

    it('survives a whole session of saves without eroding the stored secret', () => {
      // The realistic shape of the failure: not one save, but dozens over an evening.
      seedWorkingPasswords()
      const store = makeStore({ crypto: encryptFailsCrypto() })
      store.load()

      for (let level = 90; level < 96; level++) {
        store.save({ character: { detected: 'Burgertrash', detectedLevel: level } })
      }

      const reloaded = makeStore({ crypto: fakeCrypto() }).load()
      expect(reloaded.obs.password).toBe(OBS_PASSWORD)
      expect(reloaded.streamable.password).toBe(STREAMABLE_PASSWORD)
      expect(reloaded.character.detectedLevel).toBe(95)
    })
  })

  it('honours a legacy plaintext password but does not write it back', () => {
    // The one case where this policy costs the user something, pinned deliberately: an
    // upgrade on a machine with no keyring keeps the password working for this session
    // and then lets it go, rather than re-writing a clear-text credential under a build
    // that advertises encryption at rest. `unavailable` is what warns them.
    writeSettingsFile(JSON.stringify({ obs: { password: OBS_PASSWORD } }))
    const store = makeStore({ crypto: unavailableCrypto() })

    expect(store.load().obs.password).toBe(OBS_PASSWORD)
    expect(store.credentials.obs).toEqual({ status: 'unavailable', present: true })

    store.save({ obs: { port: 4470 } })

    expect(readSettingsFile()).not.toContain(OBS_PASSWORD)
    expect(makeStore({ crypto: unavailableCrypto() }).load().obs.password).toBe('')
  })

  it('preserves an existing blob it has no cipher to read', () => {
    const encrypted = makeStore({ crypto: fakeCrypto() })
    encrypted.load()
    encrypted.save({ obs: { password: OBS_PASSWORD } })

    // Same file, opened by a build/machine with no working safeStorage. It must not
    // quietly strip the ciphertext on the next write.
    const blind = makeStore({ crypto: unavailableCrypto() })
    blind.load()
    blind.save({ obs: { port: 4470 } })

    expect(blind.credentials.obs).toEqual({ status: 'unavailable', present: false })
    expect(makeStore({ crypto: fakeCrypto() }).load().obs.password).toBe(OBS_PASSWORD)
  })
})
