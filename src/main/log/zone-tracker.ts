/**
 * src/main/log/zone-tracker.ts
 * ============================
 *
 * Derived state: "where is the player right now".
 *
 * Client.txt describes one zone transition with TWO lines that arrive about a second
 * apart, in this order:
 *
 * ```text
 * 2026/07/26 19:28:41 ... [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1
 * 2026/07/26 19:28:42 ... [INFO Client 50396] : You have entered Karui Shores.
 * ```
 *
 * The DEBUG line carries the internal id, the monster level and the layout seed but
 * no readable name; the INFO line carries the readable name and nothing else. Neither
 * alone is a complete answer, so this class buffers the `area-generated` and merges
 * it into the `zone-entered` that follows, producing one {@link CurrentZone} and one
 * `zone-changed` emission per transition.
 *
 * RULES FOR THIS FILE:
 *  - No `electron`. `node:` timers are not used either - the only clock is the
 *    injected {@link ZoneTrackerOptions.clock}, so pairing is testable without waiting.
 *  - No `any`, no `@ts-ignore`.
 *  - NOTHING may escape a listener: this runs inside `TypedEmitter.emit`, which is
 *    driven by the tail loop's `setInterval` callback, where an uncaught throw takes
 *    the main process down.
 *
 *
 * WHY `zone-entered` IS THE TRIGGER AND `area-generated` ONLY ARMS IT
 * -------------------------------------------------------------------
 * `area-generated` fires FIRST and is not, on its own, evidence that the player went
 * anywhere - the client also generates areas the player does not immediately enter.
 * Treating it as a transition would emit `zone-changed` twice per real transition
 * (once with no name, once with one), and the second emission would arrive a whole
 * second later. Consumers that snapshot the zone at a single instant - the replay
 * clipper does exactly that, at death-admission time - would then see a nameless zone
 * for that second. So the DEBUG line arms a pending merge and the INFO line commits it.
 *
 *
 * WHY THE PENDING AREA EXPIRES
 * ----------------------------
 * If a `Generating level ...` line never gets its matching "You have entered" line
 * (it happens: some transitions log only one of the two), the buffered area would sit
 * there and get merged into the NEXT zone the player entered - silently mislabelling
 * a clip with the wrong area id and level. {@link DEFAULT_PAIRING_WINDOW_MS} bounds
 * that: an area older than the window is discarded and the zone is reported with its
 * `areaId` / `areaLevel` / `seed` null, which `CurrentZone` explicitly allows and
 * every consumer already handles.
 *
 * TWO windows are needed, because neither clock alone can bound the pairing.
 *
 * READ TIME ({@link ZoneTrackerOptions.pairingWindowMs}, on `detectedAt`) bounds how
 * long an unpaired area may sit in the buffer while the app runs. `detectedAt` is
 * `Date.now()` at read time and is SHARED by every line in one read, so a paired
 * DEBUG+INFO drained together has a delta of 0 and pairs even with the window closed
 * to nothing.
 *
 * That sharing is also exactly why this window cannot be the only guard: a single
 * `readDelta` can hand over an entire post-rotation drain, or the whole file in
 * `tail:debug` replay - tens of thousands of lines, all stamped with one
 * `detectedAt`. Inside such a batch the read-time delta is ALWAYS 0, so an
 * `area-generated` from hours earlier in the file would merge into a completely
 * unrelated `zone-entered` and mislabel every clip for the rest of the session.
 *
 * IN-FILE TIME ({@link ZoneTrackerOptions.inFileWindowMs}, on `meta.clientMs`) closes
 * that. `clientMs` is milliseconds since the client started: monotonic within one
 * game session, immune to OS clock changes, and ~687ms apart on the ground-truth
 * pair. A delta larger than the window means the two lines are not about the same
 * transition; a NEGATIVE delta means either the lines are out of order or the game
 * restarted between them (`clientMs` resets to ~0), and neither may pair.
 *
 * `meta.timestamp` is used for neither: it is local wall clock with no offset and
 * moves when the OS clock does.
 *
 *
 * BACKLOG IS PROCESSED, NOT SKIPPED
 * ---------------------------------
 * `PoeEventBase.backlog` means "this line existed before we attached". Side effects
 * (clips, sounds) must skip those. This is a PURE STATE UPDATE, so it must NOT skip
 * them - after a rotation re-read, the last zone in the backlog IS the zone the
 * player is standing in, and ignoring it would leave every clip labelled with a stale
 * area for the rest of the session.
 */

import type {
  AreaGeneratedEvent,
  CurrentZone,
  PoeEventMap,
  ZoneEnteredEvent
} from '../../shared/events'

/**
 * How long a buffered `area-generated` stays eligible to be merged into the next
 * `zone-entered`, in ms of `detectedAt`.
 *
 * The real gap is ~1s. 15s is deliberately generous: a slow disk, a skipped poll beat
 * or a large post-rotation drain can stretch it, and the cost of pairing slightly too
 * eagerly (a stale area id on one zone) is much lower than the cost of failing to
 * pair at all (no area id ever, on every zone).
 */
export const DEFAULT_PAIRING_WINDOW_MS = 15_000

/**
 * How far apart the two lines may be IN THE LOG (`meta.clientMs`) and still describe
 * the same transition.
 *
 * Separate from {@link DEFAULT_PAIRING_WINDOW_MS} and NOT derived from it: the read-
 * time window is routinely narrowed (a test may close it to 0 to prove a same-tick
 * pair still merges), while the in-file gap is a property of the game and is always
 * about a second. Tying the two together would make closing the read-time window
 * silently stop all pairing.
 */
export const DEFAULT_IN_FILE_WINDOW_MS = 15_000

/**
 * The slice of the application event bus this class uses.
 *
 * Structural, in the same style as `WatcherBus` and `EventBusPort`: `PoeEventBus`, a
 * bare `TypedEmitter<PoeEventMap>` and a hand-written stub all satisfy it. `on`/`off`
 * return `unknown` because `TypedEmitter` returns `this` for chaining while other
 * emitters return `void` or an unsubscribe function; the tracker ignores all three.
 */
export interface ZoneTrackerBus {
  on<K extends keyof PoeEventMap>(
    channel: K,
    listener: (...args: PoeEventMap[K]) => void
  ): unknown
  off<K extends keyof PoeEventMap>(
    channel: K,
    listener: (...args: PoeEventMap[K]) => void
  ): unknown
  emit<K extends keyof PoeEventMap>(channel: K, ...args: PoeEventMap[K]): boolean
}

/** Constructor arguments. Only the bus is required. */
export interface ZoneTrackerOptions {
  /** Where `area-generated` / `zone-entered` come from and `zone-changed` goes to. */
  readonly bus: ZoneTrackerBus
  /**
   * Source of the `enteredAt` on the initial all-unknown zone. Defaults to `Date.now`.
   *
   * Only the INITIAL zone uses it - every subsequent `enteredAt`, and the pairing
   * window itself, come from the events' own `detectedAt`, which is already a value
   * the caller controls. Injected so a test can assert on a fixed initial timestamp.
   */
  readonly clock?: () => number
  /**
   * READ-TIME window, on `detectedAt`. Defaults to {@link DEFAULT_PAIRING_WINDOW_MS}.
   * Non-finite values fall back to it.
   */
  readonly pairingWindowMs?: number
  /**
   * IN-FILE window, on `meta.clientMs`. Defaults to {@link DEFAULT_IN_FILE_WINDOW_MS}.
   * Non-finite values fall back to it. See the file header for why this is not the
   * same knob as {@link pairingWindowMs}.
   */
  readonly inFileWindowMs?: number
  /**
   * Called when emitting `zone-changed` threw - i.e. when a downstream listener
   * failed. Purely diagnostic; the default is a no-op and a hook that throws is
   * itself ignored.
   */
  readonly onError?: (error: unknown) => void
}

/** A buffered `area-generated`, waiting for the `zone-entered` it belongs to. */
interface PendingArea {
  readonly event: AreaGeneratedEvent
  /** `detectedAt` of that event; the pairing window is measured from here. */
  readonly at: number
}

/**
 * Tracks the current zone and publishes `zone-changed`.
 *
 * ```ts
 * const zones = new ZoneTracker({ bus })
 * const clipper = new ReplayClipper({ ..., getZone: () => zones.current })
 * // on shutdown
 * zones.stop()
 * ```
 *
 * THE CONSTRUCTOR SUBSCRIBES, matching `ReplayClipper`: a tracker that silently never
 * ran would mislabel every clip in the session, which is precisely the failure mode
 * an "and don't forget to call start()" step invites. {@link stop} detaches and
 * {@link start} re-attaches; both are idempotent.
 */
export class ZoneTracker {
  readonly #bus: ZoneTrackerBus
  readonly #clock: () => number
  readonly #pairingWindowMs: number
  readonly #inFileWindowMs: number
  readonly #onError: (error: unknown) => void

  /** Stable identities, so `off` can actually find them again. */
  readonly #onArea: (event: AreaGeneratedEvent) => void
  readonly #onZone: (event: ZoneEnteredEvent) => void

  #subscribed = false
  #pending: PendingArea | null = null
  #current: CurrentZone

  constructor(options: ZoneTrackerOptions) {
    this.#bus = options.bus
    this.#clock = options.clock ?? Date.now
    this.#pairingWindowMs =
      options.pairingWindowMs !== undefined && Number.isFinite(options.pairingWindowMs)
        ? Math.max(0, options.pairingWindowMs)
        : DEFAULT_PAIRING_WINDOW_MS
    this.#inFileWindowMs =
      options.inFileWindowMs !== undefined && Number.isFinite(options.inFileWindowMs)
        ? Math.max(0, options.inFileWindowMs)
        : DEFAULT_IN_FILE_WINDOW_MS
    this.#onError = options.onError ?? ((): void => undefined)

    this.#current = {
      displayName: null,
      areaId: null,
      areaLevel: null,
      seed: null,
      enteredAt: this.#clock()
    }

    this.#onArea = (event: AreaGeneratedEvent): void => {
      this.handleAreaGenerated(event)
    }
    this.#onZone = (event: ZoneEnteredEvent): void => {
      this.handleZoneEntered(event)
    }

    this.start()
  }

  /**
   * The current zone. Never null - before the first `zone-entered` it is the
   * all-unknown zone, which is what `CurrentZone`'s nullable fields are for.
   *
   * Feed straight into `ReplayClipper`'s `getZone`.
   */
  get current(): CurrentZone {
    return this.#current
  }

  /** Subscribes to the bus. Called by the constructor; idempotent. */
  start(): this {
    if (this.#subscribed) return this
    this.#subscribed = true
    this.#bus.on('area-generated', this.#onArea)
    this.#bus.on('zone-entered', this.#onZone)
    return this
  }

  /**
   * Detaches from the bus and drops any half-formed pairing. Idempotent.
   *
   * {@link current} is deliberately LEFT AS IS: it is the last thing we knew, and a
   * shutdown path that blanks it would make a clip that is still mid-move lose its
   * zone metadata.
   */
  stop(): this {
    if (!this.#subscribed) return this
    this.#subscribed = false
    this.#pending = null
    this.#bus.off('area-generated', this.#onArea)
    this.#bus.off('zone-entered', this.#onZone)
    return this
  }

  /** True while attached to the bus. */
  get running(): boolean {
    return this.#subscribed
  }

  /**
   * Buffers an `area-generated` for the `zone-entered` expected ~1s later.
   *
   * Public so a producer that is not the bus (the debug CLI, a test) can drive the
   * tracker directly. NEVER THROWS.
   *
   * A second `area-generated` before any `zone-entered` SUPERSEDES the first: the
   * newest generated area is the one the player is about to be in, and keeping the
   * older one would guarantee a mislabel.
   */
  handleAreaGenerated(event: AreaGeneratedEvent): void {
    this.#pending = { event, at: event.detectedAt }
  }

  /**
   * Commits a zone transition, merging in a buffered `area-generated` when one is
   * present and still inside the pairing window.
   *
   * NEVER THROWS: the `zone-changed` emission is contained, because this runs inside
   * `TypedEmitter.emit` on the tail loop's thread of control.
   */
  handleZoneEntered(event: ZoneEnteredEvent): void {
    const paired = this.#takePending(event)

    this.#current = {
      displayName: event.zoneName,
      areaId: paired?.areaId ?? null,
      areaLevel: paired?.areaLevel ?? null,
      seed: paired?.seed ?? null,
      // `detectedAt` (read time), not `meta.timestamp` (game-logged local wall clock):
      // every other timestamp on `CurrentZone`'s consumers is epoch-ms from the same
      // clock, and mixing the two would make "how long have I been here" nonsense.
      enteredAt: event.detectedAt
    }

    try {
      this.#bus.emit('zone-changed', this.#current)
    } catch (error) {
      this.#report(error)
    }
  }

  /**
   * Consumes the buffered area if it is still eligible, and clears it either way.
   *
   * Cleared even when rejected: a stale area that stayed buffered would keep being
   * re-tested on every subsequent zone and could never become valid again.
   *
   * BOTH clocks have to agree - see the file header. Read time bounds how long the
   * area sat in the buffer, in-file time bounds how far apart the two lines are in
   * the log itself. The second check is the one that survives a whole backlog drain
   * arriving with a single shared `detectedAt`.
   */
  #takePending(event: ZoneEnteredEvent): AreaGeneratedEvent | null {
    const pending = this.#pending
    this.#pending = null
    if (pending === null) return null

    // `detectedAt - pending.at` is 0 for a pair read in the same tick and negative
    // only if the clock jumped backwards between reads; both are "fresh".
    if (event.detectedAt - pending.at > this.#pairingWindowMs) return null

    const inFileDelta = event.meta.clientMs - pending.event.meta.clientMs
    if (!Number.isFinite(inFileDelta)) return null
    // Negative means the zone line PRECEDES its area line in the log, or the game
    // restarted between them (`clientMs` resets to ~0). Neither is a pair.
    if (inFileDelta < 0 || inFileDelta > this.#inFileWindowMs) return null

    return pending.event
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
