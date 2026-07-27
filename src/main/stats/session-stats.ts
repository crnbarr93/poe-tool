/**
 * src/main/stats/session-stats.ts
 * ===============================
 *
 * Derived state: "what has happened since poe-tool started".
 *
 * The third member of the family `zone-tracker.ts` (where am I) and
 * `character-tracker.ts` (who am I) belong to. This one answers HOW MUCH: areas entered,
 * deaths taken, how many of those were `/kill`, and how long we have been counting.
 *
 * RULES FOR THIS FILE (identical to its two siblings):
 *  - No `electron`. No `node:*` either - the only clock is the injected
 *    {@link SessionStatsOptions.clock}, so uptime is testable without waiting.
 *  - No `any`, no `@ts-ignore`.
 *  - NOTHING may escape into the caller. Every handler here runs inside
 *    `TypedEmitter.emit`, which is driven by the tail loop's `setInterval` callback,
 *    where an uncaught throw takes the Electron main process down. The character read,
 *    the clock read and the outgoing emit are each individually contained.
 *
 *
 * COUNTED LIVE, NEVER DERIVED FROM THE RING BUFFER
 * ------------------------------------------------
 * The tempting implementation is to count deaths in the `events:recent` buffer that
 * `ipc-handlers.ts` already keeps. That buffer is bounded at 200 events against a stream
 * dominated by zone traffic, so an evening's mapping evicts the session's early deaths
 * and the count would silently walk BACKWARDS while the user played. A counter that goes
 * down is worse than no counter: it is a number nobody has any reason to distrust.
 *
 * So every count here is an increment on a live event and these fields only ever rise.
 * The buffer stays what it is - a replay for a window that opened late - and this class
 * stays the only thing that knows the totals.
 *
 *
 * BACKLOG IS SKIPPED - THE OPPOSITE OF THE OTHER TWO TRACKERS
 * -----------------------------------------------------------
 * `PoeEventBase.backlog` means "this line existed in the file before we attached".
 * `ZoneTracker` and `CharacterTracker` deliberately PROCESS those, because they answer
 * "what is true right now" and the last zone in a backlog drain is the zone the player is
 * standing in.
 *
 * This class answers "what happened DURING THIS SESSION", so it must skip them. PoE
 * truncates Client.txt when it grows too large; the re-read that follows hands the
 * watcher back a stretch of file it has already seen, with `backlog: true` on every line.
 * Counting those would make the death count jump by fifty in one tick, mid-session, for
 * deaths that already happened - and there would be no way for the user to tell that from
 * a genuinely terrible map. Same rule, same reason, as the replay clipper refusing to fire
 * OBS for backlog deaths.
 *
 *
 * THE LEVEL IS READ, NOT TRACKED
 * ------------------------------
 * `characterLevel` comes from {@link SessionStatsOptions.characters} on every snapshot.
 * This class deliberately does NOT watch `level-up` and keep its own number:
 * `CharacterTracker` already resolves override-vs-detected, already persists a detection
 * across restarts (level-ups are sparse enough that a level-98 character can play for
 * weeks without producing one), and already knows that an override has no level until a
 * level-up names it. A second copy here would be a second answer, and the two would
 * disagree on exactly the runs where it mattered.
 *
 *
 * WHY THERE IS NO AVERAGE-MAP-TIME COUNTER
 * ----------------------------------------
 * The design asks for one. It is not derivable from what exists: an average needs
 * per-area DURATIONS, and knowing when an area was entered is not knowing when it was
 * left. `uptimeMs / areasEntered` looks like the answer and is not one - it counts town
 * trips, hideout visits and the twenty minutes the app sat open before the game started.
 * The number would be wrong in a way no user could ever check. It arrives with area
 * timers or it does not arrive; see `SessionStatsSnapshot`.
 */

import type {
  ActiveCharacter,
  DeathEvent,
  PoeEventMap,
  ZoneEnteredEvent
} from '../../shared/events'
import type { SessionStatsSnapshot } from '../../shared/ipc'
import { TypedEmitter, type EventListener } from '../events/typed-emitter'

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/**
 * The slice of the application event bus this class uses.
 *
 * Structural, in the same style as `ZoneTrackerBus` and `CharacterTrackerBus`:
 * `PoeEventBus`, a bare `TypedEmitter<PoeEventMap>` and a hand-written stub all satisfy
 * it. `on`/`off` return `unknown` because `TypedEmitter` returns `this` for chaining
 * while other emitters return `void` or an unsubscribe function; this class ignores all
 * three.
 *
 * NO `emit`, unlike its two siblings. Session stats are NOT a `PoeEventMap` channel -
 * that map describes log-derived events and their derived state, and a counter is
 * neither. This class broadcasts on its own emitter instead, exactly as `ObsClient`,
 * `AppUpdater` and `UploadQueue` do, and the IPC layer consumes it through the same
 * shape.
 */
export interface SessionStatsBus {
  on<K extends keyof PoeEventMap>(
    channel: K,
    listener: (...args: PoeEventMap[K]) => void
  ): unknown
  off<K extends keyof PoeEventMap>(
    channel: K,
    listener: (...args: PoeEventMap[K]) => void
  ): unknown
}

/**
 * Where {@link SessionStatsSnapshot.characterLevel} comes from.
 *
 * `CharacterTracker` satisfies this as-is - `active()` is a method, and a method is
 * assignable to a function-typed property.
 *
 * CALL IT AS A MEMBER, never destructured: `CharacterTracker` keeps its state in `#`
 * private fields, so a detached `active` reference throws on `this` rather than quietly
 * returning the wrong answer. `#readLevel` below does exactly that.
 */
export interface SessionCharacterSource {
  /** The RESOLVED active character. Cheap, side-effect free, documented as never throwing. */
  readonly active: () => ActiveCharacter
}

/** What {@link SessionStats} broadcasts. Mirrors `AppUpdaterEventMap`'s single channel. */
export interface SessionStatsEventMap {
  /**
   * Emitted when a counter or the character's level actually MOVED, and never otherwise.
   *
   * Deliberately not emitted for the clock: `uptimeMs` changes every millisecond, and a
   * push per tick would put a permanent heartbeat on an otherwise silent channel for a
   * value the renderer can compute from `startedAt`.
   */
  stats: [SessionStatsSnapshot]
}

/** Constructor arguments. The bus and the character source are required. */
export interface SessionStatsOptions {
  /** Where `zone-entered`, `death` and `character-changed` come from. */
  readonly bus: SessionStatsBus
  /** The character tracker, for the level. See {@link SessionCharacterSource}. */
  readonly characters: SessionCharacterSource
  /**
   * Source of `startedAt` and of every uptime reading. Defaults to `Date.now`.
   *
   * Injected rather than called directly so a test can assert an exact uptime instead of
   * sleeping, and so the whole class stays free of ambient state.
   */
  readonly clock?: () => number
  /**
   * Called with anything a contained failure produced - a throwing `stats` listener, a
   * character source that blew up, a clock that did. Purely diagnostic; the default is a
   * no-op and a hook that itself throws is ignored.
   */
  readonly onError?: (error: unknown) => void
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * Counts what this session has seen and broadcasts a complete snapshot when it changes.
 *
 * ```ts
 * const stats = new SessionStats({ bus, characters })
 * stats.on('stats', (snapshot) => send('push:stats', snapshot))
 * stats.snapshot // { startedAt, uptimeMs, areasEntered, deaths, suicides, characterLevel }
 * // on shutdown
 * stats.stop()
 * ```
 *
 * THE CONSTRUCTOR SUBSCRIBES, matching `ZoneTracker` and `CharacterTracker`. A counter
 * that silently never attached reads exactly like a quiet session - zero deaths, zero
 * areas - which is the one failure mode a "and don't forget to call start()" step
 * guarantees somebody will ship. {@link stop} detaches and {@link start} re-attaches;
 * both are idempotent.
 */
export class SessionStats {
  readonly #bus: SessionStatsBus
  readonly #characters: SessionCharacterSource
  readonly #clock: () => number
  readonly #onError: (error: unknown) => void

  readonly #emitter = new TypedEmitter<SessionStatsEventMap>()

  /** Stable identities, so `off` can actually find them again. */
  readonly #onZoneEntered: (event: ZoneEnteredEvent) => void
  readonly #onDeath: (event: DeathEvent) => void
  readonly #onCharacterChanged: () => void

  readonly #startedAt: number
  /**
   * Whether the constructor's clock read actually worked.
   *
   * Two lines for a case that cannot happen with `Date.now`, and they earn their keep:
   * without them a clock that failed AT CONSTRUCTION (leaving `startedAt` at 0) and
   * recovered afterwards would report an uptime of `Date.now()` - fifty-six years,
   * rendered as a session length, with nothing anywhere saying it was made up. A zero is
   * the honest answer to "we never learned when this started".
   */
  readonly #originKnown: boolean

  #subscribed = false
  #areasEntered = 0
  #deaths = 0
  #suicides = 0

  /** The last snapshot announced; the dedupe baseline. Its `uptimeMs` is never compared. */
  #lastEmitted: SessionStatsSnapshot

  constructor(options: SessionStatsOptions) {
    this.#bus = options.bus
    this.#characters = options.characters
    this.#clock = options.clock ?? Date.now
    this.#onError = options.onError ?? ((): void => undefined)

    // Read ONCE and stored: `startedAt` is the identity of this session and must not
    // wobble if the OS clock is adjusted an hour into it. Uptime is derived from a fresh
    // read against this fixed origin, which is what makes a backwards clock jump cost a
    // clamped-to-zero uptime rather than a session that appears to start in the future.
    const origin = this.#now()
    this.#originKnown = origin !== null
    this.#startedAt = origin ?? 0

    this.#onZoneEntered = (event: ZoneEnteredEvent): void => {
      this.handleZoneEntered(event)
    }
    this.#onDeath = (event: DeathEvent): void => {
      this.handleDeath(event)
    }
    this.#onCharacterChanged = (): void => {
      this.refreshCharacter()
    }

    // Seeded BEFORE subscribing, so no ordering question can arise. Announcing this would
    // be a lie - nothing has changed, it is simply what is true at startup, and a window
    // that opens later reads it with the `stats:session` request instead.
    this.#lastEmitted = this.snapshot

    this.start()
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /**
   * The counters right now, with a FRESH uptime reading.
   *
   * Cheap (four field reads, one clock call, one character read) and side-effect free -
   * it NEVER emits, so it is safe to call from an IPC handler or a hot loop.
   *
   * NEVER THROWS: a character source or a clock that blows up degrades to a null level or
   * a zero uptime rather than taking down the caller.
   */
  get snapshot(): SessionStatsSnapshot {
    const now = this.#now()
    return {
      startedAt: this.#startedAt,
      // Clamped: an OS clock adjustment (or a test clock wound backwards) must not
      // produce a negative session length, which every duration formatter in the renderer
      // would render as nonsense. A clock we could not read at all reports 0 rather than
      // a difference against an origin we never established - see `#originKnown`.
      uptimeMs:
        !this.#originKnown || now === null ? 0 : Math.max(0, now - this.#startedAt),
      areasEntered: this.#areasEntered,
      deaths: this.#deaths,
      suicides: this.#suicides,
      characterLevel: this.#readLevel()
    }
  }

  /** `Date.now()` when counting began. Fixed for the life of this instance. */
  get startedAt(): number {
    return this.#startedAt
  }

  /** True while attached to the bus. */
  get running(): boolean {
    return this.#subscribed
  }

  /** Subscribes to a channel. Mirrors `TypedEmitter.on`. */
  on<K extends keyof SessionStatsEventMap>(
    channel: K,
    listener: EventListener<SessionStatsEventMap, K>
  ): this {
    this.#emitter.on(channel, listener)
    return this
  }

  /** Removes one registration of `listener`. Mirrors `TypedEmitter.off`. */
  off<K extends keyof SessionStatsEventMap>(
    channel: K,
    listener: EventListener<SessionStatsEventMap, K>
  ): this {
    this.#emitter.off(channel, listener)
    return this
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribes to the bus. Called by the constructor; idempotent.
   *
   * `death` rather than `death:self`, and the filtering is done here. The pre-filtered
   * channel would work, but `TypedEmitter.emit` stops at the first listener that throws,
   * and `death:self` is the replay clipper's channel - the one place in the app that
   * talks to a socket while holding the tail loop's thread. A counter must not be
   * reachable only via the noisiest listener in the graph. `death` currently has no other
   * subscriber at all.
   */
  start(): this {
    if (this.#subscribed) return this
    this.#subscribed = true
    this.#bus.on('zone-entered', this.#onZoneEntered)
    this.#bus.on('death', this.#onDeath)
    this.#bus.on('character-changed', this.#onCharacterChanged)
    return this
  }

  /**
   * Detaches from the bus. Idempotent.
   *
   * The counts are deliberately LEFT AS IS: they are still what this session saw, and
   * `stats:session` may well be answered once more on the way down.
   */
  stop(): this {
    if (!this.#subscribed) return this
    this.#subscribed = false
    this.#bus.off('zone-entered', this.#onZoneEntered)
    this.#bus.off('death', this.#onDeath)
    this.#bus.off('character-changed', this.#onCharacterChanged)
    return this
  }

  // -------------------------------------------------------------------------
  // Counting
  // -------------------------------------------------------------------------

  /**
   * Counts one area entry.
   *
   * Public so a producer that is not the bus (the debug CLI, a test) can drive the
   * counter directly. NEVER THROWS.
   *
   * EVERY zone counts - towns and hideouts included. The `zone-entered` line carries
   * nothing that separates them, and the only field that hints at it (`seed === 1`, on
   * the PAIRED `area-generated`) is not always present. Inventing a rule would make this
   * number disagree with the event feed rendered beside it, and a stat the user can
   * visibly falsify is worse than a stat that counts more than they expected.
   */
  handleZoneEntered(event: ZoneEnteredEvent): void {
    // "This session", not "this log file" - see the file header.
    if (event.backlog) return
    this.#areasEntered += 1
    this.#announce()
  }

  /**
   * Counts one death, if it was ours.
   *
   * Public for the same reason {@link handleZoneEntered} is. NEVER THROWS.
   *
   * TWO FILTERS, AND THEY ARE NOT THE SAME FILTER:
   *  - `isSelf` decides whether it is COUNTED AT ALL. `death` carries party members'
   *    deaths too, and someone else dying next to you is not a death of yours. With no
   *    character resolved every `isSelf` is false and this stays 0 - the same condition
   *    that leaves the clipper idle, which the UI shouts about elsewhere.
   *  - `cause` decides WHICH counter, not whether to count. A `/kill` is a real death and
   *    `src/shared/events.ts` is explicit that death counts include it; it goes into
   *    {@link SessionStatsSnapshot.deaths} AND into `suicides`, so the difference between
   *    the two is exactly the set of deaths that could have become a clip. Dropping
   *    suicides from the total instead would make the stat strip disagree with the event
   *    feed sitting under it.
   */
  handleDeath(event: DeathEvent): void {
    if (event.backlog) return
    if (!event.isSelf) return

    this.#deaths += 1
    if (event.cause === 'suicide') this.#suicides += 1

    this.#announce()
  }

  /**
   * Re-reads the character and announces if the level moved.
   *
   * Wired to `character-changed` because {@link SessionStatsSnapshot.characterLevel} is
   * read live rather than stored: without this, a level-up would not reach the window
   * until the next area or death happened to push a snapshot, and the stat strip would sit
   * one level behind for as long as the player stayed in the map.
   *
   * Nothing is counted here. NEVER THROWS.
   */
  refreshCharacter(): void {
    this.#announce()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Announces the snapshot, but only when something MATERIAL changed. Contained: this
   * runs on the tail loop's thread of control.
   */
  #announce(): void {
    const next = this.snapshot
    if (sameStats(this.#lastEmitted, next)) return

    // Recorded BEFORE emitting, so a throwing listener cannot make the next event
    // re-announce a value the healthy listeners already received.
    this.#lastEmitted = next
    try {
      this.#emitter.emit('stats', next)
    } catch (error) {
      this.#report(error)
    }
  }

  /**
   * The active character's level, or null when it is unknown or unreadable.
   *
   * `active()` is documented as never throwing; the guard is here because this runs
   * inside the tail loop, and because a level of `NaN` (a hand-edited settings.json that
   * `validateSettings` let through as a number) must read as "unknown" rather than
   * serialise across IPC as `null` from one side and render as `NaN` on the other.
   */
  #readLevel(): number | null {
    try {
      const level = this.#characters.active().level
      if (level === null || !Number.isFinite(level)) return null
      return level
    } catch (error) {
      this.#report(error)
      return null
    }
  }

  /** The clock, contained. `null` means "could not be read", never a substitute number. */
  #now(): number | null {
    try {
      const value = this.#clock()
      return Number.isFinite(value) ? value : null
    } catch (error) {
      this.#report(error)
      return null
    }
  }

  /** Reports a swallowed failure. Infallible: it is the last line of defence. */
  #report(error: unknown): void {
    try {
      this.#onError(error)
    } catch {
      // Nowhere left to send it, and crashing the tail loop is not an option.
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Whether two snapshots say the same thing.
 *
 * `uptimeMs` IS DELIBERATELY NOT COMPARED. It differs between any two reads taken a
 * millisecond apart, so including it would make every comparison false and turn the
 * dedupe in `#announce` into a no-op - which would be harmless for zone entries and
 * fatal for `character-changed`, a channel that fires whenever an override is re-saved.
 * The renderer ticks its own clock from `startedAt`; this channel reports events.
 */
function sameStats(a: SessionStatsSnapshot, b: SessionStatsSnapshot): boolean {
  return (
    a.startedAt === b.startedAt &&
    a.areasEntered === b.areasEntered &&
    a.deaths === b.deaths &&
    a.suicides === b.suicides &&
    a.characterLevel === b.characterLevel
  )
}
