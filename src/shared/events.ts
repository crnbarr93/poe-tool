/**
 * FROZEN TYPE CONTRACT - src/shared/events.ts
 * ============================================
 *
 * The vocabulary every other module speaks. Parser, event bus, zone tracker,
 * clipper, IPC layer and renderer all import from here.
 *
 * RULES FOR THIS FILE (enforced by tsconfig + review):
 *  - Pure types + tiny pure predicates. NOTHING may be imported here: no `node:*`,
 *    no `electron`, no npm packages. `src/shared/**` is compiled by BOTH the node
 *    project (`tsconfig.node.json`, types: ["node"]) and the web project
 *    (`tsconfig.web.json`, types: []). An import of `node:path` would break the
 *    renderer build; an import of `electron` would break vitest.
 *  - No `any`. No `@ts-ignore`.
 *  - Every field is `readonly`. Events are immutable value objects that get fanned
 *    out to many listeners and structured-cloned over IPC; nobody may mutate them.
 *
 * A NOTE ON `Date` CROSSING IPC: `LogLineMeta.timestamp` is a real `Date`.
 * Electron's IPC uses the structured clone algorithm, which preserves `Date`
 * instances, so this survives main -> renderer transport. It does NOT survive
 * `JSON.stringify` -> `JSON.parse` (becomes a string), so any code persisting an
 * event to disk must re-hydrate the `Date` on read.
 */

// ---------------------------------------------------------------------------
// Log line envelope
// ---------------------------------------------------------------------------

/**
 * Log levels observed in Client.txt. See `level` on {@link LogLineMeta} for why
 * the field is widened beyond this union.
 */
export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'CRIT'

/**
 * The decoded envelope of a single Client.txt line.
 *
 * A real line looks like:
 *
 * ```text
 * 2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.
 * |---------------- ---------| |--------| |------| |----| |---| |  |--------------------------|
 * date + time (local, no tz)   clientMs   threadTag level  sub   pid   ^ system marker  body
 * ```
 *
 * The CRITICAL distinction this type encodes is {@link isSystemMessage}. The game
 * renders engine-generated messages as `] : message` (bracket, space, colon,
 * space) but renders player chat as `] PlayerName: message` (bracket, space, name,
 * colon, space). Death and zone patterns are gated on the system marker so that a
 * player typing "Bob has been slain." into global chat can never fake an event.
 */
export interface LogLineMeta {
  /** The untouched source line, minus its trailing newline. Kept for debugging + fixtures. */
  readonly raw: string
  /**
   * Wall-clock timestamp parsed from the line. Client.txt writes LOCAL time with
   * NO UTC offset, so this Date is constructed in the host's local timezone and is
   * only meaningful on the machine that produced the log.
   */
  readonly timestamp: Date
  /**
   * Milliseconds since the game client started. Monotonic within a single client
   * session and immune to clock changes, which makes it the better key for
   * ordering/deduping two lines inside one session. Resets to ~0 on game restart.
   */
  readonly clientMs: number
  /** Opaque subsystem hash, e.g. `cffb0658`. Not stable across patches - never branch on it. */
  readonly threadTag: string
  /**
   * The level from `[LEVEL Subsystem PID]`.
   *
   * Deliberately widened with `(string & {})`: an unrecognised level (GGG adds one
   * in a patch) must NOT be treated as a parse failure, it must flow through as the
   * raw string. The `string & {}` intersection keeps editor autocomplete showing the
   * five known literals while still accepting arbitrary strings.
   */
  readonly level: LogLevel | (string & {})
  /** The subsystem from `[LEVEL Subsystem PID]`. In practice always `"Client"`. */
  readonly subsystem: string
  /** The process id from `[LEVEL Subsystem PID]`. */
  readonly pid: number
  /**
   * True when the body began with the `": "` system marker, i.e. the game engine
   * wrote this line, not a player. Death and zone detection MUST require this.
   */
  readonly isSystemMessage: boolean
  /** The message text with the `": "` system marker (if any) stripped. */
  readonly body: string
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Fields shared by every {@link PoeEvent}. Not exported: consumers should switch on
 * the `PoeEvent` union rather than programming against the base.
 */
interface PoeEventBase {
  /** The envelope this event was decoded from. */
  readonly meta: LogLineMeta
  /**
   * `Date.now()` at the moment the line was READ, not the moment it was logged.
   * For live tailing these are within milliseconds; for backlog replay they can be
   * hours apart. Use this (never `meta.timestamp`) for debounce windows.
   */
  readonly detectedAt: number
  /**
   * True when this line came from replaying bytes that already existed in the file
   * before we attached (startup catch-up, or a re-read after rotation).
   *
   * ANY side effect - saving an OBS replay buffer, writing a clip, playing a sound -
   * MUST early-return when this is true. Otherwise launching the app after a long
   * session would fire a burst of clips for deaths that happened hours ago.
   * Pure state updates (e.g. "what zone am I in") SHOULD still process backlog so
   * the UI is correct on launch.
   */
  readonly backlog: boolean
}

/**
 * The player entered a new area. Source line:
 * `... [INFO Client 50396] : You have entered Karui Shores.`
 *
 * Gated on the system marker. This is the human-readable name only - the internal
 * area id and level arrive ~1s EARLIER on the paired {@link AreaGeneratedEvent}.
 */
export interface ZoneEnteredEvent extends PoeEventBase {
  readonly type: 'zone-entered'
  /** Display name with the trailing period stripped, e.g. `"Karui Shores"`. */
  readonly zoneName: string
}

/**
 * The client generated an area. Source line:
 * `... [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1`
 *
 * NOTE: this is a DEBUG line with NO `": "` system marker, so its pattern must NOT
 * be gated on `isSystemMessage`.
 *
 * Ordering: this fires ~1 second BEFORE the matching `zone-entered`. The zone
 * tracker therefore buffers the most recent area-generated and merges it into the
 * next zone-entered to produce a complete {@link CurrentZone}.
 */
export interface AreaGeneratedEvent extends PoeEventBase {
  readonly type: 'area-generated'
  /** Monster level of the area, e.g. `69`. */
  readonly areaLevel: number
  /** Internal area id, e.g. `"2_11_endgame_town"`. Stable across patches, good for maps/keys. */
  readonly areaId: string
  /**
   * Layout seed. `1` means a NON-procedural area (town, hideout, aqueduct-style
   * static zone). Anything else is a generated instance. Useful for "don't clip in
   * town" style rules.
   */
  readonly seed: number
}

/**
 * Something died. Source line:
 * `... [INFO Client 50396] : FyascoWorbinTime has been slain.`
 *
 * Gated on the system marker, so a player typing `Bob has been slain.` in chat
 * cannot trigger this. PoE character names contain no spaces, so the name pattern
 * is `\S+` anchored - NOT `.+?`, which would happily swallow a chat sentence.
 *
 * This fires for PARTY MEMBER deaths too. Consumers that only care about the local
 * player must either check {@link isSelf} or subscribe to the pre-filtered
 * `death:self` bus channel.
 */
export interface DeathEvent extends PoeEventBase {
  readonly type: 'death'
  /** The slain character's name exactly as logged. */
  readonly characterName: string
  /**
   * True when `characterName` matches the configured `settings.character.name`.
   * Comparison is case-insensitive + trimmed. When no character name is configured
   * this is ALWAYS false (we cannot know, so we refuse to guess and the clipper
   * stays idle).
   */
  readonly isSelf: boolean
}

/** Every event the log layer can produce. Exhaustively switchable on `type`. */
export type PoeEvent = ZoneEnteredEvent | AreaGeneratedEvent | DeathEvent

/** `'zone-entered' | 'area-generated' | 'death'`. */
export type PoeEventType = PoeEvent['type']

/**
 * A line we successfully read but did not recognise. The vast majority of
 * Client.txt is this. Emitted on the `unmatched` bus channel for the debug tool;
 * production consumers ignore it.
 *
 * `meta` is `null` when even the ENVELOPE failed to parse (a truncated line from a
 * partial write, or a non-log line). `raw` is always present.
 */
export interface UnmatchedLine {
  readonly type: 'unmatched'
  readonly meta: LogLineMeta | null
  readonly raw: string
}

/** What `parseLine()` returns: either a recognised event or an unmatched line. Never throws. */
export type ParseResult = PoeEvent | UnmatchedLine

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * The zone tracker's current view of where the player is, produced by merging an
 * {@link AreaGeneratedEvent} with the {@link ZoneEnteredEvent} that follows it ~1s
 * later.
 *
 * Every field is independently nullable because the two source lines can arrive
 * without their partner:
 *  - Attaching mid-session: we may see `zone-entered` with no preceding
 *    `area-generated`, so `areaId`/`areaLevel`/`seed` stay null.
 *  - Some transitions log `Generating level ...` with no matching "You have
 *    entered" line.
 * Consumers (clip namer, UI) must handle nulls rather than assume completeness.
 */
export interface CurrentZone {
  /** Human-readable name, e.g. `"Karui Shores"`. Null before the first zone-entered. */
  readonly displayName: string | null
  /** Internal id, e.g. `"2_11_endgame_town"`. */
  readonly areaId: string | null
  /** Monster level. */
  readonly areaLevel: number | null
  /** Layout seed; `1` means non-procedural (town/hideout). */
  readonly seed: number | null
  /** `Date.now()` when this zone became current. */
  readonly enteredAt: number
}

// ---------------------------------------------------------------------------
// Watcher status
// ---------------------------------------------------------------------------

/**
 * DISCRIMINANT NOTE: watcher/connection unions in this codebase discriminate on
 * `state`, while log-derived events discriminate on `type`. That is deliberate -
 * it makes `status.state` vs `event.type` read unambiguously at call sites and
 * prevents a `WatcherStatus` from ever being mistaken for a `PoeEvent`.
 */
export type WatcherState = 'idle' | 'tailing' | 'file-missing' | 'rotated' | 'read-error'

/** Nothing is being watched: no path configured yet, or the watcher was stopped. */
export interface WatcherIdleStatus {
  readonly state: 'idle'
  /** The configured path, or null when the user has not chosen/auto-detected one. */
  readonly path: string | null
  /** `Date.now()` when the watcher entered this state. */
  readonly since: number
}

/** Healthy steady state: the file is open and we are following it. */
export interface WatcherTailingStatus {
  readonly state: 'tailing'
  readonly path: string
  /** Byte offset we have consumed up to. Also the resume point after a restart. */
  readonly offset: number
  readonly since: number
  /** `Date.now()` of the last line we decoded, or null if none yet this session. */
  readonly lastLineAt: number | null
  /** Total lines read since the watcher started (backlog + live). Diagnostics only. */
  readonly linesRead: number
}

/**
 * The configured path does not exist right now. NOT fatal: the game may simply not
 * be running yet. The watcher keeps polling and transitions back to `tailing`.
 */
export interface WatcherFileMissingStatus {
  readonly state: 'file-missing'
  readonly path: string
  readonly since: number
  /** Human-readable explanation for the UI. */
  readonly message: string
}

/**
 * The file was replaced or truncated (size went backwards, or the inode changed).
 * PoE truncates Client.txt when it grows too large. The watcher resets its offset
 * and continues; this status is transient and is followed by `tailing`.
 *
 * Lines re-read after a rotation MUST be emitted with `backlog: true`.
 */
export interface WatcherRotatedStatus {
  readonly state: 'rotated'
  readonly path: string
  /** Offset we had consumed up to before the rotation was detected. */
  readonly previousOffset: number
  /** Offset we resumed from - normally 0. */
  readonly offset: number
  readonly since: number
  readonly message: string
}

/**
 * A read failed for a reason that is not "file missing" - permissions, a locked
 * file, a bad path. The watcher backs off and retries; it does not throw.
 */
export interface WatcherReadErrorStatus {
  readonly state: 'read-error'
  readonly path: string | null
  /** Offset at the time of failure, or null if we never got that far. */
  readonly offset: number | null
  readonly since: number
  /** `error.message`, safe to show in the UI. */
  readonly message: string
  /** Node's `error.code` (e.g. `"EACCES"`, `"EBUSY"`) when available. */
  readonly code: string | null
}

/** Everything the log watcher can report. Switch on `state`. */
export type WatcherStatus =
  | WatcherIdleStatus
  | WatcherTailingStatus
  | WatcherFileMissingStatus
  | WatcherRotatedStatus
  | WatcherReadErrorStatus

// ---------------------------------------------------------------------------
// Event bus channel map
// ---------------------------------------------------------------------------

/**
 * The channel -> argument-tuple map for the application event bus
 * (`src/main/events/event-bus.ts`, built on `TypedEmitter`).
 *
 * DELIBERATELY NO `error` CHANNEL. Node's `EventEmitter` throws the emitted value
 * when `'error'` is emitted with zero listeners, which would crash the main process
 * from inside the tail loop. Failures are reported as data instead, via
 * `watcher-status` carrying a `read-error` state. Do not add an `error` channel.
 *
 * Fan-out contract:
 *  - `event` receives EVERY PoeEvent, and is emitted IN ADDITION to the specific
 *    per-type channel. A listener on both `event` and `death` sees a death twice.
 *  - `death` carries all deaths including party members; `death:self` is the
 *    pre-filtered stream (`isSelf === true`) that the replay clipper listens on, so
 *    the clipper never needs to know about the character-name setting.
 */
export interface PoeEventMap {
  event: [PoeEvent]
  'zone-entered': [ZoneEnteredEvent]
  'area-generated': [AreaGeneratedEvent]
  death: [DeathEvent]
  'death:self': [DeathEvent]
  'zone-changed': [CurrentZone]
  unmatched: [UnmatchedLine]
  'watcher-status': [WatcherStatus]
}

/** Union of valid bus channel names. */
export type PoeEventChannel = keyof PoeEventMap

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrows a {@link ParseResult} to a recognised {@link PoeEvent}.
 *
 * Implemented as "not unmatched" rather than an allow-list of event types, so that
 * adding a new event variant to the union cannot silently start returning false.
 */
export function isPoeEvent(r: ParseResult): r is PoeEvent {
  return r.type !== 'unmatched'
}

/** Narrows a {@link ParseResult} to a {@link DeathEvent}. */
export function isDeathEvent(r: ParseResult): r is DeathEvent {
  return r.type === 'death'
}

/** Narrows a {@link ParseResult} to a {@link ZoneEnteredEvent}. */
export function isZoneEnteredEvent(r: ParseResult): r is ZoneEnteredEvent {
  return r.type === 'zone-entered'
}

/** Narrows a {@link ParseResult} to an {@link AreaGeneratedEvent}. */
export function isAreaGeneratedEvent(r: ParseResult): r is AreaGeneratedEvent {
  return r.type === 'area-generated'
}

/** Narrows a {@link ParseResult} to an {@link UnmatchedLine}. Inverse of {@link isPoeEvent}. */
export function isUnmatchedLine(r: ParseResult): r is UnmatchedLine {
  return r.type === 'unmatched'
}
