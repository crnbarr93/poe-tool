/**
 * FROZEN TYPE CONTRACT - src/shared/settings.ts
 * ==============================================
 *
 * The persisted configuration shape plus a pure, total validator.
 *
 * RULES FOR THIS FILE:
 *  - No imports at all. Compiled by both the node project and the renderer
 *    (`types: []`), so `node:*` and `electron` are both forbidden. That is why
 *    {@link DEFAULT_SETTINGS} cannot fill in an OS-specific videos directory -
 *    see the note on `clips.libraryDir`.
 *  - No `any`, no `@ts-ignore`. Untrusted input is typed `unknown` and narrowed.
 *  - {@link validateSettings} MUST NOT throw for ANY input. It is the only thing
 *    standing between a hand-edited / corrupted settings.json and a main process
 *    that fails to boot.
 *
 * SECRETS: this file describes the IN-MEMORY shape, in which every password is a plain
 * string. Encryption at rest is entirely `src/main/settings/store.ts`'s job (Electron
 * `safeStorage`, injected as an encrypt/decrypt pair), so the on-disk JSON does not
 * match this type and nothing here knows that. Keeping the secret OUT of renderer
 * payloads is a separate rule with its own helper - see {@link redactSecrets}.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Where Client.txt lives and how aggressively we poll it. */
export interface LogSettings {
  /**
   * Absolute path to Client.txt. `null` means "not configured yet" - the watcher
   * sits in the `idle` state and the UI prompts for auto-detect.
   *
   * Whitespace-only strings are normalised to `null` by {@link validateSettings}.
   */
  readonly path: string | null
  /**
   * Poll interval in ms for the tail loop. Default 500 - fast enough that a death
   * clip is saved well inside the OBS replay buffer window, cheap enough to ignore.
   * Clamped to {@link POLL_INTERVAL_MS_MIN}..{@link POLL_INTERVAL_MS_MAX}.
   */
  readonly pollIntervalMs: number
}

/**
 * Which character counts as "me".
 *
 * TWO HALVES, ONE ANSWER. `override` is what the user typed; `detected*` is what the
 * app learned from `... (Marauder) is now level 42` lines. They are stored separately
 * rather than collapsed into one field so that clearing a manual override falls back
 * to the detection instead of wiping it, and so the UI can always show both. The
 * resolved answer - `override` when non-empty, else `detected`, else nothing - is
 * `ActiveCharacter` in `./events`; NOTHING should re-derive that rule by hand.
 */
export interface CharacterSettings {
  /**
   * MANUAL override of the active character. Wins over {@link detected} whenever it
   * is non-empty.
   *
   * Exists for GROUP PLAY: a party member's level-up lands in our Client.txt exactly
   * like our own, so auto-detection can honestly pick the wrong person. Typing the
   * name here settles it.
   *
   * `""` (the default) means "no override" - NOT "unconfigured", because detection
   * may still supply a name. Trimmed by {@link validateSettings}.
   */
  readonly override: string
  /**
   * The character name auto-detected from the most recent qualifying
   * `LevelUpEvent`, or `null` if none has ever been seen.
   *
   * PERSISTED ON PURPOSE, and this is the whole reason it lives in settings rather
   * than in memory: level-ups are SPARSE. A level-98 character can play for weeks
   * without producing one, so a detection held only in RAM would be lost on the next
   * restart and the app would go back to clipping nothing. One level-up ever must be
   * enough, forever.
   *
   * Whitespace-only values normalise to `null`.
   */
  readonly detected: string | null
  /**
   * Class or ascendancy from that same level-up line, e.g. `"Marauder"`,
   * `"Berserker"`. `null` when nothing has been detected.
   *
   * DISPLAY ONLY. It changes under a fixed name when the character ascends, so it is
   * not part of anyone's identity - never compare on it.
   */
  readonly detectedClass: string | null
  /**
   * Level from that same level-up line. `null` when nothing has been detected.
   * Display only; clamped to {@link CHARACTER_LEVEL_MIN}..{@link CHARACTER_LEVEL_MAX}.
   */
  readonly detectedLevel: number | null
}

/** obs-websocket v5 connection parameters. */
export interface ObsSettings {
  /** Host running OBS. Default `127.0.0.1` - remote hosts work but are unsupported. */
  readonly host: string
  /** obs-websocket port. Default 4455 (the v5 default). Clamped to 1..65535. */
  readonly port: number
  /** obs-websocket password. `""` means auth disabled in OBS. Never logged. */
  readonly password: string
  /** Connect on app launch (and keep retrying) rather than waiting for a manual connect. */
  readonly autoConnect: boolean
}

/** Replay-buffer clipping behaviour and where clips end up. */
export interface ClipSettings {
  /** Master switch. When false, no replay buffer saves are ever requested. */
  readonly enabled: boolean
  /**
   * Directory clips are moved into after OBS writes them.
   *
   * DEFAULTS TO `""` ON PURPOSE. `src/shared/**` cannot import electron, so it
   * cannot call `app.getPath('videos')`. `src/main/settings/store.ts` is
   * responsible for substituting the OS videos directory when it loads a settings
   * object whose `libraryDir` is empty. Treat `""` as "not resolved yet", never as
   * "the current working directory".
   */
  readonly libraryDir: string
  /**
   * Minimum gap in ms between two replay-buffer saves. Default 5000.
   *
   * PoE can log several deaths in a burst (party wipe, or a death during a
   * zone transition). Without this, each one would trigger an overlapping OBS save.
   * Clamped to {@link DEBOUNCE_MS_MIN}..{@link DEBOUNCE_MS_MAX}; 0 disables debouncing.
   */
  readonly debounceMs: number
  /** Write a `<clip>.json` sidecar with the zone/character/event metadata next to each clip. */
  readonly writeSidecar: boolean
}

/**
 * Streamable account + auto-upload behaviour.
 *
 *
 * THE PASSWORD IS A PLAIN STRING HERE, AND THAT IS DELIBERATE
 * -----------------------------------------------------------
 * {@link password} is the IN-MEMORY value: what the user typed, what the uploader puts
 * in an HTTP Basic header. ENCRYPTION IS A STORE CONCERN, applied on write and reversed
 * on read by `src/main/settings/store.ts` (Electron `safeStorage`/DPAPI, injected as an
 * encrypt/decrypt pair - see that file's header). The persisted JSON therefore does NOT
 * look like this type, and it is not supposed to: on disk the secret is an opaque
 * base64 blob under a different key, and the store is the ONLY thing that knows that.
 *
 * The consequences, all of which someone will otherwise get wrong:
 *  - The in-memory shape never changes. Every consumer reads `settings.streamable.password`
 *    and gets a usable password or `""`. Nothing outside the store decrypts anything.
 *  - {@link validateSettings} knows nothing about encryption. It coerces whatever it is
 *    handed; the store decrypts BEFORE validating and encrypts AFTER.
 *  - A decrypt that fails (the settings file was copied from another machine, or Windows
 *    rotated the DPAPI key) is NOT a corrupt-settings event. The password comes back as
 *    `""` - "you need to type it again" - and the reason is reported to the UI through
 *    `credentials:status` in `./ipc`. Losing a password must never cost the user the
 *    rest of their settings.
 *
 * THIS PASSWORD NEVER TRAVELS TO THE RENDERER. See {@link redactSecrets} and the
 * password invariant in `./ipc`.
 *
 *
 * WHY THERE IS NO API TOKEN FIELD
 * -------------------------------
 * Streamable has no revocable upload token. Its documented API is read-only and its
 * upload endpoint is unofficial, authenticated with the ACCOUNT email + password. That
 * is a real credential with real blast radius, which is why it is encrypted at rest,
 * kept out of every renderer payload, and gated behind {@link enabled} defaulting to
 * false. Exactly one module in `src/main/**` talks to that endpoint, and its header is
 * where the endpoint's unofficial status is documented.
 */
export interface StreamableSettings {
  /**
   * MASTER SWITCH. `false` means poe-tool never contacts Streamable at all - no upload,
   * no status poll, no credential check - regardless of {@link autoUpload}.
   *
   * DEFAULTS TO FALSE. Uploading a death clip publishes it to a third party under the
   * user's account; that has to be an explicit opt-in, never something that starts
   * happening because the app updated.
   */
  readonly enabled: boolean
  /** Streamable account email, used as the HTTP Basic username. `""` when unconfigured. Trimmed. */
  readonly email: string
  /**
   * Streamable account password, used as the HTTP Basic password. `""` when unconfigured.
   *
   * IN MEMORY ONLY as far as this type is concerned - the store encrypts it at rest.
   * See the interface header. NOT trimmed: a password may legitimately begin or end
   * with a space. Never logged, never put in an error message, never sent to the
   * renderer.
   */
  readonly password: string
  /**
   * Upload every death clip automatically as it is filed.
   *
   * GATED BY {@link enabled}: `autoUpload: true` with `enabled: false` uploads nothing.
   * Defaults to true because it is only reachable once the user has already opted in by
   * turning {@link enabled} on; the pair exists so a user can keep their credentials
   * configured while pausing automatic uploads.
   */
  readonly autoUpload: boolean
  /**
   * Refuse to upload a file larger than this many bytes, WITHOUT contacting Streamable.
   *
   * Defaults to {@link STREAMABLE_FREE_TIER_MAX_BYTES} (250 MB), the free-plan cap. The
   * point is a specific, human error - "this clip is 380 MB; Streamable's free plan
   * stops at 250 MB" - instead of a long upload that ends in an opaque server rejection.
   *
   * `0` disables the check entirely, which is also what a negative value clamps to;
   * Streamable's own limit then does the rejecting and the failure shows up as a
   * `failed` upload rather than a silent loss. Clamped to
   * {@link STREAMABLE_MAX_FILE_BYTES_MIN}..{@link STREAMABLE_MAX_FILE_BYTES_MAX}.
   */
  readonly maxFileBytes: number
}

/** The complete persisted application configuration. */
export interface AppSettings {
  readonly log: LogSettings
  readonly character: CharacterSettings
  readonly obs: ObsSettings
  readonly clips: ClipSettings
  readonly streamable: StreamableSettings
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Below this the tail loop burns CPU for no benefit. */
export const POLL_INTERVAL_MS_MIN = 100
/** Above this a death clip risks falling outside the OBS replay buffer window. */
export const POLL_INTERVAL_MS_MAX = 10_000
/** Valid TCP port range. */
export const PORT_MIN = 1
export const PORT_MAX = 65_535
/** 0 = no debouncing. */
export const DEBOUNCE_MS_MIN = 0
/** One minute. Anything longer is indistinguishable from `clips.enabled = false`. */
export const DEBOUNCE_MS_MAX = 60_000
/** A character exists at level 1; there is no level 0. */
export const CHARACTER_LEVEL_MIN = 1
/** PoE 1's level cap. `character.detectedLevel` is display-only, so clamping is cosmetic. */
export const CHARACTER_LEVEL_MAX = 100

/**
 * Streamable's FREE-PLAN per-video size cap, in bytes (250 MB), and the default for
 * `streamable.maxFileBytes`.
 *
 * The free plan also caps a video at 10 minutes and deletes it after 90 days. Neither
 * is checkable from a file size, so neither is a setting: a replay-buffer clip is
 * typically 30-60s, and retention is Streamable's business, not ours. This one is
 * checkable before a single byte is sent, so it is checked.
 *
 * MB here is 1024-based, matching how OBS and Windows both report file sizes. If
 * Streamable means 250 * 1000 * 1000 the difference is ~5%, and erring high only means
 * the server rejects an upload we could have rejected first - a visible `failed`
 * upload, not a silent one.
 */
export const STREAMABLE_FREE_TIER_MAX_BYTES = 250 * 1024 * 1024
/** 0 = upload anything and let Streamable be the one to refuse it. */
export const STREAMABLE_MAX_FILE_BYTES_MIN = 0
/**
 * 10 GiB. Far above anything Streamable accepts, so it is purely a sanity bound on a
 * hand-edited or overflowed value - not a limit anyone should ever reach.
 */
export const STREAMABLE_MAX_FILE_BYTES_MAX = 10 * 1024 * 1024 * 1024

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The baseline every settings object is merged over.
 *
 * Frozen at every level: this object is exported by value and handed to callers,
 * so a stray mutation would poison defaults for the whole process.
 *
 * `clips.libraryDir` is intentionally `""` - see {@link ClipSettings.libraryDir}.
 */
export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  log: Object.freeze({
    path: null,
    pollIntervalMs: 500
  }),
  character: Object.freeze({
    override: '',
    detected: null,
    detectedClass: null,
    detectedLevel: null
  }),
  obs: Object.freeze({
    host: '127.0.0.1',
    port: 4455,
    password: '',
    autoConnect: true
  }),
  clips: Object.freeze({
    enabled: true,
    libraryDir: '',
    debounceMs: 5000,
    writeSidecar: true
  }),
  // `enabled: false` is the important default here: uploading a death clip publishes it
  // to a third party under the user's own account, so it may only ever happen because
  // the user turned it on. `autoUpload: true` is only reachable once they have.
  streamable: Object.freeze({
    enabled: false,
    email: '',
    password: '',
    autoUpload: true,
    maxFileBytes: STREAMABLE_FREE_TIER_MAX_BYTES
  })
})

// ---------------------------------------------------------------------------
// Partial patches
// ---------------------------------------------------------------------------

/**
 * Recursive value mapper for {@link DeepPartial}. Split out so the mapped type stays
 * homomorphic (and therefore preserves `readonly`).
 *
 * Arrays/tuples are treated as leaves - we never want `DeepPartial<T[]>` producing
 * a sparse array type. `AppSettings` has no arrays today; this guard exists so the
 * type stays correct if one is added.
 */
type DeepPartialValue<V> = V extends readonly unknown[] ? V : V extends object ? DeepPartial<V> : V

/**
 * A patch over {@link AppSettings}: any subset of any depth.
 *
 * `| undefined` is explicit because the project compiles with
 * `exactOptionalPropertyTypes: true`; without it, `{ log: { path: undefined } }`
 * would be a type error at every call site that builds a patch programmatically.
 *
 * Used as the payload of the `settings:set` IPC call.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: DeepPartialValue<T[K]> | undefined
}

// ---------------------------------------------------------------------------
// Coercion helpers (all pure, all total, none throw)
// ---------------------------------------------------------------------------

/** True for plain objects only - rejects `null` and arrays, both of which are `typeof 'object'`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads `key` off an unknown value, yielding `undefined` when the value is not a
 * record. Lets the section readers below be written without repeated guards.
 */
function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

/**
 * Copies a patch section into a plain record, DROPPING keys whose value is
 * `undefined`.
 *
 * Patch semantics are "absent means no change". Without this, spreading
 * `{ path: undefined }` over a base would blank the field and
 * {@link validateSettings} would then reset it to the factory default instead of
 * preserving the user's current value. (The distinction is invisible over IPC,
 * where JSON serialisation already drops `undefined`, but very visible to
 * in-process callers and tests.)
 */
function withoutUndefined(patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRecord(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

/** Non-string input falls back. Strings pass through verbatim (no trimming - paths may be odd). */
function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Like {@link coerceString} but for `string | null` fields: `null` and whitespace-only
 * strings both normalise to `null`, so `""` from an emptied text input means
 * "unset" rather than "the empty path".
 */
function coerceNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value.trim() === '' ? null : value
  return fallback
}

/**
 * {@link coerceNullableString} plus a trim, for a name that may legitimately be
 * absent - `character.detected` and `character.detectedClass`.
 *
 * The trim is not cosmetic: names are compared case-insensitively AFTER trimming
 * everywhere else in the app, and a PoE character name contains no whitespace at all,
 * so a stray space from a hand-edited settings.json would otherwise survive into a
 * comparison that then silently never matches. A value that is nothing but whitespace
 * becomes `null` - i.e. "never detected" - rather than `""`.
 */
function coerceNameOrNull(value: unknown, fallback: string | null): string | null {
  const raw = coerceNullableString(value, fallback)
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * {@link coerceInt} for a `number | null` field.
 *
 * An explicit `null` means "unknown" and is preserved as such. Anything unusable
 * (absent, `NaN`, an object) falls back, exactly as {@link coerceInt} does; a usable
 * but out-of-range number is CLAMPED rather than rejected, matching every other
 * numeric field here. Clamping is safe for the only current caller
 * (`character.detectedLevel`) because that field is display-only - nothing branches
 * on it, so a corrupted value costs a wrong number in the UI, not a wrong decision.
 */
function coerceIntOrNull(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number
): number | null {
  if (value === null) return null
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value)
  } else {
    return fallback
  }
  if (!Number.isFinite(n)) return fallback
  return clamp(Math.round(n), min, max)
}

/** Accepts real booleans and the strings `"true"`/`"false"` (JSON hand-edits, HTML inputs). */
function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

/**
 * Coerces to a finite integer inside [min, max].
 *
 * Numeric strings are accepted because both JSON hand-edits and `<input type=number>`
 * commonly deliver them. `NaN`/`Infinity`/booleans/objects fall back to the default
 * (NOT to a clamp bound - a garbage value should restore the default, not silently
 * become 100ms).
 */
function coerceInt(value: unknown, fallback: number, min: number, max: number): number {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value)
  } else {
    return fallback
  }
  if (!Number.isFinite(n)) return fallback
  return clamp(Math.round(n), min, max)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The pre-0.2 key for the manually configured character: `character.name: string`.
 *
 * Read ONLY by {@link validateSettings}, which migrates a non-empty value into
 * `character.override`. Named rather than inlined so the migration is greppable, and
 * kept unexported so nothing else can start depending on the dead key or write it
 * back out.
 *
 * THIS IS THE MIGRATION CONTRACT A TEST SHOULD PIN:
 * `validateSettings({ character: { name: 'Exile' } }).character.override === 'Exile'`,
 * and `.character` must not carry a `name` property afterwards.
 */
const LEGACY_CHARACTER_NAME_KEY = 'name'

/**
 * Deep-merges arbitrary untrusted input over {@link DEFAULT_SETTINGS} and returns a
 * complete, in-range {@link AppSettings}.
 *
 * Guarantees relied on by every caller:
 *  - NEVER throws, for any input including `undefined`, `null`, arrays, strings,
 *    circular objects and hostile shapes.
 *  - ALWAYS returns every field. Missing or wrong-typed fields fall back to the
 *    default; out-of-range numbers are clamped rather than rejected.
 *  - Pure: does not mutate `input` and does not alias any part of it into the
 *    result (every value is a primitive copied out).
 *
 * It is used for BOTH jobs: sanitising settings.json on load, and applying a
 * {@link DeepPartial} patch (merge the patch onto the current settings first, then
 * pass the merged object through here).
 *
 * It is also where the ONE schema migration lives - see {@link LEGACY_CHARACTER_NAME_KEY}.
 */
export function validateSettings(input: unknown): AppSettings {
  const log = field(input, 'log')
  const character = field(input, 'character')
  const obs = field(input, 'obs')
  const clips = field(input, 'clips')
  // NOTE FOR THE STORE: by the time this sees `streamable.password` it must already be
  // PLAINTEXT. Decryption happens on the way in and encryption on the way out, both in
  // `src/main/settings/store.ts`; this function has no idea either exists, and a
  // still-encrypted blob would sail through here as a perfectly valid "password".
  const streamable = field(input, 'streamable')

  // MIGRATION, and it is meant to be visible to a test that reads this file.
  //
  // The previous version persisted the manually configured character as
  // `character.name: string`. That key is gone; `character.override` replaced it. A
  // user who already typed their name into the old build MUST NOT silently lose it -
  // losing it means `isSelf` goes false everywhere and death clipping stops working
  // with no error anywhere, which is the exact failure mode this project is built to
  // avoid. So a non-empty legacy `name` is carried into `override`.
  //
  // Precedence: an explicit non-empty `override` always wins, so a settings.json that
  // somehow carries both is not dragged backwards by the stale key.
  //
  // NOT STICKY: the legacy key is only ever read off the RAW input. Once a validated
  // AppSettings exists it has no `name` field, so `applySettingsPatch` cannot
  // resurrect it and a user clearing the override to `""` really does clear it. The
  // next write of settings.json drops the legacy key for good.
  const explicitOverride = coerceString(
    field(character, 'override'),
    DEFAULT_SETTINGS.character.override
  ).trim()
  const legacyName = coerceString(field(character, LEGACY_CHARACTER_NAME_KEY), '').trim()

  return {
    log: {
      path: coerceNullableString(field(log, 'path'), DEFAULT_SETTINGS.log.path),
      pollIntervalMs: coerceInt(
        field(log, 'pollIntervalMs'),
        DEFAULT_SETTINGS.log.pollIntervalMs,
        POLL_INTERVAL_MS_MIN,
        POLL_INTERVAL_MS_MAX
      )
    },
    character: {
      // Trimmed: a trailing space on a character name would silently break isSelf.
      // Falls back to the migrated legacy `name` - see the block above.
      override: explicitOverride === '' ? legacyName : explicitOverride,
      detected: coerceNameOrNull(field(character, 'detected'), DEFAULT_SETTINGS.character.detected),
      detectedClass: coerceNameOrNull(
        field(character, 'detectedClass'),
        DEFAULT_SETTINGS.character.detectedClass
      ),
      detectedLevel: coerceIntOrNull(
        field(character, 'detectedLevel'),
        DEFAULT_SETTINGS.character.detectedLevel,
        CHARACTER_LEVEL_MIN,
        CHARACTER_LEVEL_MAX
      )
    },
    obs: {
      host: coerceString(field(obs, 'host'), DEFAULT_SETTINGS.obs.host).trim(),
      port: coerceInt(field(obs, 'port'), DEFAULT_SETTINGS.obs.port, PORT_MIN, PORT_MAX),
      // NOT trimmed - a password may legitimately contain leading/trailing spaces.
      password: coerceString(field(obs, 'password'), DEFAULT_SETTINGS.obs.password),
      autoConnect: coerceBoolean(field(obs, 'autoConnect'), DEFAULT_SETTINGS.obs.autoConnect)
    },
    clips: {
      enabled: coerceBoolean(field(clips, 'enabled'), DEFAULT_SETTINGS.clips.enabled),
      libraryDir: coerceString(field(clips, 'libraryDir'), DEFAULT_SETTINGS.clips.libraryDir),
      debounceMs: coerceInt(
        field(clips, 'debounceMs'),
        DEFAULT_SETTINGS.clips.debounceMs,
        DEBOUNCE_MS_MIN,
        DEBOUNCE_MS_MAX
      ),
      writeSidecar: coerceBoolean(field(clips, 'writeSidecar'), DEFAULT_SETTINGS.clips.writeSidecar)
    },
    streamable: {
      enabled: coerceBoolean(field(streamable, 'enabled'), DEFAULT_SETTINGS.streamable.enabled),
      // Trimmed: it goes straight into an HTTP Basic header, and a trailing space from a
      // paste would fail authentication with a message about credentials rather than
      // about whitespace.
      email: coerceString(field(streamable, 'email'), DEFAULT_SETTINGS.streamable.email).trim(),
      // NOT trimmed, exactly like `obs.password` - a password may legitimately contain
      // leading/trailing spaces, and silently altering one would produce an
      // authentication failure nobody could explain.
      password: coerceString(field(streamable, 'password'), DEFAULT_SETTINGS.streamable.password),
      autoUpload: coerceBoolean(
        field(streamable, 'autoUpload'),
        DEFAULT_SETTINGS.streamable.autoUpload
      ),
      maxFileBytes: coerceInt(
        field(streamable, 'maxFileBytes'),
        DEFAULT_SETTINGS.streamable.maxFileBytes,
        STREAMABLE_MAX_FILE_BYTES_MIN,
        STREAMABLE_MAX_FILE_BYTES_MAX
      )
    }
  }
}

/**
 * A copy of `settings` with every SECRET blanked, for handing to the renderer.
 *
 * THE INVARIANT THIS EXISTS TO MAKE EXECUTABLE: a password only ever travels
 * renderer -> main (the user typed one). Main NEVER sends one back. `settings:get` and
 * `settings:set` both resolve with an `AppSettings`, so without this every settings
 * round-trip would ship the Streamable account password into a web page - in an app
 * whose repository is public and whose renderer loads real HTML.
 *
 * `src/main/ipc-handlers.ts` must call this on every `AppSettings` it returns or pushes.
 * It lives here, not there, so the rule is one greppable function rather than a habit.
 *
 * WHAT COMES BACK: `streamable.password` is `""`. That is INDISTINGUISHABLE from "no
 * password is configured", which is deliberate - the renderer is not entitled to know
 * either way from this payload. It asks `credentials:status` (see `./ipc`) instead,
 * which reports whether a secret is present and, if it went missing, why.
 *
 * AND THE OTHER HALF OF THE RULE, WHICH IS EASY TO MISS: because the renderer holds
 * `""`, and `useSettingsController` sends its whole settings object back as a patch, an
 * empty `streamable.password` in an incoming patch MUST mean "leave the stored password
 * alone" - never "clear it". Otherwise saving an unrelated field would wipe the
 * credential. `src/main/ipc-handlers.ts` owns that narrowing; see the note on
 * `settings:set` in `./ipc`.
 *
 * `obs.password` is deliberately NOT blanked. It is a local obs-websocket password on
 * `127.0.0.1` whose blast radius is control of the user's own OBS, it is frequently
 * empty, and the settled config UI already round-trips and displays it. A Streamable
 * account password is a different kind of thing: it is reusable, it is the account, and
 * there is no revocable token to use instead.
 */
export function redactSecrets(settings: AppSettings): AppSettings {
  if (settings.streamable.password === '') return settings
  return { ...settings, streamable: { ...settings.streamable, password: '' } }
}

/**
 * Applies a {@link DeepPartial} patch to a base settings object and validates the
 * result. Shallow-merges each of the five sections, so a patch may name any subset
 * of any section without clobbering its siblings.
 *
 * This is the exact operation behind the `settings:set` IPC call; it lives here so
 * it is unit-testable without electron.
 *
 * SECRETS ARE ORDINARY FIELDS TO THIS FUNCTION. A patch carrying
 * `streamable.password: ''` really does set it to `''`, because "absent means no
 * change" is the only patch rule here and inventing a second one ("empty also means no
 * change") would make it impossible to express a deliberate clear. The renderer's
 * redacted `''` is prevented from reaching here by the narrowing in
 * `src/main/ipc-handlers.ts` - see {@link redactSecrets}.
 */
export function applySettingsPatch(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  return validateSettings({
    log: { ...base.log, ...withoutUndefined(patch.log) },
    character: { ...base.character, ...withoutUndefined(patch.character) },
    obs: { ...base.obs, ...withoutUndefined(patch.obs) },
    clips: { ...base.clips, ...withoutUndefined(patch.clips) },
    streamable: { ...base.streamable, ...withoutUndefined(patch.streamable) }
  })
}
