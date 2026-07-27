/**
 * src/main/settings/store.ts
 * ==========================
 *
 * Durable, crash-safe persistence for {@link AppSettings}, with both passwords
 * ENCRYPTED AT REST.
 *
 * MUST NOT IMPORT ELECTRON. Every OS-specific capability this class needs is passed in
 * by `src/main/index.ts`:
 *
 * ```ts
 * const store = new SettingsStore({
 *   dir: app.getPath('userData'),
 *   defaultLibraryDir: join(app.getPath('videos'), 'poe-tool', 'clips'),
 *   crypto: makeSettingsCrypto() // wraps electron's safeStorage
 * })
 * store.load()
 * ```
 *
 * That injection is the whole point: the class is exercised under vitest against a
 * `mkdtemp` directory on macOS, with a FAKE cipher, and no electron in the process.
 *
 *
 * SECURITY - THE ON-DISK DOCUMENT IS DELIBERATELY NOT `AppSettings`
 * -----------------------------------------------------------------
 * `settings.json` never contains a plaintext password. `obs.password` and
 * `streamable.password` are written as base64 ciphertext under DIFFERENT keys -
 * `obs.passwordEnc` and `streamable.passwordEnc` (see {@link ENCRYPTED_PASSWORD_KEY}) -
 * and decrypted back into the in-memory {@link AppSettings} on load. The persisted
 * document therefore does NOT match the type this class returns, and this class is the
 * ONLY thing that knows that: `validateSettings` is handed plaintext on the way in and
 * never sees the way out.
 *
 * The cipher itself is Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS).
 * It lives in `electron` - which this file is forbidden to import - and is only usable
 * after the `ready` event, so it arrives as an injected {@link SettingsCrypto} pair,
 * exactly like `dir` and `defaultLibraryDir` do.
 *
 * THE ONE RULE THAT MATTERS: A PASSWORD IS ENCRYPTED OR IT IS NOT WRITTEN.
 * There is no plaintext fallback anywhere below - not when no cipher was injected, not
 * when the OS says encryption is unavailable, not when `encrypt` throws. A password we
 * cannot protect is kept in memory for the session and dropped on exit, and the UI is
 * told why through {@link SettingsStore.credentials}. Silently writing a clear-text
 * account password into a file in `%APPDATA%` because the happy path failed is exactly
 * the outcome this design exists to prevent.
 *
 *
 * WHAT CAN GO WRONG, AND WHAT EACH FAILURE LOOKS LIKE
 * ---------------------------------------------------
 * Decryption fails for reasons that are nobody's fault and are not corruption: the
 * settings file was copied from another machine or another Windows profile, or the
 * DPAPI key behind it was rotated. Every one of these is REPORTED, never thrown, and
 * NEVER costs the user the rest of their settings:
 *
 *  - `'ok'`            - the cipher is available and whatever was stored was read back.
 *                        Also the answer when nothing is stored; `present` tells those
 *                        apart. See `CredentialSlotStatus` in `../../shared/ipc`.
 *  - `'undecryptable'` - a blob IS on disk and could not be decrypted. The password
 *                        comes back as `''` and the UI must say "your saved password
 *                        could not be decrypted on this machine - please re-enter it".
 *                        Without this state the field just looks empty and the user is
 *                        left to work out for themselves why uploads stopped.
 *  - `'unavailable'`   - no usable cipher on this machine (or none injected). Passwords
 *                        typed this session work, but are not persisted at all.
 *
 * A blob we could not read is RETAINED and written back out untouched by later saves.
 * That is not paranoia: `settings.json` is a small hand-editable file that people sync
 * between machines, and a background save (a level-up persisting `character.detected`,
 * say) that quietly destroyed the only copy of the ciphertext would lose the password on
 * the machine where it still worked. Failing to read it does not entitle us to delete it.
 *
 * THE SAME RULE APPLIES TO A BLOB WE *COULD* READ, and it is the less obvious half.
 * `safeStorage` can go from working to throwing inside one session - a locked keyring, a
 * profile change - and the next background save then has a password in memory it cannot
 * encrypt. Writing nothing there would DELETE the perfectly good ciphertext that this
 * session decrypted at startup, for a password that has not changed. So the blob each
 * slot was READ FROM is remembered next to the plaintext it produced ({@link SlotState}),
 * and an `encrypt` failure writes that exact blob back out byte-for-byte whenever the
 * password still matches it. Only a password the user actually CHANGED, and which we then
 * could not encrypt, loses its stored copy - because keeping the old one would silently
 * log them in with the password they just replaced.
 *
 *
 * MIGRATION FROM THE PRE-ENCRYPTION BUILD
 * ---------------------------------------
 * Earlier builds wrote `obs.password` as clear text. A legacy plaintext value is READ
 * and HONOURED (see {@link LEGACY_PLAINTEXT_PASSWORD_KEY}), and then RE-ENCRYPTED
 * IMMEDIATELY, BY {@link SettingsStore.load} ITSELF - one save that rebuilds the document
 * from scratch and so drops the legacy key for good.
 *
 * That save is the only write `load` ever performs, and it is deliberate rather than
 * incidental. Deferring it to "the next save" was the original design and it was wrong:
 * nothing in bootstrap saves, and the only routine writer is a level-up persisting
 * `character.detected` - which this codebase itself describes as sparse enough that a
 * level-98 character can play for weeks without producing one. A clear-text account
 * password would therefore have sat in `%APPDATA%` indefinitely while `credentials:status`
 * answered `'ok'` and the UI told the user it was encrypted. The migration now happens
 * before `load` returns, so that `'ok'` is true when it is said.
 *
 * THE ONE CASE THAT COSTS SOMETHING, stated plainly because it is a real behaviour
 * change: upgrading on a machine with NO usable cipher reads that legacy plaintext,
 * honours it for the session, and then omits it from the next write - so it is gone on
 * the following launch. The alternative is re-writing a clear-text account password to
 * disk under a build that advertises encryption at rest, which is not a trade this app
 * is willing to make. The user is told: that slot reports `'unavailable'`.
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
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  CredentialSlotStatus,
  CredentialStatus,
  CredentialsStatusResult
} from '../../shared/ipc'
import {
  applySettingsPatch,
  validateSettings,
  type AppSettings,
  type CharacterSettings,
  type ClipSettings,
  type DeepPartial,
  type LogSettings
} from '../../shared/settings'

/** File name inside {@link SettingsStoreOptions.dir}. Hand-editable by design. */
export const SETTINGS_FILE_NAME = 'settings.json'

/**
 * On-disk key holding the base64 CIPHERTEXT of a password.
 *
 * Deliberately a different name from the in-memory `password` field, so that the two
 * can never be confused by a reader, a hand-edit, or a future `JSON.stringify(settings)`
 * that forgets this class exists: a key called `passwordEnc` holding readable text would
 * be obviously wrong, whereas a key called `password` holding ciphertext would not.
 */
const ENCRYPTED_PASSWORD_KEY = 'passwordEnc'

/**
 * The PRE-ENCRYPTION key: a clear-text password sitting in an existing `settings.json`.
 *
 * READ ONLY, and never written back - {@link SettingsStore.save} rebuilds the document
 * from scratch, so the first save after an upgrade re-encrypts the value and drops this
 * key permanently. Named rather than inlined so the migration is greppable, mirroring
 * `LEGACY_CHARACTER_NAME_KEY` in `../../shared/settings`.
 *
 * THIS IS THE MIGRATION CONTRACT A TEST SHOULD PIN: a settings.json carrying
 * `obs.password: "hunter2"` must load with that password in memory, and the very next
 * save must leave `hunter2` nowhere in the file's bytes.
 */
const LEGACY_PLAINTEXT_PASSWORD_KEY = 'password'

/**
 * Expands a leading `~` to `homeDir`.
 *
 * Nothing in node does this: `~` is a SHELL convention, so `fs.open('~/x')` looks for
 * a directory literally named `~` and fails with a baffling ENOENT that names a path
 * the user believes exists. People paste `~/...` into the path field anyway, so the
 * app expands it rather than blaming them.
 *
 * Only a LEADING `~` followed by a separator (or the whole string) is expanded, so a
 * legitimate path containing `~` elsewhere - `C:\temp\file~1.txt`, a Windows 8.3
 * short name - is untouched. `~user` (another shell form) is NOT supported: resolving
 * it needs the passwd database, and getting it wrong would silently watch the wrong
 * file. It is left verbatim so the resulting error names what was actually opened.
 *
 * Windows paths never start with `~`, so this is a no-op there.
 */
export function expandHomePath(value: string, homeDir: string): string {
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) return value
  if (homeDir === '') return value
  const rest = value.slice(1)
  if (rest === '') return homeDir
  return join(homeDir, rest.slice(1))
}

/**
 * The encrypt/decrypt pair the store persists passwords through.
 *
 * In production this wraps `safeStorage.encryptString` / `decryptString` (base64 in and
 * out) and `safeStorage.isEncryptionAvailable()`; `src/main/index.ts` builds it after
 * `app.whenReady()`, because safeStorage is not usable before that.
 *
 * BOTH FUNCTIONS ARE ALLOWED - EXPECTED - TO THROW, and the store classifies the two
 * throws differently, so neither may be swallowed by the implementation:
 *  - `decrypt` throwing means "this blob was not written by this machine/profile" and
 *    becomes `'undecryptable'`. An implementation that caught it and returned `''`
 *    would turn a password the user can fix into a field that merely looks empty.
 *  - `encrypt` throwing means "we cannot protect this secret" and becomes
 *    `'unavailable'`. The password is then NOT persisted; it is never written in clear.
 */
export interface SettingsCrypto {
  /** Plaintext -> opaque, storable string (base64). May throw. */
  readonly encrypt: (plain: string) => string
  /** The inverse of {@link encrypt}. THROWS when the blob is not ours to read. */
  readonly decrypt: (cipher: string) => string
  /**
   * Whether the OS will give us encryption at all right now.
   *
   * `false` (or an absent pair) means passwords are held for the session and NOT
   * written - see the "one rule that matters" in this file's header.
   */
  readonly available: boolean
}

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
  /**
   * Home directory used to expand a leading `~` in `log.path` and `clips.libraryDir`.
   *
   * Injected so tests can assert expansion without depending on the machine they run
   * on. Defaults to `os.homedir()`. Pass `""` to disable expansion entirely.
   */
  readonly homeDir?: string
  /**
   * How passwords are encrypted at rest. Injected because the real one is electron's
   * `safeStorage` and this file may not import electron.
   *
   * OPTIONAL, AND ABSENT MEANS "NO ENCRYPTION", WHICH MEANS "NO PERSISTENCE" - it is
   * treated exactly like `available: false`. Failing closed is the only safe default:
   * the alternative reading, "no pair injected, so write it in the clear", would turn a
   * wiring mistake in `src/main/index.ts` into a plaintext account password on disk,
   * silently, in a public-repo app. Everything else in the settings file still persists
   * normally.
   */
  readonly crypto?: SettingsCrypto
}

/** The two secrets this store encrypts, named by the settings section they live in. */
type CredentialSlot = 'obs' | 'streamable'

/**
 * A ciphertext that IS on disk (or was just written there) together with the plaintext it
 * corresponds to.
 *
 * The pair is what makes it safe to reuse: writing `cipher` back out is only correct while
 * the password being stored is still `plain`, and comparing the two is the whole check.
 */
interface ReadableBlob {
  /** The base64 blob, exactly as it appears in `settings.json`. */
  readonly cipher: string
  /** The password it decrypts to. */
  readonly plain: string
}

/** What the store remembers about one secret between load and save. */
interface SlotState {
  /** Why the stored password is or is not usable. Reported by {@link SettingsStore.credentials}. */
  readonly status: CredentialStatus
  /**
   * Ciphertext that is on disk and that we could NOT turn back into a password, kept so
   * later saves can write it out again untouched.
   *
   * Null whenever there is no UNREADABLE blob to preserve - a blob we decrypted
   * successfully is remembered in {@link readable} instead. See the retention paragraphs
   * in this file's header for why destroying either of them would be the wrong call.
   */
  readonly retained: string | null
  /**
   * Ciphertext that is on disk and that we CAN read, plus what it reads back as.
   *
   * The insurance policy against `encrypt` failing mid-session: with this, an unchanged
   * password can be persisted by writing the SAME BYTES OUT AGAIN, no cipher required.
   * Without it, a locked keyring during a background save silently erased a working
   * credential - see the header.
   *
   * Populated from a successful `decrypt` on load, and from a successful `encrypt` on
   * save (the blob we just wrote is by definition the blob that is now on disk, and the
   * cipher pair is documented as each other's inverse). Null when nothing is stored, when
   * the stored blob could not be decrypted, or when there is no cipher at all.
   *
   * NEVER NON-NULL AT THE SAME TIME AS {@link retained}. There is one `passwordEnc` key
   * per slot, so the blob on disk is either one we can read or one we cannot; the two
   * fields are the two halves of that single fact, split because they are preserved for
   * different reasons.
   */
  readonly readable: ReadableBlob | null
  /**
   * True when this slot's password came from the PRE-ENCRYPTION plaintext key and is
   * therefore still sitting in the clear in `settings.json`.
   *
   * Read by {@link SettingsStore.load}, which re-encrypts on the spot rather than hoping
   * some unrelated write comes along. Always false after a save: by then the document has
   * been rebuilt and the legacy key is gone.
   */
  readonly migrated: boolean
}

/** The `obs` section AS PERSISTED: no `password`, an optional ciphertext instead. */
interface PersistedObsSection {
  readonly host: string
  readonly port: number
  readonly autoConnect: boolean
  readonly passwordEnc?: string
}

/** The `streamable` section AS PERSISTED. Same substitution as {@link PersistedObsSection}. */
interface PersistedStreamableSection {
  readonly enabled: boolean
  readonly email: string
  readonly autoUpload: boolean
  readonly maxFileBytes: number
  readonly passwordEnc?: string
}

/**
 * The document that actually reaches `settings.json`.
 *
 * Spelled out as a type rather than produced by deleting keys off an {@link AppSettings},
 * so that adding a secret to the settings shape without deciding how it is persisted is
 * a compile error here rather than a password quietly written in the clear.
 */
interface PersistedSettings {
  readonly log: LogSettings
  readonly character: CharacterSettings
  readonly obs: PersistedObsSection
  readonly clips: ClipSettings
  readonly streamable: PersistedStreamableSection
}

/** True for plain objects only - rejects `null` and arrays, both of which are `typeof 'object'`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `key` off an unknown value, yielding `undefined` when it is not a record. */
function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

/**
 * A non-empty string, or null.
 *
 * Blank is folded into "absent" on purpose: an empty `passwordEnc` is not a secret, and
 * an empty legacy `password` is not one either, so neither should be mistaken for one.
 */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return value
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
  readonly #homeDir: string
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
  /**
   * The injected cipher, or undefined when none was supplied.
   * See {@link SettingsStoreOptions.crypto}.
   */
  readonly #crypto: SettingsCrypto | undefined

  #current: AppSettings
  /** Per-secret bookkeeping, replaced wholesale by {@link load} and {@link save}. */
  #slots: Record<CredentialSlot, SlotState>

  constructor(options: SettingsStoreOptions) {
    this.#dir = options.dir
    this.#defaultLibraryDir = options.defaultLibraryDir
    this.#homeDir = options.homeDir ?? homedir()
    this.#filePath = join(options.dir, SETTINGS_FILE_NAME)
    this.#tmpPath = join(options.dir, `${SETTINGS_FILE_NAME}.${process.pid}.tmp`)
    this.#crypto = options.crypto
    // Nothing has been read yet, so nothing has failed to decrypt yet: the honest
    // starting answer is whether this machine can encrypt at all.
    const initial: SlotState = {
      status: this.#baseStatus(),
      retained: null,
      readable: null,
      migrated: false
    }
    this.#slots = { obs: initial, streamable: initial }
    this.#current = this.#resolve(undefined)
  }

  /** Absolute path of the settings file. Exposed for diagnostics and tests. */
  get filePath(): string {
    return this.#filePath
  }

  /**
   * Whether each stored secret is present and usable, and if not, why.
   *
   * CARRIES NO SECRET, only facts about one - it is the payload of the
   * `credentials:status` IPC channel, which exists precisely because the renderer holds
   * a redacted `''` and cannot otherwise tell "no password saved" from "a password is
   * saved" or from "a password is saved and this machine cannot read it".
   *
   * `present` is about the IN-MEMORY value, so a password typed this session reads as
   * present even when {@link SettingsCrypto.available} is false and it will not survive
   * the restart.
   */
  get credentials(): CredentialsStatusResult {
    return {
      obs: this.#slotStatus('obs', this.#current.obs.password),
      streamable: this.#slotStatus('streamable', this.#current.streamable.password)
    }
  }

  /**
   * Reads `settings.json` and returns a complete, validated {@link AppSettings},
   * which also becomes the value returned by {@link get}.
   *
   * NEVER THROWS. A missing file (first run), a file that is really a directory, a
   * permissions failure, a truncated write from a previous crash, a hand-edit that broke
   * the JSON, or a password blob this machine cannot decrypt all resolve to something
   * usable. The app has to start: a user who mangled their settings file needs a working
   * settings UI to fix it in, and a startup crash would deny them that.
   *
   * A FAILED DECRYPT IS NOT A CORRUPT FILE. Only that one password degrades to `''`;
   * every other setting loads exactly as it was written, and {@link credentials} reports
   * `'undecryptable'` so the UI can ask for it again by name.
   *
   * IT WRITES IN EXACTLY ONE CASE, AND NOT ONE MORE: a clear-text password from a
   * pre-encryption build was found and this machine can encrypt, in which case the file is
   * rewritten immediately to get the secret out of the clear - see
   * {@link #migrateLegacyPlaintext} and the migration section of this file's header. It is
   * not a write-back of resolved defaults, which stays firmly off the table: a read-only
   * or full disk must not turn a successful load into a failure, and silently rewriting a
   * file the user is mid-edit on would be hostile. That is also why the migration write is
   * swallowed rather than propagated.
   */
  load(): AppSettings {
    this.#current = this.#resolve(this.#decryptInto(this.#readFile()))
    this.#migrateLegacyPlaintext()
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
   *
   * BOTH PASSWORDS ARE RE-ENCRYPTED HERE, every time, from whatever is in memory - which
   * is what migrates a legacy plaintext value and what repairs a slot the user has just
   * re-typed. A password that cannot be encrypted is omitted from the document rather
   * than written in the clear; see the header.
   */
  save(patch: DeepPartial<AppSettings>): AppSettings {
    const next = this.#resolve(applySettingsPatch(this.#current, patch))
    const persisted = this.#toPersisted(next)

    this.#writeAtomically(persisted.json)

    // Committed together, and only after the write succeeded, so memory, disk and the
    // reported credential status can never disagree about what was stored.
    this.#current = next
    this.#slots = persisted.slots
    return next
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Whether a usable cipher was injected. The gate on every encrypt/decrypt below. */
  #usableCrypto(): SettingsCrypto | null {
    const crypto = this.#crypto
    if (crypto === undefined || !crypto.available) return null
    return crypto
  }

  /** The status of a slot that has neither failed nor succeeded at anything yet. */
  #baseStatus(): CredentialStatus {
    return this.#usableCrypto() === null ? 'unavailable' : 'ok'
  }

  #slotStatus(slot: CredentialSlot, password: string): CredentialSlotStatus {
    return { status: this.#slots[slot].status, present: password !== '' }
  }

  /**
   * Re-encrypts a password that {@link #readSlot} just recovered from the PRE-ENCRYPTION
   * plaintext key, immediately, by performing one ordinary empty-patch save.
   *
   * WHY IT IS DONE HERE AND NOT LEFT TO "THE NEXT SAVE". There may not be a next save.
   * `createServices` in `src/main/index.ts` only calls {@link load}, and the one routine
   * writer is `CharacterTracker.persist`, which fires on a LEVEL-UP - sparse enough that a
   * level-98 character can play for weeks without producing one. Left to chance, a
   * clear-text account password sits in `%APPDATA%\poe-tool\settings.json` for that entire
   * time while {@link credentials} reports `'ok'` and the config window tells the user it
   * is encrypted. The status has to be true when it is said.
   *
   * NOTHING HAPPENS WITHOUT A USABLE CIPHER. Saving then would DELETE the plaintext
   * (the one rule that matters: encrypted or not written) and hand the user nothing in
   * exchange - the password would be gone on the next launch instead of merely
   * unprotected. On a machine with no keyring the value is honoured for the session and
   * left exactly where it was found; `'unavailable'` is what warns them.
   *
   * NEVER THROWS. A read-only or full disk leaves the plaintext where it is and the app
   * starts normally, which is the same trade every other failure on this path makes.
   */
  #migrateLegacyPlaintext(): void {
    if (!this.#slots.obs.migrated && !this.#slots.streamable.migrated) return
    if (this.#usableCrypto() === null) return

    try {
      // The empty patch is the point: `save` rebuilds the document from scratch, which
      // encrypts both passwords from memory and drops the legacy key for good. No
      // separate migration path can therefore drift from the ordinary write path.
      this.save({})
    } catch {
      // Deliberately silent. `load` is documented as never throwing, and a settings
      // directory that cannot be written is not a reason to refuse to start.
    }
  }

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
   * Turns the RAW on-disk document into something `validateSettings` can read: every
   * `passwordEnc` blob replaced by the plaintext it decrypts to, under the in-memory
   * `password` key.
   *
   * Also RECORDS what happened to each secret ({@link SlotState}), which is the only
   * place that information exists - by the time validation is done, a failed decrypt and
   * an empty password look identical, and telling them apart is the whole point of
   * `credentials:status`.
   *
   * TOTAL: `raw` may be anything JSON can express, including `null`, an array or a
   * number. Anything that is not an object is passed straight through for
   * `validateSettings` to turn into defaults.
   */
  #decryptInto(raw: unknown): unknown {
    const obs = this.#readSlot(raw, 'obs')
    const streamable = this.#readSlot(raw, 'streamable')
    this.#slots = { obs: obs.state, streamable: streamable.state }

    if (!isRecord(raw)) return raw

    const obsSection = raw['obs']
    const streamableSection = raw['streamable']

    return {
      ...raw,
      obs: {
        ...(isRecord(obsSection) ? obsSection : {}),
        [LEGACY_PLAINTEXT_PASSWORD_KEY]: obs.password
      },
      streamable: {
        ...(isRecord(streamableSection) ? streamableSection : {}),
        [LEGACY_PLAINTEXT_PASSWORD_KEY]: streamable.password
      }
    }
  }

  /**
   * Recovers one password from the raw document.
   *
   * NEVER THROWS. Every outcome is one of the {@link CredentialStatus} cases spelled out
   * in this file's header, and every one of them yields a usable password or an empty
   * one - never an exception, because the rest of the settings file must load either way.
   *
   * PRECEDENCE: an encrypted blob WINS over a legacy plaintext sibling. The two only
   * ever coexist through a hand-edit or a half-merged file (this class writes the
   * plaintext key never), and preferring the field this class actually maintains keeps
   * the outcome predictable instead of depending on which stale value looks nicer.
   */
  #readSlot(raw: unknown, slot: CredentialSlot): { password: string; state: SlotState } {
    const section = field(raw, slot)
    const cipher = nonEmptyString(field(section, ENCRYPTED_PASSWORD_KEY))

    if (cipher === null) {
      // Nothing encrypted here: either nothing was ever stored, or this is a
      // pre-encryption settings.json whose plaintext we honour and re-encrypt - which
      // `load` then does at once, rather than waiting for a save that may never come.
      // See LEGACY_PLAINTEXT_PASSWORD_KEY and #migrateLegacyPlaintext.
      const legacy = nonEmptyString(field(section, LEGACY_PLAINTEXT_PASSWORD_KEY))
      return {
        password: legacy ?? '',
        state: {
          status: this.#baseStatus(),
          retained: null,
          readable: null,
          migrated: legacy !== null
        }
      }
    }

    const crypto = this.#usableCrypto()
    if (crypto === null) {
      // A blob and no cipher to open it with. Retained rather than discarded - it is
      // still the user's only copy of a password that works on some other machine.
      return {
        password: '',
        state: { status: 'unavailable', retained: cipher, readable: null, migrated: false }
      }
    }

    try {
      const plain = crypto.decrypt(cipher)
      // REMEMBER THE BLOB, NOT ONLY THE PLAINTEXT. This is what a later `encrypt`
      // failure writes back out, instead of erasing a credential that works.
      return {
        password: plain,
        state: { status: 'ok', retained: null, readable: { cipher, plain }, migrated: false }
      }
    } catch {
      // The expected failure: a different machine, a different Windows profile, or a
      // rotated DPAPI key. Not corruption, not an error the user caused, and absolutely
      // not a reason to lose the other 20 settings in this file.
      return {
        password: '',
        state: { status: 'undecryptable', retained: cipher, readable: null, migrated: false }
      }
    }
  }

  /**
   * Serialises `settings` into the document that goes to disk, encrypting both
   * passwords, and returns the {@link SlotState}s that become current if (and only if)
   * the write succeeds.
   *
   * PURE with respect to this instance: it reads `#slots` but does not touch it, so a
   * failed write leaves the reported credential status describing what is actually
   * stored rather than what we hoped to store.
   */
  #toPersisted(settings: AppSettings): {
    json: string
    slots: Record<CredentialSlot, SlotState>
  } {
    const obs = this.#encodeSlot(settings.obs.password, 'obs')
    const streamable = this.#encodeSlot(settings.streamable.password, 'streamable')

    const document: PersistedSettings = {
      log: settings.log,
      character: settings.character,
      obs: {
        host: settings.obs.host,
        port: settings.obs.port,
        autoConnect: settings.obs.autoConnect,
        // Spread-or-nothing rather than `passwordEnc: cipher ?? undefined`: the project
        // compiles with `exactOptionalPropertyTypes`, and an explicit `undefined` would
        // also leave a `"passwordEnc": null`-shaped hole in a hand-editable file.
        ...(obs.cipher === null ? {} : { [ENCRYPTED_PASSWORD_KEY]: obs.cipher })
      },
      clips: settings.clips,
      streamable: {
        enabled: settings.streamable.enabled,
        email: settings.streamable.email,
        autoUpload: settings.streamable.autoUpload,
        maxFileBytes: settings.streamable.maxFileBytes,
        ...(streamable.cipher === null ? {} : { [ENCRYPTED_PASSWORD_KEY]: streamable.cipher })
      }
    }

    return {
      // Trailing newline + 2-space indent: this file is documented as hand-editable,
      // so it should look like something a human wrote.
      json: `${JSON.stringify(document, null, 2)}\n`,
      slots: { obs: obs.state, streamable: streamable.state }
    }
  }

  /**
   * Decides what (if anything) is written for one password, and what that means for the
   * slot's reported status.
   *
   * NEVER THROWS, and NEVER FALLS BACK TO PLAINTEXT. A password that cannot be encrypted
   * simply does not reach the file; it stays in memory, works for the rest of the
   * session, and is reported as `'unavailable'` so the UI can warn that it will need
   * re-typing after a restart.
   *
   * "DOES NOT REACH THE FILE" IS NOT THE SAME AS "IS REMOVED FROM THE FILE", and the
   * difference is the bug this method used to have. If the ciphertext already on disk
   * still decrypts to exactly the password being stored, it is written back out BYTE FOR
   * BYTE - no cipher needed, nothing new committed, nothing lost. A keyring that locked
   * halfway through a session therefore costs the user the ability to save a NEW password,
   * not the one they saved last week.
   */
  #encodeSlot(plain: string, slot: CredentialSlot): { cipher: string | null; state: SlotState } {
    const previous = this.#slots[slot]
    const crypto = this.#usableCrypto()

    // The blob already on disk, IF it corresponds to the password we are being asked to
    // store. Comparing the plaintext is the entire safety argument: re-writing these bytes
    // stores exactly what the caller asked for. A password the user CHANGED gets no such
    // treatment - see the failure branch below.
    const unchanged: ReadableBlob | null =
      previous.readable !== null && previous.readable.plain === plain ? previous.readable : null

    if (crypto === null) {
      const cipher = unchanged === null ? previous.retained : unchanged.cipher
      return {
        cipher,
        state: {
          status: 'unavailable',
          retained: previous.retained,
          readable: unchanged,
          migrated: false
        }
      }
    }

    if (plain !== '') {
      let cipher = ''
      try {
        cipher = crypto.encrypt(plain)
      } catch {
        // safeStorage can fail at write time even after reporting itself available
        // (a locked keyring, a profile change mid-session).
        cipher = ''
      }

      if (cipher !== '') {
        // A freshly written blob supersedes anything retained: this one we can read.
        // Recorded as readable because `encrypt` and `decrypt` are documented as each
        // other's inverse, so the bytes about to reach disk are bytes we can reproduce.
        return {
          cipher,
          state: { status: 'ok', retained: null, readable: { cipher, plain }, migrated: false }
        }
      }

      if (unchanged !== null) {
        // THE PASSWORD HAS NOT CHANGED AND ITS CIPHERTEXT IS ALREADY CORRECT. Write it
        // straight back rather than dropping it: the alternative deletes a working
        // credential during an unrelated background save (a level-up persisting
        // `character.detected`) and the user finds out on the next launch, with the field
        // simply looking empty. The status is still `'unavailable'` - a password typed
        // from here on genuinely cannot be stored - but nothing that already worked is
        // taken away to say so.
        return {
          cipher: unchanged.cipher,
          state: { status: 'unavailable', retained: null, readable: unchanged, migrated: false }
        }
      }

      // A DIFFERENT password that could not be encrypted. Any older blob is deliberately
      // NOT written back here: it decrypts to the password the user has just replaced, and
      // silently restoring that on the next launch would be worse than an empty field,
      // because it looks like it worked. `retained` (a blob nobody can read anyway) is the
      // one exception and is preserved as always.
      return {
        cipher: previous.retained,
        state: {
          status: 'unavailable',
          retained: previous.retained,
          readable: null,
          migrated: false
        }
      }
    }

    // Nothing to store. A retained blob is written back out unchanged, and the reason we
    // could not read it survives with it - so "please re-enter your password" keeps being
    // said across restarts instead of decaying into a field that merely looks empty.
    //
    // A READABLE blob is NOT preserved here, and that asymmetry is the point: an empty
    // password means the user cleared the field, and honouring that has to actually remove
    // the secret from the file.
    return {
      cipher: previous.retained,
      state: {
        status: previous.retained === null ? 'ok' : 'undecryptable',
        retained: previous.retained,
        readable: null,
        migrated: false
      }
    }
  }

  /**
   * Validates `input` and then substitutes {@link SettingsStoreOptions.defaultLibraryDir}
   * if the resulting `clips.libraryDir` is blank.
   *
   * Whitespace-only counts as blank: `validateSettings` deliberately does not trim
   * `libraryDir` (paths are allowed to be strange), so `"   "` would otherwise
   * survive as a real directory name and every clip move would fail.
   *
   * `input` is always PLAINTEXT by the time it gets here - {@link #decryptInto} runs
   * first on the load path, and the save path merges values that are already in memory.
   * `validateSettings` has no idea encryption exists, and a still-encrypted blob would
   * sail through it as a perfectly valid password.
   */
  #resolve(input: unknown): AppSettings {
    const validated = validateSettings(input)
    const libraryDir =
      validated.clips.libraryDir.trim() === '' ? this.#defaultLibraryDir : validated.clips.libraryDir

    return {
      ...validated,
      log: {
        ...validated.log,
        // Expanded HERE rather than at each consumer so `log.path` is absolute for
        // everyone downstream - watcher, name scan, and the "currently watching"
        // readout in the UI, which should show the path actually being opened.
        path: validated.log.path === null ? null : expandHomePath(validated.log.path, this.#homeDir)
      },
      clips: { ...validated.clips, libraryDir: expandHomePath(libraryDir, this.#homeDir) }
    }
  }

  /**
   * Writes `json` durably: stage into a temp file, flush it to the platter, then
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
   * Takes an already-serialised string rather than an {@link AppSettings}: the in-memory
   * type still carries plaintext passwords, and the encrypted document is built by
   * {@link #toPersisted}. Nothing here may serialise settings on its own.
   */
  #writeAtomically(json: string): void {
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
