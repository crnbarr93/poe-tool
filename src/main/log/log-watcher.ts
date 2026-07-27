/**
 * src/main/log/log-watcher.ts
 * ===========================
 *
 * The poll loop. This is the only moving part of the log pipeline: it owns a
 * timer, a {@link LogReader}, and the decision of what a read result MEANS.
 *
 * ```text
 *   setInterval ──► readDelta() ──► parseLine() ──► bus
 *        │              │
 *        └─ status ◄────┘   (idle / tailing / file-missing / rotated / read-error)
 * ```
 *
 * RULES FOR THIS FILE:
 *  - No `electron`. `node:` timers only (which are globals here), so this runs
 *    under plain node, under vitest and under the `tail:debug` build.
 *  - No `any`, no `@ts-ignore`.
 *  - EVERY dependency is injected through the constructor. No module-level
 *    singletons, no reaching for a global settings object: the watcher is handed
 *    a bus and a `getSettings` reader and knows nothing else about the app.
 *  - NOTHING may escape the tick. `parseLine` is total and `LogReader` never
 *    throws, but a BUS LISTENER can - `TypedEmitter` deliberately propagates a
 *    throwing listener to the emitter (see its header). An uncaught throw inside
 *    a `setInterval` callback takes the Electron main process down, so every
 *    `emit` here is wrapped and reported through {@link LogWatcherOptions.onError}.
 *
 *
 * WHY `setInterval` + A SKIP FLAG, NOT A SELF-RESCHEDULING `setTimeout`
 * ---------------------------------------------------------------------
 * A tick is asynchronous (open + fstat + read + close). On a stalled disk, or
 * while draining a large post-rotation backlog, one tick can outlast the poll
 * interval. Two behaviours are possible and only one is acceptable:
 *
 *  - STACK: let the next timer start a second concurrent tick. `LogReader` would
 *    keep this SAFE (it serialises internally) but not free - the queued reads
 *    pile up behind the slow one and the watcher falls further behind while
 *    holding N pending promises.
 *  - SKIP (what we do): {@link #ticking} is set for the duration of a tick and the
 *    timer callback returns immediately while it is set. A slow tick simply
 *    misses beats and the loop self-limits to one read in flight. Nothing is
 *    lost: the reader is a byte cursor, so a skipped beat only means the NEXT
 *    read has a slightly larger delta.
 *
 * A self-rescheduling `setTimeout` would also avoid stacking, but it makes the
 * poll period drift by the duration of each tick and makes "the interval
 * changed, restart" harder to reason about. A fixed interval plus a skip flag is
 * the same guarantee with a stable period.
 *
 *
 * STATUS IS EMITTED ON CHANGE, NEVER PER TICK
 * -------------------------------------------
 * At the default 500ms the loop wakes twice a second, forever. Emitting a status
 * every tick would push ~172k IPC messages a day into a renderer that only wants
 * to render a coloured dot, and would make "file is missing" indistinguishable
 * from "file is missing and something is wrong" in a log.
 *
 * So {@link #setStatus} compares the candidate against the last EMITTED status
 * field-by-field ({@link sameStatus}) and stays silent when nothing moved. Two
 * details make that comparison meaningful rather than accidentally always-true or
 * always-false:
 *
 *  - `since` is INHERITED while the `state` is unchanged (see {@link #since}). It
 *    means "when this state was entered", not "now", so a quiet `tailing` tick
 *    produces a byte-identical object.
 *  - `offset` / `linesRead` / `lastLineAt` DO change when lines arrive, and that
 *    is a real change the UI wants. So a busy tail emits, a quiet tail does not,
 *    and a missing file emits exactly once no matter how long it stays missing.
 *
 *
 * BACKLOG
 * -------
 * The app NEVER replays history: {@link start} calls `seekToEnd()` first, so a
 * launch after a six-hour session does not fire six hours of stale deaths (and,
 * for anything that forgot its `backlog` guard, six hours of stale clips).
 *
 * Pre-existing bytes are read in exactly two situations - a ROTATION (the file was
 * truncated or replaced and the reader re-read the new file from offset 0) and a
 * file that was MISSING at attach time and later appeared with content already in
 * it (a locked or late-mounted drive, a restored install). `LogReader` owns both
 * cases and reports them as `LogReadResult.backlog`, which stays true for as long
 * as the drain takes rather than only on the first chunk. This class copies that
 * flag straight onto every event, so side-effecting consumers suppress the lot.
 *
 * {@link replay} is the deliberate exception, and it is for the `tail:debug` CLI
 * only: it reads from offset 0 with `backlog: true` so side-effecting consumers
 * (the replay clipper above all) skip every event it produces.
 *
 *
 * WHO IS "ME" IS RESOLVED PER LINE, NOT PER TICK
 * ----------------------------------------------
 * `parseLine` needs the resolved active character name to compute
 * `DeathEvent.isSelf`, and the ONLY evidence of who that is arrives IN THE LOG, on
 * a level-up line (see `LevelUpEvent`). So the answer can change halfway through a
 * batch of lines, and this class asks {@link CharacterSource} for it immediately
 * before each `parseLine` call rather than sampling it once per tick.
 *
 * That is what makes a level-up encountered mid-stream take effect for the deaths
 * that FOLLOW it, and it is correct BY CONSTRUCTION rather than by luck: lines are
 * decoded in file order and handed over strictly one at a time, synchronously, so
 * ingesting line N's level-up before line N+1 is parsed is the only possible
 * interleaving. There is no window in which a later line could be parsed against an
 * earlier answer, and equally no way for a level-up to retroactively change a line
 * that was already parsed - a death logged BEFORE the first level-up stays
 * `isSelf: false`, which is exactly right, because at that instant we genuinely did
 * not know.
 */

import type {
  ActiveCharacter,
  LevelUpEvent,
  ParseResult,
  PoeEventMap,
  WatcherState,
  WatcherStatus
} from '../../shared/events'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import { LogReader, type LogReadResult, type LogReadStatus } from './log-reader'
import { parseLine } from './parse-line'

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/**
 * The slice of the application event bus the watcher needs.
 *
 * DELIBERATELY JUST `emit`. `src/main/events/event-bus.ts` builds `EventBus` on
 * `TypedEmitter<PoeEventMap>`, whose `emit` has exactly this signature, so the
 * concrete bus satisfies this structurally with no adapter. Depending on the
 * narrowest possible surface also means the watcher can be unit-tested against a
 * bare `TypedEmitter<PoeEventMap>` - no bus construction, no listener registry to
 * stand up.
 */
export interface WatcherBus {
  emit<K extends keyof PoeEventMap>(channel: K, ...args: PoeEventMap[K]): boolean
}

/**
 * The slice of {@link LogReader} the watcher drives.
 *
 * Exists so {@link LogWatcherOptions.createReader} can substitute a reader in
 * tests (a reader whose `readDelta` can be held open is the only way to exercise
 * the overlap guard deterministically). Production always gets the real
 * `LogReader`.
 */
export interface LogReaderLike {
  /** Absolute path this reader was built for. */
  readonly path: string
  /** Bytes consumed so far; feeds `WatcherTailingStatus.offset`. */
  readonly offset: number
  readDelta(): Promise<LogReadResult>
  seekToEnd(): Promise<LogReadResult>
  seekToStart(): void
}

/**
 * The slice of the character tracker the watcher drives.
 *
 * TWO HALVES OF ONE LOOP, which is why they are one interface rather than two
 * options: the watcher READS the current answer to stamp `isSelf` onto a line, and
 * WRITES back the level-up lines that change that answer. Splitting them would let
 * a caller wire up one direction and silently get a detector that never learns, or
 * a learner nobody ever asks.
 *
 * DELIBERATELY STRUCTURAL, in the same style as {@link WatcherBus} and
 * `ZoneTrackerBus`: `src/main/log/character-tracker.ts` satisfies this as-is with no
 * adapter, and a test can satisfy it with a six-line stub instead of standing up a
 * settings store.
 *
 * THE RESOLUTION RULE IS NOT HERE. Which name wins - manual override, else
 * auto-detected, else none - belongs to the tracker (see `ActiveCharacter`), and
 * this file must never re-derive it. The watcher takes whatever `active.name` says
 * and does not interpret it.
 */
export interface CharacterSource {
  /**
   * The resolved active character RIGHT NOW. `name` is null when nothing is
   * configured and nothing has ever been detected, which forces every
   * `DeathEvent.isSelf` to false - see {@link LogWatcher} for why that is a refusal
   * rather than a fallback.
   *
   * Read once per LINE, so it must be cheap and must never throw.
   */
  readonly active: ActiveCharacter
  /**
   * Ingests a level-up so that the lines AFTER it resolve against the character it
   * names. Called before the event is published, and called for backlog lines too -
   * see {@link LogWatcher}.
   *
   * Must never throw; the watcher contains it anyway, because a detector that
   * failed must not be able to stop the tail.
   */
  handleLevelUp(event: LevelUpEvent): void
}

/** Everything {@link LogWatcher} needs. All of it explicit; none of it global. */
export interface LogWatcherOptions {
  /** Where parsed events and status changes go. */
  readonly bus: WatcherBus
  /**
   * Reads the CURRENT settings. Called at the top of every tick rather than
   * captured once, which is what makes live reconfiguration work: the watcher
   * notices a changed `log.path` / `log.pollIntervalMs` on its own and restarts.
   *
   * NOT where the character name comes from - that is {@link characters}, which
   * resolves `settings.character` itself and is consulted per LINE rather than per
   * tick.
   *
   * Must not throw. If it does, the last good snapshot is reused and the error is
   * reported - the tail loop is not allowed to die because settings were briefly
   * unreadable.
   */
  readonly getSettings: () => AppSettings
  /**
   * Who counts as "me", and where level-ups go so that answer can change.
   *
   * OPTIONAL, BUT THE APP MUST ALWAYS SUPPLY ONE. Omitting it does not fall back to
   * reading `settings.character` here - there is exactly one implementation of the
   * override-then-detected priority rule and it is not in this file. With no source
   * the watcher has no answer, so every `DeathEvent.isSelf` is false and the replay
   * clipper stays idle for the whole session. That is the safe direction to fail
   * (never a clip of a party member's death) but it IS a silent one, which is why
   * `src/main/index.ts` wires this unconditionally.
   */
  readonly characters?: CharacterSource
  /**
   * Overrides how a {@link ParseResult} reaches the bus.
   *
   * Omit it and the watcher fans out itself (see {@link LogWatcher} for the
   * contract it implements). Supply it - e.g. `(r) => eventBus.publish(r)` - when
   * the bus wants to own fan-out, so that anything it does around publishing
   * (like maintaining the ring buffer behind the `events:recent` IPC call) is not
   * bypassed. The watcher does not care which; it just hands over the result.
   */
  readonly publish?: (result: ParseResult) => void
  /**
   * Builds the reader for a path. Defaults to `new LogReader(path)`. This is a
   * test seam, not a production knob.
   */
  readonly createReader?: (path: string) => LogReaderLike
  /**
   * Called with anything thrown by a bus listener, by `getSettings`, or by a
   * publish override. Defaults to a no-op.
   *
   * There is no `error` channel on the bus ON PURPOSE (see `PoeEventMap`), so
   * this callback is the only way these surface. Wire it to a logger in
   * `src/main/index.ts`; leave it out in tests that do not care.
   */
  readonly onError?: (error: unknown) => void
}

/** What {@link LogWatcher.replay} reports back to the debug CLI. */
export interface ReplayResult {
  /** Complete lines read from the file, including ones that matched nothing. */
  readonly linesRead: number
  /** How many of those became a recognised `PoeEvent` rather than an `UnmatchedLine`. */
  readonly eventsPublished: number
  /** `ok` once the whole file was drained; otherwise why it stopped. */
  readonly status: LogReadStatus
  /** `error.message` when `status !== 'ok'`, else null. */
  readonly error: string | null
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * Tails Client.txt and publishes what it finds.
 *
 * ```ts
 * const watcher = new LogWatcher({ bus, getSettings: () => store.settings })
 * await watcher.start()
 * // ... later, after settings:set
 * await watcher.reconfigure()
 * // ... on app quit
 * watcher.stop()
 * ```
 *
 * DEFAULT FAN-OUT (when {@link LogWatcherOptions.publish} is not supplied) follows
 * the contract documented on `PoeEventMap`:
 *  - every recognised event goes to `event` AND to its per-type channel;
 *  - a death additionally goes to `death:self` when `isSelf`, so the replay
 *    clipper never has to know the character-name setting exists;
 *  - unrecognised lines go to `unmatched` and nowhere else.
 *  - `zone-changed` and `character-changed` are NOT emitted here. Those are derived
 *    state and belong to `zone-tracker.ts` and `character-tracker.ts`.
 *
 * THE CHARACTER TRACKER IS FED DIRECTLY, IN ADDITION TO ITS OWN BUS SUBSCRIPTION.
 * `character-tracker.ts` subscribes to `level-up` the way `zone-tracker.ts`
 * subscribes to `zone-entered`, and that subscription is the right thing for every
 * OTHER producer on the bus. It is not enough for this one, for two reasons:
 *  - ORDERING. The tracker has to be current before the NEXT line is parsed. Via the
 *    bus that would depend on fan-out order, and on
 *    {@link LogWatcherOptions.publish} reaching the bus at all - which it need not,
 *    since the publish override may send results anywhere.
 *  - CONTAINMENT. `TypedEmitter.emit` stops dispatching a channel once a listener
 *    throws, so one broken `level-up` listener registered ahead of the tracker would
 *    silently stop detection - i.e. stop all clipping - for the rest of the session.
 * Feeding it here makes the update a step in the pipeline rather than an observation
 * of it. Driving both paths for the same line is a deliberate no-op: `handleLevelUp`
 * is idempotent (it re-persists nothing and re-announces nothing when the detection
 * has not moved), which is what makes the belt and the braces safe to wear together.
 */
export class LogWatcher {
  readonly #bus: WatcherBus
  readonly #getSettings: () => AppSettings
  readonly #createReader: (path: string) => LogReaderLike
  readonly #onError: (error: unknown) => void
  readonly #publish: (result: ParseResult) => void

  /** Null when no source was injected; then `isSelf` is false for every line. */
  readonly #characters: CharacterSource | null

  /** Null whenever no path is configured, and between {@link stop} and {@link start}. */
  #reader: LogReaderLike | null = null

  /** Handle for the poll timer, or null when not polling. */
  #timer: ReturnType<typeof setInterval> | null = null

  /** True between {@link start} and {@link stop}. */
  #running = false

  /** THE OVERLAP GUARD. True while a tick is in flight; the timer skips instead of stacking. */
  #ticking = false

  /**
   * Bumped by every {@link start}, {@link stop} and restart. A tick captures it
   * before awaiting and discards its result if it no longer matches - otherwise a
   * read that was in flight when the path changed would be attributed to the new
   * file, and a read in flight during `stop()` would emit after the watcher was
   * meant to be silent.
   */
  #generation = 0

  /** The `log.path` currently applied. Compared against settings to detect reconfiguration. */
  #path: string | null = null

  /** The `log.pollIntervalMs` currently applied, stored RAW (see {@link #installTimer}). */
  #pollIntervalMs: number = DEFAULT_SETTINGS.log.pollIntervalMs

  /** Last snapshot `getSettings()` returned successfully; the fallback if it throws. */
  #lastSettings: AppSettings = DEFAULT_SETTINGS

  /** Lines decoded since the current attach. Reset by every restart. */
  #linesRead = 0

  /** `Date.now()` of the most recent decoded line, or null if none yet. */
  #lastLineAt: number | null = null

  /** Current status - always up to date, whether or not it was emitted. */
  #status: WatcherStatus

  /** Last status actually put on the bus. Null until the first emit. */
  #emitted: WatcherStatus | null = null

  constructor(options: LogWatcherOptions) {
    this.#bus = options.bus
    this.#getSettings = options.getSettings
    this.#createReader = options.createReader ?? ((path) => new LogReader(path))
    this.#onError = options.onError ?? (() => undefined)
    this.#publish = options.publish ?? ((result) => this.#fanOut(result))
    this.#characters = options.characters ?? null
    this.#status = { state: 'idle', path: null, since: Date.now() }
  }

  /** The current status, also served straight to the `log:status` IPC call. */
  get status(): WatcherStatus {
    return this.#status
  }

  /** True between {@link start} and {@link stop}. */
  get running(): boolean {
    return this.#running
  }

  /** The path currently applied, or null when none is configured. */
  get path(): string | null {
    return this.#path
  }

  /**
   * Attaches to the configured log and begins polling.
   *
   * Resolves once the initial `seekToEnd()` has completed and the timer is armed,
   * so a caller that awaits it knows the watcher is live. Calling it while already
   * running is a no-op (use {@link reconfigure} to pick up changed settings).
   *
   * With no path configured this still starts the timer - the ticks do no I/O at
   * all, they only re-read settings, which is how the watcher notices the moment a
   * path is chosen even if nobody calls {@link reconfigure}.
   */
  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    await this.#restart()
  }

  /**
   * Stops polling and drops the reader. Idempotent: calling it twice, or before
   * {@link start}, leaves no timer behind and emits nothing the second time.
   *
   * A tick that is mid-read when this lands finishes its `readDelta` (the promise
   * is already in flight and cannot be cancelled) but its result is discarded on
   * the generation check, so nothing is published after `stop()` returns.
   */
  stop(): void {
    // Invalidate in-flight work FIRST, so anything that resumes after this point
    // sees a stale generation.
    this.#generation++
    const wasRunning = this.#running
    this.#running = false
    this.#clearTimer()
    this.#reader = null
    if (!wasRunning) return
    this.#setStatus({ state: 'idle', path: this.#path, since: this.#since('idle') })
  }

  /**
   * Re-reads settings and restarts the tail if the path or poll interval moved.
   *
   * Safe (and intended) to call unconditionally from the `settings:set` handler:
   * it compares first and does nothing when the change was unrelated, so editing
   * the OBS password does not tear down a healthy tail. Changing the character
   * override needs no restart at all: the watcher does not hold that value, it asks
   * {@link LogWatcherOptions.characters} for the resolved answer line by line.
   *
   * A no-op while stopped.
   */
  async reconfigure(): Promise<void> {
    if (!this.#running) return
    if (!this.#settingsMoved(this.#readSettings())) return
    await this.#restart()
  }

  /**
   * Reads a file from offset 0 and publishes every line with `backlog: true`.
   *
   * FOR `src/main/tools/tail-debug.ts` ONLY. `backlog: true` is what makes it safe:
   * every side-effecting consumer early-returns on it, so replaying a 100MB
   * Client.txt cannot fire a single OBS save.
   *
   * Independent of the live tail - it builds its own reader, does not touch the
   * watcher's offset, and emits no `watcher-status` (a debug replay is not a
   * statement about the state of the live tail). Works whether or not
   * {@link start} was called.
   *
   * Drains in `LogReader`-sized chunks until a read consumes nothing, so a file
   * far larger than memory is streamed rather than slurped.
   *
   * FEEDS THE CHARACTER TRACKER exactly like the live tail does, which is the whole
   * point of routing the debug CLI through here: replaying a real Client.txt has to
   * arrive at the same active character - and therefore the same `isSelf` on the
   * same deaths - that the app would have arrived at while tailing it live. A replay
   * that resolved the character differently from production would be a debugging
   * tool that lies about the thing it exists to verify.
   */
  async replay(path: string): Promise<ReplayResult> {
    const reader = this.#createReader(path)
    // A fresh reader is already at 0; explicit so a factory that hands back a
    // pooled reader cannot silently start mid-file.
    reader.seekToStart()

    let linesRead = 0
    let eventsPublished = 0

    for (;;) {
      const result = await reader.readDelta()
      if (result.status !== 'ok') {
        return { linesRead, eventsPublished, status: result.status, error: result.error ?? null }
      }

      if (result.lines.length > 0) {
        const detectedAt = Date.now()
        for (const line of result.lines) {
          linesRead++
          // Resolved per line, and the tracker updated before the next one - see
          // #parseAndDeliver and the file header.
          const parsed = this.#parseAndDeliver(line, detectedAt, true)
          if (parsed.type !== 'unmatched') eventsPublished++
        }
      }

      // Nothing left to consume. Note this cannot spin: a zero-byte read is the
      // only exit and any non-zero read has made progress through the file.
      if (result.bytesRead === 0) {
        return { linesRead, eventsPublished, status: 'ok', error: null }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle internals
  // -------------------------------------------------------------------------

  /**
   * Tears the tail down and builds it again from current settings: new reader,
   * fresh counters, fresh timer.
   *
   * The generation captured at the top is re-checked after the `await`, because
   * `stop()` or another restart can land while `seekToEnd()` is in flight. Without
   * that check a stopped watcher would arm a timer and start tailing again.
   */
  async #restart(): Promise<void> {
    const generation = ++this.#generation
    this.#clearTimer()
    this.#reader = null

    const settings = this.#readSettings()
    this.#path = settings.log.path
    this.#pollIntervalMs = settings.log.pollIntervalMs
    this.#linesRead = 0
    this.#lastLineAt = null

    if (this.#path === null) {
      this.#setStatus({ state: 'idle', path: null, since: this.#since('idle') })
    } else {
      const reader = this.#createReader(this.#path)
      // NEVER replay history in the app - see the file header.
      const seek = await reader.seekToEnd()
      if (this.#stale(generation)) return
      this.#reader = reader
      this.#handleReadResult(reader, seek, 0)
    }

    if (this.#stale(generation)) return
    this.#installTimer()
  }

  /** True when a start/stop/restart has happened since `generation` was captured. */
  #stale(generation: number): boolean {
    return generation !== this.#generation || !this.#running
  }

  #installTimer(): void {
    this.#clearTimer()
    // `validateSettings` already clamps this to 100..10000, but the watcher must
    // not be able to arm a 0ms (or NaN) interval just because someone constructed
    // an AppSettings by hand. Normalised HERE rather than in #restart so that the
    // reconfiguration comparison still sees the raw configured value - normalising
    // before the comparison would make raw != normalised and restart forever.
    const period =
      Number.isFinite(this.#pollIntervalMs) && this.#pollIntervalMs >= 1
        ? Math.floor(this.#pollIntervalMs)
        : DEFAULT_SETTINGS.log.pollIntervalMs
    this.#timer = setInterval(() => {
      this.#tick()
    }, period)
  }

  #clearTimer(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /**
   * Timer callback. Synchronous by necessity (`setInterval` ignores a returned
   * promise), so it starts the async tick and attaches the terminal handlers that
   * guarantee {@link #ticking} is released and nothing escapes.
   */
  #tick(): void {
    if (this.#ticking) return // OVERLAP GUARD: skip this beat, do not stack.
    this.#ticking = true
    void this.#runTick(this.#generation)
      .catch((error: unknown) => {
        this.#report(error)
      })
      .finally(() => {
        this.#ticking = false
      })
  }

  async #runTick(generation: number): Promise<void> {
    const settings = this.#readSettings()

    // Live reconfiguration. Checked before the read so a changed path never gets
    // a delta from the old file attributed to it.
    if (this.#settingsMoved(settings)) {
      await this.#restart()
      return
    }

    const reader = this.#reader
    if (reader === null) return // Idle: nothing configured. Zero I/O this tick.

    const previousOffset = reader.offset
    const result = await reader.readDelta()
    if (this.#stale(generation)) return // Stopped or restarted mid-read; drop it.

    this.#handleReadResult(reader, result, previousOffset)
  }

  /** True when `log.path` or `log.pollIntervalMs` differ from what is applied. */
  #settingsMoved(settings: AppSettings): boolean {
    return (
      settings.log.path !== this.#path || settings.log.pollIntervalMs !== this.#pollIntervalMs
    )
  }

  /**
   * Turns one {@link LogReadResult} into published events plus a status.
   *
   * Shared by the tick and by the initial `seekToEnd()` in {@link #restart}, which
   * is why it takes the reader rather than reading `this.#reader`: during startup
   * the reader is not installed yet.
   */
  #handleReadResult(reader: LogReaderLike, result: LogReadResult, previousOffset: number): void {
    const path = reader.path

    if (result.status === 'file-missing') {
      // EXPECTED, not an error: the game simply is not running. Reported once
      // thanks to the dedupe in #setStatus, then the loop keeps polling quietly -
      // one failed `open()` per interval, which is why this cannot spin the CPU.
      this.#setStatus({
        state: 'file-missing',
        path,
        since: this.#since('file-missing'),
        message: result.error ?? `No log file at ${path}`
      })
      return
    }

    if (result.status === 'read-error') {
      this.#setStatus({
        state: 'read-error',
        path,
        offset: reader.offset,
        since: this.#since('read-error'),
        message: result.error ?? 'Log read failed',
        code: result.code ?? null
      })
      return
    }

    if (result.rotated) {
      // The reader zeroed its offset and re-read the replacement file inside this
      // same call, so "the offset we resumed from" is what it had before those
      // bytes - derived rather than hardcoded to 0.
      this.#setStatus({
        state: 'rotated',
        path,
        previousOffset,
        offset: reader.offset - result.bytesRead,
        since: this.#since('rotated'),
        message: `Log file was replaced or truncated at offset ${previousOffset}; re-reading from the start.`
      })
    }

    if (result.lines.length > 0) {
      // One timestamp for the whole batch: they were all read at the same instant,
      // and a per-line `Date.now()` would imply a precision we do not have.
      //
      // The CHARACTER NAME is the opposite case and is resolved per line inside
      // #parseAndDeliver: it is derived from the lines themselves, so a level-up in
      // the middle of this batch has to take effect for the rest of it.
      const detectedAt = Date.now()
      for (const line of result.lines) {
        // `result.backlog`, NOT `result.rotated`. `rotated` is a one-shot status
        // signal that fires only on the call that noticed the reset; the drain that
        // follows it can take many capped reads, and every one of them is still
        // pre-existing content. Using `rotated` here published all but the first
        // chunk of a rotation - and every byte of a file that appeared after being
        // missing - as LIVE, which is precisely what fires clips for hours-old
        // deaths. See `LogReader`'s header.
        this.#parseAndDeliver(line, detectedAt, result.backlog)
      }
      this.#linesRead += result.lines.length
      this.#lastLineAt = detectedAt
    }

    this.#setStatus({
      state: 'tailing',
      path,
      offset: reader.offset,
      since: this.#since('tailing'),
      lastLineAt: this.#lastLineAt,
      linesRead: this.#linesRead
    })
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * THE PER-LINE PIPELINE, and the only place a line becomes an event: resolve who
   * "me" is, parse, teach the tracker, publish. In that order, synchronously, one
   * line at a time.
   *
   * Shared by the live tick and by {@link replay} so the two cannot drift - the
   * whole value of `tail:debug` rests on it resolving characters identically to
   * production.
   *
   * WHY THE ORDER IS WHAT IT IS:
   *  1. RESOLVE FIRST, because `isSelf` must describe what was known when this line
   *     was logged. A level-up on this very line is evidence about the lines AFTER
   *     it, never about itself.
   *  2. INGEST BEFORE PUBLISHING, so that anything reacting to the `level-up` event
   *     (the renderer feed, a future consumer) already sees the new answer, and so
   *     the tracker is current no matter what a listener does.
   *  3. PUBLISH LAST, contained.
   *
   * Backlog lines teach the tracker too. `backlog` means "this existed before we
   * attached", which suppresses SIDE EFFECTS (clips); learning who the player is, is
   * a pure state update, exactly like the zone tracker's. Refusing to learn from it
   * would mean a rotation drain, or a log that appeared after being missing, could
   * contain the only level-up we will see for weeks and we would throw it away.
   *
   * @returns the parse result, so callers can count events without re-parsing.
   */
  #parseAndDeliver(line: string, detectedAt: number, backlog: boolean): ParseResult {
    const result = parseLine(line, { detectedAt, backlog, selfName: this.#activeName() })
    if (result.type === 'level-up') this.#learn(result)
    this.#deliver(result)
    return result
  }

  /**
   * The resolved active character name for the line about to be parsed, or `""`.
   *
   * `""` is `parseLine`'s documented "unconfigured" value and forces `isSelf` false.
   * BOTH paths to it are legitimate and neither is an error: no source was injected,
   * or the source resolved `source: 'none'` because the user has set no override and
   * nothing has ever been detected. A NULL ACTIVE CHARACTER IS NOT AN EXCEPTIONAL
   * CONDITION - it is the state a fresh install starts in, and everything downstream
   * of it simply does nothing.
   *
   * Reading `active` is contained: it is a getter on injected code, so it can throw
   * in principle, and a throw here would be inside the tail loop.
   */
  #activeName(): string {
    const source = this.#characters
    if (source === null) return ''
    try {
      return source.active.name ?? ''
    } catch (error) {
      this.#report(error)
      return ''
    }
  }

  /** Hands a level-up to the character source, absorbing anything it throws. */
  #learn(event: LevelUpEvent): void {
    const source = this.#characters
    if (source === null) return
    try {
      source.handleLevelUp(event)
    } catch (error) {
      // A detector that failed is a session with stale `isSelf`, which is bad. A
      // detector that failed AND killed the tail loop is a dead app, which is worse.
      this.#report(error)
    }
  }

  /** Hands a parse result to the configured publisher, absorbing anything it throws. */
  #deliver(result: ParseResult): void {
    try {
      this.#publish(result)
    } catch (error) {
      this.#report(error)
    }
  }

  /** The default publisher: the fan-out contract documented on `PoeEventMap`. */
  #fanOut(result: ParseResult): void {
    if (result.type === 'unmatched') {
      this.#safeEmit('unmatched', result)
      return
    }

    this.#safeEmit('event', result)

    switch (result.type) {
      case 'death':
        this.#safeEmit('death', result)
        // Pre-filtered stream: the clipper subscribes here and never has to know
        // that a character-name setting exists.
        if (result.isSelf) this.#safeEmit('death:self', result)
        break
      case 'zone-entered':
        this.#safeEmit('zone-entered', result)
        break
      case 'area-generated':
        this.#safeEmit('area-generated', result)
        break
      case 'level-up':
        // No `level-up:self` counterpart, deliberately: a level-up is what
        // ESTABLISHES who "self" is, so pre-filtering it on the current answer would
        // make detection unable to bootstrap. See `PoeEventMap`.
        this.#safeEmit('level-up', result)
        break
    }
  }

  /**
   * `bus.emit` with the throw contained.
   *
   * Per-channel rather than one try/catch around the whole fan-out, so a listener
   * that throws on `event` does not also rob the `death` channel of the same
   * event.
   */
  #safeEmit<K extends keyof PoeEventMap>(channel: K, ...args: PoeEventMap[K]): void {
    try {
      this.#bus.emit(channel, ...args)
    } catch (error) {
      this.#report(error)
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Records the status and emits it only if it differs from the last one emitted.
   *
   * `#status` is updated unconditionally so `get status()` (and therefore the
   * `log:status` IPC call) is always current even when nothing was broadcast.
   */
  #setStatus(next: WatcherStatus): void {
    const previous = this.#emitted
    this.#status = next
    if (previous !== null && sameStatus(previous, next)) return
    this.#emitted = next
    this.#safeEmit('watcher-status', next)
  }

  /**
   * `Date.now()` on a state TRANSITION, the existing value while the state holds.
   *
   * This is what `WatcherStatus.since` means ("when the watcher entered this
   * state"), and it is also what makes {@link sameStatus} able to recognise a
   * quiet tick - a `Date.now()` here would make every status unique and defeat the
   * dedupe entirely.
   */
  #since(state: WatcherState): number {
    return this.#status.state === state ? this.#status.since : Date.now()
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  /** `getSettings()` with a fallback, so a throwing settings source cannot kill the loop. */
  #readSettings(): AppSettings {
    try {
      const settings = this.#getSettings()
      this.#lastSettings = settings
      return settings
    } catch (error) {
      this.#report(error)
      return this.#lastSettings
    }
  }

  /** Reports a swallowed failure. Must itself be infallible - it is the last line of defence. */
  #report(error: unknown): void {
    try {
      this.#onError(error)
    } catch {
      // A throwing error reporter is the end of the road; there is nowhere left to
      // send it and crashing the tail loop is the one outcome we refuse.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Field-by-field equality for {@link WatcherStatus}.
 *
 * Hand-written per variant rather than a generic deep-equal: every variant is a
 * flat record of primitives, so this is both faster and - more importantly -
 * exhaustive at COMPILE time. Add a field to a status interface without adding it
 * here and the `never` check below is unaffected, but add a whole new variant and
 * the default case stops type-checking.
 *
 * The redundant-looking `b.state === '...'` guards are load-bearing: narrowing `a`
 * via the switch tells TypeScript nothing about `b`.
 */
function sameStatus(a: WatcherStatus, b: WatcherStatus): boolean {
  if (a.state !== b.state) return false
  switch (a.state) {
    case 'idle':
      return b.state === 'idle' && a.path === b.path && a.since === b.since
    case 'tailing':
      return (
        b.state === 'tailing' &&
        a.path === b.path &&
        a.offset === b.offset &&
        a.since === b.since &&
        a.lastLineAt === b.lastLineAt &&
        a.linesRead === b.linesRead
      )
    case 'file-missing':
      return (
        b.state === 'file-missing' &&
        a.path === b.path &&
        a.since === b.since &&
        a.message === b.message
      )
    case 'rotated':
      return (
        b.state === 'rotated' &&
        a.path === b.path &&
        a.previousOffset === b.previousOffset &&
        a.offset === b.offset &&
        a.since === b.since &&
        a.message === b.message
      )
    case 'read-error':
      return (
        b.state === 'read-error' &&
        a.path === b.path &&
        a.offset === b.offset &&
        a.since === b.since &&
        a.message === b.message &&
        a.code === b.code
      )
    default: {
      // Exhaustiveness: if a new WatcherStatus variant is added, this stops
      // compiling until it is handled above.
      const unhandled: never = a
      void unhandled
      return false
    }
  }
}
