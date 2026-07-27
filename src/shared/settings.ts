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

/** Which character counts as "me". */
export interface CharacterSettings {
  /**
   * The local player's character name, used to compute `DeathEvent.isSelf`.
   *
   * `""` (the default) means UNCONFIGURED: `isSelf` is then always false, nothing
   * is ever published on `death:self`, and the replay clipper stays idle. We refuse
   * to guess, because a wrong guess means clipping a party member's deaths.
   */
  readonly name: string
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

/** The complete persisted application configuration. */
export interface AppSettings {
  readonly log: LogSettings
  readonly character: CharacterSettings
  readonly obs: ObsSettings
  readonly clips: ClipSettings
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
    name: ''
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
 */
export function validateSettings(input: unknown): AppSettings {
  const log = field(input, 'log')
  const character = field(input, 'character')
  const obs = field(input, 'obs')
  const clips = field(input, 'clips')

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
      name: coerceString(field(character, 'name'), DEFAULT_SETTINGS.character.name).trim()
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
    }
  }
}

/**
 * Applies a {@link DeepPartial} patch to a base settings object and validates the
 * result. Shallow-merges each of the four sections, so a patch may name any subset
 * of any section without clobbering its siblings.
 *
 * This is the exact operation behind the `settings:set` IPC call; it lives here so
 * it is unit-testable without electron.
 */
export function applySettingsPatch(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  return validateSettings({
    log: { ...base.log, ...withoutUndefined(patch.log) },
    character: { ...base.character, ...withoutUndefined(patch.character) },
    obs: { ...base.obs, ...withoutUndefined(patch.obs) },
    clips: { ...base.clips, ...withoutUndefined(patch.clips) }
  })
}
