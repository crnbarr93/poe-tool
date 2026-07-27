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
 * HOW a character stopped being alive. The discriminator on {@link DeathEvent}.
 *
 *  - `'slain'` is a normal death - the game killed you. Source line:
 *    `... : FyascoWorbinTime has been slain.` (348 occurrences in the reference log.)
 *  - `'suicide'` is PoE's `/kill` command, which is DELIBERATE and MUST NEVER
 *    TRIGGER A CLIP. Source line:
 *    `... : LargeThumbThomasReturns has committed suicide.` (7 occurrences.)
 *    Players type `/kill` to leave a map instantly or to reset a boss fight; a clip
 *    of that is thirty seconds of nothing followed by a self-inflicted death.
 *
 * A suicide is still a real {@link DeathEvent}: it is published on `death` (and on
 * `death:self` when it is ours) so death counts and the event feed stay honest. The
 * ONE consumer that must special-case it is the replay clipper, which filters on
 * this field. Doing the filtering there rather than on the bus is deliberate - the
 * bus's job is to report what happened, not to decide what is interesting.
 */
export type DeathCause = 'slain' | 'suicide'

/**
 * Something died. Source lines:
 * `... [INFO Client 50396] : FyascoWorbinTime has been slain.`
 * `... [INFO Client 42816] : LargeThumbThomasReturns has committed suicide.`
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
   * Whether the game killed this character or the player typed `/kill`. See
   * {@link DeathCause}: `'suicide'` must never produce a clip, but still counts.
   */
  readonly cause: DeathCause
  /**
   * True when `characterName` matches the RESOLVED active character - the manual
   * `settings.character.override` when it is non-empty, otherwise the auto-detected
   * `settings.character.detected` (see {@link ActiveCharacter}).
   * Comparison is case-insensitive + trimmed. When neither is known this is ALWAYS
   * false (we cannot know, so we refuse to guess and the clipper stays idle - which
   * is why "nothing detected yet" has to be surfaced loudly in the UI rather than
   * left to fail quietly).
   */
  readonly isSelf: boolean
}

/**
 * The player levelled up. Source line:
 * `... [INFO Client 24036] : LargeThumbThomasReturns (Marauder) is now level 2`
 *
 * Gated on the system marker like the other chat-shaped lines. Note there is NO
 * trailing period on this one.
 *
 * This is the ONLY line in Client.txt that names a character and identifies it as
 * the one being played, which makes it the sole basis for auto-detection. It is also
 * SPARSE: a level-98 character can play for weeks without producing one. Anything
 * derived from it therefore has to be PERSISTED (see `settings.character.detected`),
 * because a single level-up ever must be enough, across app restarts.
 *
 * WHOSE level-ups appear is NOT fully established. The reference log has 585 of these
 * lines carrying NINE distinct names - the six alts that also die in it, plus three
 * that never die and never speak in chat (one of them levelling 2 -> 8 in a single
 * uninterrupted quarter of an hour), which all look like more of the same player's
 * own characters. So this log shows a detector nothing worse than "the user swapped
 * alt", and taking the most recent name is a sound default. It does NOT prove a party
 * member's level-up stays out of our log. `settings.character.override` exists exactly
 * so that unanswered question cannot break group play - see {@link ActiveCharacter}.
 * The resolution rules live with the detector, not here.
 */
export interface LevelUpEvent extends PoeEventBase {
  readonly type: 'level-up'
  /** The character's name exactly as logged, e.g. `"LargeThumbThomasReturns"`. */
  readonly characterName: string
  /**
   * The class in parentheses, e.g. `"Marauder"`. This is the BASE class until the
   * character ascends and the ASCENDANCY afterwards - the reference log contains
   * Marauder, Berserker, Slayer, Duelist, Elementalist, Witch and Ranger for the same
   * six characters. So it is display metadata, NOT a stable identity: never key
   * anything on it, and expect it to change under a fixed `characterName`.
   *
   * Class names contain spaces in no observed case, but the type does not rely on
   * that - treat it as free text.
   */
  readonly className: string
  /** The new level, e.g. `2`. PoE 1 caps at 100. */
  readonly level: number
}

/** Every event the log layer can produce. Exhaustively switchable on `type`. */
export type PoeEvent = ZoneEnteredEvent | AreaGeneratedEvent | DeathEvent | LevelUpEvent

/** `'zone-entered' | 'area-generated' | 'death' | 'level-up'`. */
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

/**
 * WHO COUNTS AS "ME" RIGHT NOW - the resolved answer, not the raw settings.
 *
 * Produced by merging the two halves of `settings.character`, in this priority order
 * (which {@link source} records, so the UI can explain itself):
 *
 *  1. `'override'` - `settings.character.override` is non-empty. A MANUAL choice
 *     always wins. It exists for GROUP PLAY: if a party member's level-up reaches our
 *     Client.txt (see {@link LevelUpEvent} - the reference log neither proves nor
 *     disproves that it does), auto-detection would honestly land on the wrong person
 *     and every subsequent death of ours would read as someone else's. Typing a name
 *     settles it without the detector having to be right.
 *  2. `'detected'` - no override, but a {@link LevelUpEvent} has been seen at some
 *     point and persisted to `settings.character.detected`. Persisted precisely
 *     because level-ups are sparse (see {@link LevelUpEvent}): one ever, at any time
 *     in the past, must survive restarts.
 *  3. `'none'` - nothing configured and nothing ever detected. `name` is then null
 *     and EVERY `DeathEvent.isSelf` is false, so the clipper never fires. That is a
 *     silent no-op from the user's point of view, and therefore must be surfaced as
 *     a warning with a one-click picker of names harvested from the log
 *     (`character:suggestions`) rather than left to be discovered by a missing clip.
 *
 * `name` is `null` if and only if `source === 'none'`. The type does not encode that
 * as a discriminated union on purpose: consumers overwhelmingly want "the name, or
 * null", and a three-arm switch at every call site would be noise.
 *
 * {@link className} and {@link level} are independently nullable even when a name is
 * known: an override is just a name the user typed, so its class and level stay null
 * until a level-up for that character is actually observed.
 */
export interface ActiveCharacter {
  /** The resolved character name, or `null` when nothing is configured or detected. */
  readonly name: string | null
  /**
   * Class or ascendancy as of the last observed level-up, e.g. `"Marauder"`,
   * `"Berserker"`. Null when unknown - including for a name that only came from the
   * override. Display only; see {@link LevelUpEvent.className}.
   */
  readonly className: string | null
  /** Level as of the last observed level-up. Null when unknown. Display only. */
  readonly level: number | null
  /** Which rule produced {@link name}. See the priority list above. */
  readonly source: 'override' | 'detected' | 'none'
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
 *  - `death:self` carries SUICIDES TOO (`cause === 'suicide'`). It is filtered by
 *    WHOSE death it is, never by whether the death is interesting. The replay
 *    clipper does the `cause` filtering itself - see {@link DeathCause}.
 *  - `level-up` fires for party members' level-ups as well as ours, exactly like
 *    `death`. There is no `level-up:self` channel: unlike a death, a level-up is what
 *    ESTABLISHES who "self" is, so pre-filtering it on the current answer would make
 *    detection unable to bootstrap.
 *
 * `zone-changed` and `character-changed` are DERIVED STATE, not parse results: they
 * carry a complete current-value snapshot and are emitted only when that snapshot
 * actually changes, so a listener can render straight from the payload. Neither is
 * ever emitted by `publish` - the zone tracker and the character detector own them.
 */
export interface PoeEventMap {
  event: [PoeEvent]
  'zone-entered': [ZoneEnteredEvent]
  'area-generated': [AreaGeneratedEvent]
  death: [DeathEvent]
  'death:self': [DeathEvent]
  'level-up': [LevelUpEvent]
  'zone-changed': [CurrentZone]
  'character-changed': [ActiveCharacter]
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

/**
 * Narrows a {@link ParseResult} to a {@link LevelUpEvent}.
 *
 * Deliberately does NOT also test the cause/class/level fields: `type` is the
 * discriminant, and a guard that second-guesses the parser would let a malformed
 * event vanish silently instead of surfacing where it was built.
 */
export function isLevelUpEvent(r: ParseResult): r is LevelUpEvent {
  return r.type === 'level-up'
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
