/**
 * src/main/settings/store.ts
 * ==========================
 *
 * Durable, crash-safe persistence for {@link AppSettings}.
 *
 * MUST NOT IMPORT ELECTRON. Every OS-specific location this class needs is passed
 * in by `src/main/index.ts`:
 *
 * ```ts
 * const store = new SettingsStore({
 *   dir: app.getPath('userData'),
 *   defaultLibraryDir: join(app.getPath('videos'), 'poe-tool', 'clips')
 * })
 * store.load()
 * ```
 *
 * That injection is the whole point: the class is exercised under vitest against a
 * `mkdtemp` directory on macOS, with no electron in the process.
 *
 *
 * SECURITY NOTE - THE OBS PASSWORD IS STORED IN PLAINTEXT
 * -------------------------------------------------------
 * `settings.json` contains `obs.password` as clear text, readable by anything
 * running as the same user. This is a DELIBERATE, SCOPED decision, not an oversight:
 *
 *  - Electron's `safeStorage` (DPAPI on Windows) is the correct fix, but it is only
 *    available in the main process AFTER the `ready` event, and only from `electron`
 *    itself - which this file is forbidden to import. Wiring it would mean either
 *    breaking the no-electron rule here or injecting an encrypt/decrypt pair through
 *    the constructor and handling the "encrypted blob written on a machine whose
 *    DPAPI key has since changed" recovery path. That was explicitly ruled out of
 *    scope for this session.
 *  - The blast radius is small: an obs-websocket password grants control of a local
 *    OBS instance on `127.0.0.1`, not an account credential, and it is frequently
 *    empty (OBS auth disabled).
 *
 * The migration path when safeStorage is wired up: add an optional
 * `{ encrypt, decrypt }` pair to {@link SettingsStoreOptions}, write the password as
 * `obs.passwordEnc`, and treat a plaintext `obs.password` on load as a legacy value
 * to be re-encrypted on the next save. Until then: do not log settings objects, and
 * do not send `obs.password` anywhere it was not already going.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import {
  applySettingsPatch,
  validateSettings,
  type AppSettings,
  type DeepPartial
} from '../../shared/settings'

/** File name inside {@link SettingsStoreOptions.dir}. Hand-editable by design. */
export const SETTINGS_FILE_NAME = 'settings.json'

/** Everything the store needs from the host application. */
export interface SettingsStoreOptions {
  /**
   * Directory holding `settings.json`. Created on demand by {@link SettingsStore.save}.
   * In production this is `app.getPath('userData')`.
   */
  readonly dir: string
  /**
   * Absolute directory to substitute whenever the persisted `clips.libraryDir` is
   * blank.
   *
   * `src/shared/settings.ts` cannot compute this (no electron, no `node:*`), so
   * `DEFAULT_SETTINGS.clips.libraryDir` is `""` and resolving it is this class's job
   * - see {@link ClipSettings.libraryDir}. In production this is
   * `app.getPath('videos') + '/poe-tool/clips'`.
   *
   * May itself be `""`, in which case `clips.libraryDir` is left blank and the
   * clip library must treat it as unconfigured.
   */
  readonly defaultLibraryDir: string
}

/**
 * Loads, validates and atomically persists {@link AppSettings}.
 *
 * LIFECYCLE: the constructor performs NO I/O. A freshly constructed store reports
 * resolved defaults from {@link get}; call {@link load} once during bootstrap to
 * pull the on-disk values in.
 *
 * CHANGE NOTIFICATION is deliberately absent. The store is a dumb value holder;
 * `src/main/index.ts` owns the "settings changed -> restart the watcher / reconnect
 * OBS / push to the renderer" fan-out, because only it knows what is safe to restart.
 */
export class SettingsStore {
  readonly #dir: string
  readonly #defaultLibraryDir: string
  readonly #filePath: string
  /**
   * Scratch file for the write-then-rename dance.
   *
   * The pid is in the name so that two instances of the app (a packaged build and a
   * `npm run dev` build, say) cannot interleave writes into one shared temp file and
   * rename a half-written document over a good one. Each process now stages its own
   * complete copy and the rename picks a winner atomically.
   */
  readonly #tmpPath: string

  #current: AppSettings

  constructor(options: SettingsStoreOptions) {
    this.#dir = options.dir
    this.#defaultLibraryDir = options.defaultLibraryDir
    this.#filePath = join(options.dir, SETTINGS_FILE_NAME)
    this.#tmpPath = join(options.dir, `${SETTINGS_FILE_NAME}.${process.pid}.tmp`)
    this.#current = this.#resolve(undefined)
  }

  /** Absolute path of the settings file. Exposed for diagnostics and tests. */
  get filePath(): string {
    return this.#filePath
  }

  /**
   * Reads `settings.json` and returns a complete, validated {@link AppSettings},
   * which also becomes the value returned by {@link get}.
   *
   * NEVER THROWS AND NEVER WRITES. A missing file (first run), a file that is really
   * a directory, a permissions failure, a truncated write from a previous crash or a
   * hand-edit that broke the JSON all resolve to defaults. The app has to start:
   * a user who mangled their settings file needs a working settings UI to fix it in,
   * and a startup crash would deny them that.
   *
   * Not writing back the resolved defaults is equally deliberate - a read-only or
   * full disk must not turn a successful load into a failure, and silently
   * overwriting a file the user is mid-edit on would be hostile.
   */
  load(): AppSettings {
    this.#current = this.#resolve(this.#readFile())
    return this.#current
  }

  /** The current in-memory settings. Cheap; safe to call on any hot path. */
  get(): AppSettings {
    return this.#current
  }

  /**
   * Deep-merges `patch` over the current settings, validates and clamps the result,
   * persists it atomically, and returns the new complete settings.
   *
   * TRANSACTIONAL: the write happens BEFORE the in-memory value is replaced, so a
   * failed write leaves memory and disk agreeing on the old value and throws. The
   * alternative (apply in memory, swallow the write error) produces a session whose
   * behaviour silently disagrees with its own settings file - far harder to diagnose
   * than a surfaced error. Callers that must not fail - `settings:set` in
   * `src/main/ipc-handlers.ts` - should catch and report, since a rejected invoke
   * reaches the renderer as an opaque string.
   *
   * Patch semantics come from `applySettingsPatch`: absent and `undefined` fields
   * mean "no change", unknown keys are dropped, out-of-range numbers are clamped
   * rather than rejected. Setting `clips.libraryDir` to `""` resets it to
   * {@link SettingsStoreOptions.defaultLibraryDir}.
   */
  save(patch: DeepPartial<AppSettings>): AppSettings {
    const next = this.#resolve(applySettingsPatch(this.#current, patch))
    this.#writeAtomically(next)
    this.#current = next
    return next
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Returns the parsed contents of the settings file, or `undefined` when it cannot
   * be read or is not valid JSON. `undefined` flows into {@link validateSettings},
   * which turns it into the full default object.
   */
  #readFile(): unknown {
    let raw: string
    try {
      raw = readFileSync(this.#filePath, 'utf8')
    } catch {
      // ENOENT on first run; EISDIR/EACCES/EPERM if something is wrong with the
      // path. All of them mean the same thing here: no usable settings on disk.
      return undefined
    }

    // Notepad writes a UTF-8 BOM, and this file is documented as hand-editable on
    // Windows. JSON.parse rejects a leading U+FEFF, so stripping it is the
    // difference between "your settings survived an edit" and "your settings were
    // silently reset to defaults".
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

    try {
      // Typed as `unknown`, never `any`: validateSettings narrows every field.
      const parsed: unknown = JSON.parse(text)
      return parsed
    } catch {
      return undefined
    }
  }

  /**
   * Validates `input` and then substitutes {@link SettingsStoreOptions.defaultLibraryDir}
   * if the resulting `clips.libraryDir` is blank.
   *
   * Whitespace-only counts as blank: `validateSettings` deliberately does not trim
   * `libraryDir` (paths are allowed to be strange), so `"   "` would otherwise
   * survive as a real directory name and every clip move would fail.
   */
  #resolve(input: unknown): AppSettings {
    const validated = validateSettings(input)
    if (validated.clips.libraryDir.trim() !== '') return validated
    if (this.#defaultLibraryDir === '') return validated
    return {
      ...validated,
      clips: { ...validated.clips, libraryDir: this.#defaultLibraryDir }
    }
  }

  /**
   * Writes `settings` durably: stage into a temp file, flush it to the platter, then
   * `rename` it over the real file.
   *
   * `rename` within a directory is atomic on both NTFS and APFS, so a crash (or a
   * pulled power cord) at any instant leaves `settings.json` either fully old or
   * fully new - never the truncated half-document that a plain in-place
   * `writeFileSync` would leave behind. The `fsync` before the rename is what makes
   * that true across a power loss rather than merely across a process crash.
   *
   * The parent directory is NOT fsynced: it is not portable (fsync on a directory
   * handle fails on Windows) and losing the rename itself only costs the most recent
   * settings change.
   *
   * REMINDER: `settings.obs.password` goes to disk in clear text here. See the file
   * header for why, and for the migration path.
   */
  #writeAtomically(settings: AppSettings): void {
    // Trailing newline + 2-space indent: this file is documented as hand-editable,
    // so it should look like something a human wrote.
    const json = `${JSON.stringify(settings, null, 2)}\n`

    mkdirSync(this.#dir, { recursive: true })

    try {
      const fd = openSync(this.#tmpPath, 'w')
      try {
        writeFileSync(fd, json, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(this.#tmpPath, this.#filePath)
    } catch (error) {
      // Never leave a stray .tmp behind for the user to find and wonder about - and
      // never let cleanup failure mask the real error.
      try {
        unlinkSync(this.#tmpPath)
      } catch {
        // Already gone, or unlinkable for the same reason the write failed.
      }
      throw error
    }
  }
}
