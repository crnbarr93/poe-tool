/**
 * src/main/obs/replay-clipper.ts
 * ==============================
 *
 * The death -> clip pipeline. Listens on the bus's `death:self` channel and turns
 * each qualifying death into a saved, renamed, catalogued clip.
 *
 * NO `electron` IMPORT. Everything it needs - the bus, the OBS client, the clip
 * library, the current settings, the current zone - arrives through the constructor,
 * so the whole pipeline runs under plain node and vitest.
 *
 *
 * THE FLOW, AND WHY IT IS SPLIT IN TWO
 * -----------------------------------
 * `handleDeath` runs SYNCHRONOUSLY inside the bus emit, which itself runs inside the
 * log tail loop. Everything that decides WHETHER to clip therefore happens there and
 * only there:
 *
 *   backlog?  ->  a suicide?  ->  clips disabled?  ->  inside the debounce window?
 *
 * and everything that then TAKES TIME (asking OBS, waiting for the file, moving it)
 * is pushed onto an internal promise queue and awaited off the hot path. Two
 * consequences fall out of that split, and both are load-bearing:
 *
 *  1. THE DEBOUNCE WINDOW OPENS AT ADMISSION, not when the save finishes. A leading
 *     edge that only closed after the async work completed would let a burst of five
 *     deaths through while the first save was still in flight.
 *
 *  2. THE ZONE IS SNAPSHOTTED AT ADMISSION. In PoE you die and then resurrect in
 *     town, so `ZoneTracker`'s idea of "where I am" changes within a second or two of
 *     the death line. Reading it after the save came back would routinely name the
 *     clip after the town the player respawned in rather than the zone they died in.
 *     The same goes for the character name and the sidecar setting: the record
 *     describes the moment of death, so it is built from the settings of that moment.
 *
 *
 * WHY THE SUICIDE CHECK COMES BEFORE THE DEBOUNCE
 * ----------------------------------------------
 * `/kill` is a deliberate act - leaving a map instantly, resetting a boss - so it is
 * never a highlight and never becomes a clip (see `DeathCause` in `../../shared/events`).
 * It is dropped in the SECOND admission step, alongside the backlog check and ahead of
 * everything that reads settings, because both of those tests are properties of the
 * DEATH ITSELF rather than of the configuration.
 *
 * That position is not cosmetic. The debounce window is armed at admission, so a
 * suicide admitted into the window would swallow the next five seconds of real deaths -
 * and "`/kill`, respawn in town, run back, die for real" is an ordinary sequence, not a
 * contrived one. Dropping the suicide before `#lastAdmittedAt` is touched keeps the
 * window owned exclusively by deaths that actually produced a clip. The inverse holds
 * too: a suicide inside a window opened by a real death reports itself as a suicide,
 * because it never consults the window at all.
 *
 *
 * SERIALISATION
 * -------------
 * `#queue` is a plain promise chain, one link per admitted death. Two rapid deaths
 * (debounce turned off, or a party wipe with a short window) must not have their
 * moves interleave: `ClipLibrary` probes for a free filename and then renames onto
 * it, and two overlapping moves can both see `…_Karui-Shores.mkv` as free. The chain
 * makes that impossible without the library needing a lock.
 *
 *
 * NOTHING FAILS SILENTLY
 * ----------------------
 * Every path out of this class - including the boring ones - emits exactly one
 * {@link ClipOutcome} on the `outcome` channel, with a message that is safe to render
 * verbatim and names the fix where there is one. The five ways the pipeline can break
 * are distinct members of that union, so the UI can style them differently and a
 * `switch` over them is exhaustive:
 *
 *   obs-not-connected | replay-buffer-inactive | save-rejected | save-timeout | move-failed
 *
 * `replay-buffer-inactive` is the one that matters most in practice - a user whose
 * replay buffer is simply not running gets "clipping does nothing" otherwise, with no
 * indication anywhere that OBS declined. We DO NOT start the replay buffer for them:
 * starting an output on someone's behalf writes to their disk without being asked, so
 * we tell them how to start it instead. That is a deliberate product decision.
 *
 * A `ClipRecord` is ALSO emitted on the `clip` channel whenever one exists at all -
 * including when the move failed. A failed move does not mean "no clip"; it means the
 * clip is still sitting at `record.originalPath`, and the UI has to be able to show it.
 *
 * NO PUBLIC METHOD THROWS OR REJECTS. `handleDeath` is called from an emit loop where
 * a throw would tear down the tail; the queue's tail promise is never left rejected.
 */

import type { CurrentZone, DeathEvent } from '../../shared/events'
import type { ClipRecord } from '../../shared/ipc'
import type { AppSettings, CharacterSettings } from '../../shared/settings'
import { TypedEmitter } from '../events/typed-emitter'
import type { EventListener } from '../events/typed-emitter'
import type { MoveClipOptions } from './clip-library'
import type { ObsError, ObsResult, SavedReplay } from './obs-client'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Used when `settings.clips.debounceMs` is missing or not a finite number.
 * Mirrors `DEFAULT_SETTINGS.clips.debounceMs`; duplicated rather than imported
 * because `src/shared/settings.ts` exports the whole settings object, not the field.
 */
export const DEFAULT_CLIP_DEBOUNCE_MS = 5_000

/** Appended to every "the buffer is not running" message. The actionable half. */
const REPLAY_BUFFER_HELP =
  'Start it in OBS with Controls > Start Replay Buffer (tick Settings > Output > Replay Buffer first ' +
  'if the control is missing). poe-tool never starts the replay buffer for you.'

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/**
 * Wall clock, injected so the debounce window is testable without waiting 6 seconds.
 * Production passes `Date.now`.
 */
export type Clock = () => number

/**
 * The slice of the event bus this class uses.
 *
 * Structural on purpose: `EventBus`, a bare `TypedEmitter<PoeEventMap>` and a
 * hand-written stub all satisfy it, so the clipper's tests do not need the bus and
 * the bus's tests do not need the clipper. Return types are `unknown` because
 * `TypedEmitter` returns `this` for chaining and other emitters return `void` or an
 * unsubscribe function; the clipper ignores all three.
 */
export interface DeathEventSource {
  on(channel: 'death:self', listener: (event: DeathEvent) => void): unknown
  off(channel: 'death:self', listener: (event: DeathEvent) => void): unknown
}

/**
 * The slice of {@link import('./obs-client').ObsClient} this class uses.
 *
 * Note what is NOT here: nothing that STARTS an output. The clipper physically cannot
 * start the replay buffer, which is the strongest possible enforcement of that
 * product decision.
 */
export interface ClipperObsClient {
  /** True when there is a live, identified socket. */
  readonly connected: boolean
  /** True when OBS is on another machine, i.e. its paths are not ours. */
  readonly isRemoteObs: boolean
  /** `GetReplayBufferStatus` -> `outputActive`. Never throws; false on any failure. */
  isReplayBufferActive(): Promise<boolean>
  /** `SaveReplayBuffer` + the `ReplayBufferSaved` path. Never throws. */
  saveReplayBuffer(): Promise<ObsResult<SavedReplay>>
}

/** The slice of {@link import('./clip-library').ClipLibrary} this class uses. */
export interface ClipTarget {
  /** Never rejects: a failed move comes back as a record with `moved: false`. */
  moveClip(options: MoveClipOptions): Promise<ClipRecord>
}

/** Constructor arguments. The four collaborators are required; the rest have defaults. */
export interface ReplayClipperOptions {
  /** Where `death:self` comes from. Subscribed to by the constructor. */
  readonly bus: DeathEventSource
  /** The live OBS connection. */
  readonly obs: ClipperObsClient
  /** Where clips are moved to. */
  readonly library: ClipTarget
  /**
   * Current settings, read fresh on EVERY death - never captured once. The user can
   * toggle `clips.enabled` or change the debounce mid-session and it must take effect
   * without re-wiring anything.
   */
  readonly getSettings: () => AppSettings
  /**
   * The zone tracker's current zone. Called at admission time - see the file header
   * for why that timing is not negotiable.
   */
  readonly getZone: () => CurrentZone
  /** Defaults to `Date.now`. */
  readonly clock?: Clock
  /**
   * Called when a collaborator throws somewhere this class swallowed it. Purely
   * diagnostic - the default is a no-op, and a hook that throws is itself ignored.
   */
  readonly onInternalError?: (error: unknown, context: string) => void
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Fields on every {@link ClipOutcome}. */
interface ClipOutcomeBase {
  /** The death that triggered (or failed to trigger) this clip. */
  readonly death: DeathEvent
  /** {@link Clock} reading when this outcome was decided. */
  readonly at: number
  /** One sentence, human-readable, safe to render verbatim. Never contains a password. */
  readonly message: string
}

/** The clip was saved, renamed and filed. The happy path. */
export interface ClipClippedOutcome extends ClipOutcomeBase {
  readonly kind: 'clipped'
  /** `moved: true`, `finalPath` non-null. May still carry a `note` (e.g. a failed sidecar). */
  readonly record: ClipRecord
}

/**
 * The death came from replaying bytes that were already in the file when we attached.
 * Clipping it would fire a burst of saves for deaths that happened hours ago.
 */
export interface ClipSkippedBacklogOutcome extends ClipOutcomeBase {
  readonly kind: 'skipped-backlog'
}

/**
 * The player typed `/kill`, and PoE logged `<Name> has committed suicide.`
 *
 * NOT A FAILURE. Nothing went wrong: a deliberate suicide is never a highlight, so the
 * clip is skipped on purpose (see `DeathCause` in `../../shared/events`). The death is
 * still a real death everywhere else - it rides the `death` and `death:self` channels
 * and counts towards any statistics - which is exactly why this outcome exists rather
 * than a silent `return`: the user must be able to see that poe-tool noticed the death
 * and chose not to clip it, instead of wondering where their clip went.
 */
export interface ClipSkippedSuicideOutcome extends ClipOutcomeBase {
  readonly kind: 'skipped-suicide'
  /**
   * Who `/kill`ed, i.e. `death.characterName`. Duplicated out of the event so a UI
   * rendering a list of outcomes does not have to reach into `death` for the one field
   * this outcome is about.
   */
  readonly characterName: string
}

/** `settings.clips.enabled` is false. The master switch. */
export interface ClipSkippedDisabledOutcome extends ClipOutcomeBase {
  readonly kind: 'skipped-disabled'
}

/** A previous death opened the debounce window and it has not closed yet. */
export interface ClipSkippedDebouncedOutcome extends ClipOutcomeBase {
  readonly kind: 'skipped-debounced'
  /** The window in force, from `settings.clips.debounceMs`. */
  readonly debounceMs: number
  /** How much longer the window has to run. */
  readonly remainingMs: number
}

/** FAILURE: no live OBS socket, so nothing was even attempted. */
export interface ClipObsNotConnectedOutcome extends ClipOutcomeBase {
  readonly kind: 'obs-not-connected'
}

/**
 * FAILURE: OBS is connected but its replay buffer is not running, so there is no
 * footage to save. The single most common reason clipping "does nothing".
 */
export interface ClipBufferInactiveOutcome extends ClipOutcomeBase {
  readonly kind: 'replay-buffer-inactive'
}

/** FAILURE: OBS refused the `SaveReplayBuffer` request. */
export interface ClipSaveRejectedOutcome extends ClipOutcomeBase {
  readonly kind: 'save-rejected'
  /** The underlying typed error, for callers that want to branch on it. */
  readonly error: ObsError
}

/**
 * FAILURE: the save was accepted but OBS never reported a path.
 * The clip MAY still exist in the OBS recording folder - we just do not know where.
 */
export interface ClipSaveTimedOutOutcome extends ClipOutcomeBase {
  readonly kind: 'save-timeout'
  /** How long we waited for `ReplayBufferSaved`. */
  readonly timeoutMs: number
}

/**
 * FAILURE: OBS wrote the clip but it could not be moved into the library.
 * The file still exists at `record.originalPath` - this is never a lost clip.
 */
export interface ClipMoveFailedOutcome extends ClipOutcomeBase {
  readonly kind: 'move-failed'
  /** `moved: false`, `finalPath: null`, `note` explaining why. */
  readonly record: ClipRecord
}

/**
 * A collaborator threw where its contract says it never does. Should not happen;
 * surfaced rather than swallowed precisely because "should not happen" is not a
 * reason to leave the user staring at nothing.
 */
export interface ClipInternalErrorOutcome extends ClipOutcomeBase {
  readonly kind: 'internal-error'
  /** The thrown value's message, for a log or a support paste. */
  readonly detail: string
}

/**
 * Everything one death can lead to. Exhaustively switchable on `kind`.
 *
 * Discriminated on `kind` to match {@link ObsError} (results and errors use `kind` in
 * this codebase; connection unions use `state` and log events use `type`).
 */
export type ClipOutcome =
  | ClipClippedOutcome
  | ClipSkippedBacklogOutcome
  | ClipSkippedSuicideOutcome
  | ClipSkippedDisabledOutcome
  | ClipSkippedDebouncedOutcome
  | ClipObsNotConnectedOutcome
  | ClipBufferInactiveOutcome
  | ClipSaveRejectedOutcome
  | ClipSaveTimedOutOutcome
  | ClipMoveFailedOutcome
  | ClipInternalErrorOutcome

/** Discriminant of {@link ClipOutcome}. */
export type ClipOutcomeKind = ClipOutcome['kind']

/** The outcomes that mean "the user wanted a clip and did not fully get one". */
const FAILURE_KINDS: ReadonlySet<ClipOutcomeKind> = new Set<ClipOutcomeKind>([
  'obs-not-connected',
  'replay-buffer-inactive',
  'save-rejected',
  'save-timeout',
  'move-failed',
  'internal-error'
])

/**
 * True for outcomes worth showing as an error.
 *
 * Deliberately EXCLUDES all four `skipped-*` kinds: backlog, suicide, disabled and
 * debounced are the pipeline working as designed, not something to alarm the user
 * about. `skipped-suicide` in particular is a DELIBERATE product decision rather than
 * anything going wrong, so it is classified with the other skips - it still reaches the
 * UI, because every outcome does, just not styled as a failure.
 * `move-failed` IS a failure even though the clip exists, because the clip is not
 * where the user was told to look for it.
 */
export function isClipFailure(outcome: ClipOutcome): boolean {
  return FAILURE_KINDS.has(outcome.kind)
}

/**
 * Channels {@link ReplayClipper} emits on.
 *
 * `clip` is the narrow feed for the clip list / `IPC_PUSH.CLIP`; `outcome` is the
 * complete story of every death. A success emits on BOTH (`clip` first), and a
 * `move-failed` also emits on both - see the note about failed moves in the header.
 *
 * No `error` channel, matching `PoeEventMap`: failures are data here too.
 */
export interface ReplayClipperEventMap {
  clip: [ClipRecord]
  outcome: [ClipOutcome]
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** One admitted death, frozen at the instant it was admitted. See the file header. */
interface PendingClip {
  readonly death: DeathEvent
  readonly zone: CurrentZone
  readonly characterName: string
  readonly writeSidecar: boolean
  readonly admittedAt: number
}

/** A message for any thrown value. TOTAL: never throws, for any input. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '') return error.trim()
  return 'unknown error'
}

/** The zone used when the tracker cannot be consulted. Every field unknown. */
function unknownZone(at: number): CurrentZone {
  return { displayName: null, areaId: null, areaLevel: null, seed: null, enteredAt: at }
}

/** `"Karui Shores"` -> `" in Karui Shores"`, unknown zone -> `""`. */
function zonePhrase(zone: CurrentZone): string {
  return zone.displayName === null || zone.displayName.trim() === '' ? '' : ` in ${zone.displayName}`
}

/**
 * The name to stamp on the {@link ClipRecord}: the manual override when there is one,
 * otherwise whatever was auto-detected, otherwise `""`.
 *
 * This is the `ActiveCharacter` priority from `../../shared/events` applied to the raw
 * settings, and it is deliberately NOT re-deciding whose death this was - `death:self`
 * already answered that. It only answers "what do we call the player on this record",
 * which is why "" is an acceptable result: a clip whose owner is unknown is still a
 * clip, and `ClipRecord.characterName` documents `""` as exactly that case.
 *
 * Both fields are already trimmed by `validateSettings`, but `getSettings` is an
 * injected function, so this trims again for the same reason
 * {@link normalizeDebounceMs} re-clamps: a hand-edited settings.json must not be able
 * to put a stray space into a filename or a sidecar.
 */
function resolveCharacterName(character: CharacterSettings): string {
  const override = character.override.trim()
  if (override !== '') return override
  return character.detected?.trim() ?? ''
}

/**
 * Normalises `settings.clips.debounceMs`.
 *
 * `validateSettings` already clamps this to 0..60000, but `getSettings` is an
 * injected function and a negative or `NaN` value must not turn into a window that
 * swallows every death forever. 0 means "no debouncing" and is preserved exactly.
 */
function normalizeDebounceMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CLIP_DEBOUNCE_MS
  return value < 0 ? 0 : value
}

// ---------------------------------------------------------------------------
// ReplayClipper
// ---------------------------------------------------------------------------

/**
 * Turns `death:self` events into clips.
 *
 * ```ts
 * const clipper = new ReplayClipper({
 *   bus,
 *   obs,
 *   library,
 *   getSettings: () => store.current,
 *   getZone: () => zoneTracker.current,
 *   clock: Date.now
 * })
 * clipper.on('clip', (record) => window.webContents.send(IPC_PUSH.CLIP, record))
 * clipper.on('outcome', (outcome) => { if (isClipFailure(outcome)) log.warn(outcome.message) })
 * ```
 *
 * THE CONSTRUCTOR SUBSCRIBES. There is no "and don't forget to call start()" step,
 * because forgetting it would mean the app's headline feature silently never runs -
 * exactly the failure mode this file exists to eliminate. {@link stop} detaches and
 * {@link start} re-attaches, both idempotent.
 */
export class ReplayClipper {
  readonly #emitter = new TypedEmitter<ReplayClipperEventMap>()
  readonly #bus: DeathEventSource
  readonly #obs: ClipperObsClient
  readonly #library: ClipTarget
  readonly #getSettings: () => AppSettings
  readonly #getZone: () => CurrentZone
  readonly #clock: Clock
  readonly #onInternalError: (error: unknown, context: string) => void

  /** Stable identity, so `off` can actually find it again. */
  readonly #listener: (event: DeathEvent) => void

  #subscribed = false
  #disposed = false

  /**
   * {@link Clock} reading of the last ADMITTED death, or null if none yet.
   * Set at admission, not at completion - see the file header.
   */
  #lastAdmittedAt: number | null = null

  /** Tail of the serialisation chain. Never left in a rejected state. */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: ReplayClipperOptions) {
    this.#bus = options.bus
    this.#obs = options.obs
    this.#library = options.library
    this.#getSettings = options.getSettings
    this.#getZone = options.getZone
    this.#clock = options.clock ?? Date.now
    this.#onInternalError = options.onInternalError ?? ((): void => undefined)
    this.#listener = (event: DeathEvent): void => {
      this.handleDeath(event)
    }
    this.start()
  }

  // -------------------------------------------------------------------------
  // Subscription + lifecycle
  // -------------------------------------------------------------------------

  /** Subscribes to `death:self`. Called by the constructor; idempotent. */
  start(): this {
    if (this.#disposed || this.#subscribed) return this
    this.#subscribed = true
    this.#bus.on('death:self', this.#listener)
    return this
  }

  /** Detaches from the bus. Work already queued still finishes. Idempotent. */
  stop(): this {
    if (!this.#subscribed) return this
    this.#subscribed = false
    this.#bus.off('death:self', this.#listener)
    return this
  }

  /**
   * Permanent shutdown: detaches from the bus, lets in-flight work drain (so a clip
   * mid-move is never abandoned half-copied), then drops every subscriber.
   *
   * NEVER REJECTS.
   */
  async dispose(): Promise<void> {
    this.stop()
    this.#disposed = true
    await this.idle()
    this.#emitter.removeAllListeners()
  }

  /** True while attached to the bus. */
  get running(): boolean {
    return this.#subscribed
  }

  /**
   * Resolves once every admitted death has been fully processed.
   *
   * Exists for tests and for a clean shutdown; production code never needs it. Loops
   * because a listener could enqueue more work while we were awaiting the tail.
   *
   * NEVER REJECTS.
   */
  async idle(): Promise<void> {
    let tail = this.#queue
    for (;;) {
      await tail
      if (this.#queue === tail) return
      tail = this.#queue
    }
  }

  /** Subscribes to a channel. Mirrors `TypedEmitter.on`. */
  on<K extends keyof ReplayClipperEventMap>(
    channel: K,
    listener: EventListener<ReplayClipperEventMap, K>
  ): this {
    this.#emitter.on(channel, listener)
    return this
  }

  /** Removes one registration of `listener`. Mirrors `TypedEmitter.off`. */
  off<K extends keyof ReplayClipperEventMap>(
    channel: K,
    listener: EventListener<ReplayClipperEventMap, K>
  ): this {
    this.#emitter.off(channel, listener)
    return this
  }

  // -------------------------------------------------------------------------
  // Admission (synchronous, on the tail loop's thread of control)
  // -------------------------------------------------------------------------

  /**
   * Decides whether `death` deserves a clip and, if so, queues the work.
   *
   * Public so `src/main/index.ts` can drive the clipper directly (a manual "clip now"
   * button, a bus whose shape does not match {@link DeathEventSource}) and so tests
   * can bypass the bus.
   *
   * NEVER THROWS. It is invoked from inside `TypedEmitter.emit`, which propagates
   * listener exceptions to the emitter - and the emitter here is the log tail loop.
   */
  handleDeath(death: DeathEvent): void {
    try {
      if (this.#disposed) return

      // 1. Backlog. A side effect must never fire for a line that was already in the
      //    file before we attached, or launching the app after a long session would
      //    replay every death of that session as a fresh clip.
      if (death.backlog) {
        this.#emitOutcome({
          kind: 'skipped-backlog',
          death,
          at: this.#now(),
          message: `Ignored a historical death of ${death.characterName} read from the existing log; poe-tool only clips deaths that happen while it is running.`
        })
        return
      }

      // 2. `/kill`. A deliberate suicide is never a highlight, so it is dropped here -
      //    BEFORE the settings read and, critically, BEFORE the debounce window is
      //    armed in step 5. See the file header: a `/kill` that consumed the window
      //    would suppress the genuine death that follows it seconds later, which is
      //    the normal shape of "reset the fight, run back in, die properly".
      if (death.cause === 'suicide') {
        this.#emitOutcome({
          kind: 'skipped-suicide',
          death,
          at: this.#now(),
          message: `${death.characterName} used /kill, so no clip was saved. poe-tool only clips deaths the game inflicted; the death still counts everywhere else.`,
          characterName: death.characterName
        })
        return
      }

      // 3. Settings. Read fresh, and a throwing reader is fatal to THIS death: we
      //    cannot know whether clipping is even enabled, and clipping anyway would
      //    ignore a user who turned it off.
      let settings: AppSettings
      try {
        settings = this.#getSettings()
      } catch (error) {
        this.#report(error, 'get-settings')
        this.#emitOutcome({
          kind: 'internal-error',
          death,
          at: this.#now(),
          message: `Could not read the poe-tool settings, so the death of ${death.characterName} was not clipped.`,
          detail: describeError(error)
        })
        return
      }

      // 4. Master switch.
      if (!settings.clips.enabled) {
        this.#emitOutcome({
          kind: 'skipped-disabled',
          death,
          at: this.#now(),
          message: `Death clips are turned off, so the death of ${death.characterName} was not clipped.`
        })
        return
      }

      // 5. Leading-edge debounce: the FIRST death fires immediately, repeats inside
      //    the window are swallowed. A party wipe writes several deaths within a
      //    second and they all belong to one fight, i.e. one clip.
      const at = this.#now()
      const debounceMs = normalizeDebounceMs(settings.clips.debounceMs)
      const last = this.#lastAdmittedAt
      if (last !== null) {
        const elapsed = at - last
        // `elapsed >= 0` guards a backwards clock jump (DST, an NTP correction):
        // without it, a clock that moved back an hour would swallow every death for
        // that hour.
        if (elapsed >= 0 && elapsed < debounceMs) {
          const remainingMs = debounceMs - elapsed
          this.#emitOutcome({
            kind: 'skipped-debounced',
            death,
            at,
            message: `Skipped a second clip for ${death.characterName}: another death was clipped ${elapsed}ms ago and clips are debounced to one per ${debounceMs}ms.`,
            debounceMs,
            remainingMs
          })
          return
        }
      }
      this.#lastAdmittedAt = at

      // 6. Freeze the context NOW - the player is about to resurrect in town.
      this.#enqueue({
        death,
        zone: this.#zoneNow(at),
        characterName: resolveCharacterName(settings.character),
        writeSidecar: settings.clips.writeSidecar,
        admittedAt: at
      })
    } catch (error) {
      // Belt and braces: every step above handles its own failures, so reaching here
      // means something genuinely unexpected. Still not allowed to escape.
      this.#report(error, 'handle-death')
      this.#emitOutcome({
        kind: 'internal-error',
        death,
        at: this.#now(),
        message: `poe-tool could not process the death of ${death.characterName}.`,
        detail: describeError(error)
      })
    }
  }

  // -------------------------------------------------------------------------
  // Execution (asynchronous, serialised)
  // -------------------------------------------------------------------------

  /** Appends one unit of work to the chain, keeping the tail permanently unrejected. */
  #enqueue(pending: PendingClip): void {
    this.#queue = this.#queue
      .then((): Promise<void> => this.#process(pending))
      .catch((error: unknown): void => {
        // #process is written not to reject; this exists so that if it ever did, the
        // chain does not stay rejected and poison every subsequent clip.
        this.#report(error, 'clip-queue')
        this.#emitOutcome({
          kind: 'internal-error',
          death: pending.death,
          at: this.#now(),
          message: `poe-tool could not finish clipping the death of ${pending.death.characterName}.`,
          detail: describeError(error)
        })
      })
  }

  /**
   * Ask OBS, wait for the file, file it away. One admitted death, start to finish.
   *
   * NEVER REJECTS: every step converts its failure into an outcome.
   *
   * DELIBERATELY NOT GUARDED ON `#disposed`. `#enqueue` schedules this as a
   * microtask, so `dispose()` - which sets the flag synchronously and only then
   * awaits `idle()` - would land BEFORE the first queued link ran. A guard here
   * therefore discarded every already-admitted death with no `ClipOutcome` at all:
   * a total silent failure, in the one moment (the app's `before-quit`) where OBS is
   * still connected and the clip could genuinely have been saved. Admission is the
   * only place disposal is allowed to reject work; once a death is admitted it is
   * seen through. Nothing new can arrive meanwhile - `dispose()` calls `stop()`
   * first, which detaches from the bus.
   */
  async #process(pending: PendingClip): Promise<void> {
    const { death } = pending

    // 1. A live socket. Checked before asking anything, so "OBS is not running" reads
    //    as itself rather than as "the replay buffer is off".
    if (!this.#obs.connected) {
      this.#emitOutcome({
        kind: 'obs-not-connected',
        death,
        at: this.#now(),
        message: `${death.characterName} died${zonePhrase(pending.zone)}, but poe-tool is not connected to OBS, so no clip was saved. Check that OBS is running with its WebSocket server enabled, then reconnect from Settings.`
      })
      return
    }

    // 2. The replay buffer has to be RUNNING. This is the check the whole error path
    //    exists for: OBS answers `SaveReplayBuffer` with RequestStatus 501 when the
    //    buffer is stopped, and without this the user sees nothing at all.
    //
    //    `isReplayBufferActive()` folds "the buffer is off" and "the status request
    //    itself failed" into the same `false`, so a request that times out on a live
    //    socket is reported as an inactive buffer. That is accepted deliberately: the
    //    socket was checked live one line ago, "off" is overwhelmingly the real cause,
    //    and the alternative - reporting a vague request failure - would bury the one
    //    message the user can actually act on.
    let bufferActive: boolean
    try {
      bufferActive = await this.#obs.isReplayBufferActive()
    } catch (error) {
      this.#report(error, 'replay-buffer-status')
      this.#emitOutcome({
        kind: 'internal-error',
        death,
        at: this.#now(),
        message: `poe-tool could not ask OBS whether the replay buffer is running, so the death of ${death.characterName} was not clipped.`,
        detail: describeError(error)
      })
      return
    }
    if (!bufferActive) {
      this.#emitOutcome({
        kind: 'replay-buffer-inactive',
        death,
        at: this.#now(),
        message: `${death.characterName} died${zonePhrase(pending.zone)}, but the OBS replay buffer is not running, so there was nothing to save. ${REPLAY_BUFFER_HELP}`
      })
      return
    }

    // 3. Save, and wait for OBS to report where the file landed.
    let saved: ObsResult<SavedReplay>
    try {
      saved = await this.#obs.saveReplayBuffer()
    } catch (error) {
      this.#report(error, 'save-replay-buffer')
      this.#emitOutcome({
        kind: 'internal-error',
        death,
        at: this.#now(),
        message: `poe-tool could not ask OBS to save the replay buffer for the death of ${death.characterName}.`,
        detail: describeError(error)
      })
      return
    }
    if (!saved.ok) {
      this.#emitOutcome(this.#saveFailureOutcome(pending, saved.error))
      return
    }

    // 4. File it. `moveClip` reports failure as data, so a throw here would be a bug
    //    in the library - caught anyway, because a rejected queue link would take the
    //    outcome with it.
    const when = new Date(Number.isFinite(saved.value.savedAt) ? saved.value.savedAt : this.#now())
    const move: MoveClipOptions = {
      sourcePath: saved.value.savedReplayPath,
      when,
      zone: pending.zone,
      characterName: pending.characterName,
      // Taken from the event rather than hardcoded to `'slain'`: it IS always `'slain'`
      // here, because admission drops suicides, but reading it off the death keeps that
      // a consequence of the filter instead of a second place to keep in sync with it.
      cause: death.cause,
      isRemoteObs: this.#obs.isRemoteObs,
      writeSidecar: pending.writeSidecar
    }

    let record: ClipRecord
    try {
      record = await this.#library.moveClip(move)
    } catch (error) {
      this.#report(error, 'move-clip')
      // Synthesise the record ourselves: OBS really did write a file, and the user
      // needs to be told where it is even though we could not move it.
      record = {
        savedAt: when.getTime(),
        originalPath: saved.value.savedReplayPath,
        finalPath: null,
        zoneName: pending.zone.displayName,
        areaId: pending.zone.areaId,
        areaLevel: pending.zone.areaLevel,
        characterName: pending.characterName,
        cause: death.cause,
        moved: false,
        note: `Moving the clip failed: ${describeError(error)}. The clip is still at ${saved.value.savedReplayPath}.`
      }
    }

    // The record is published whether or not the move worked - `finalPath === null`
    // means "still at originalPath", never "no clip".
    this.#emitClip(record)

    if (record.moved) {
      this.#emitOutcome({
        kind: 'clipped',
        death,
        at: this.#now(),
        message:
          `Clipped the death of ${death.characterName}${zonePhrase(pending.zone)} to ${record.finalPath ?? saved.value.savedReplayPath}.` +
          (record.note === null ? '' : ` ${record.note}`),
        record
      })
      return
    }

    this.#emitOutcome({
      kind: 'move-failed',
      death,
      at: this.#now(),
      message:
        record.note ??
        `OBS saved a clip of the death of ${death.characterName} at ${record.originalPath}, but it could not be moved into the clips library.`,
      record
    })
  }

  /** Maps a failed {@link ObsResult} onto its outcome. Exhaustive over `ObsError`. */
  #saveFailureOutcome(pending: PendingClip, error: ObsError): ClipOutcome {
    const death = pending.death
    const at = this.#now()
    const context = `${death.characterName} died${zonePhrase(pending.zone)}, but`

    switch (error.kind) {
      case 'not-connected':
        // The socket dropped between the check above and the request.
        return {
          kind: 'obs-not-connected',
          death,
          at,
          message: `${context} the connection to OBS was lost before the clip could be saved. ${error.message}`
        }
      case 'buffer-inactive':
        // OBS's own answer (RequestStatus 501); it can differ from the status probe
        // if the user stopped the buffer in the intervening moment.
        return {
          kind: 'replay-buffer-inactive',
          death,
          at,
          message: `${context} the OBS replay buffer is not running, so there was nothing to save. ${REPLAY_BUFFER_HELP}`
        }
      case 'save-timeout':
        return {
          kind: 'save-timeout',
          death,
          at,
          message: `${context} OBS never reported where it wrote the clip. ${error.message}`,
          timeoutMs: error.timeoutMs
        }
      case 'auth-failed':
      case 'request-failed':
        return {
          kind: 'save-rejected',
          death,
          at,
          message: `${context} OBS refused to save the replay buffer. ${error.message}`,
          error
        }
    }
  }

  // -------------------------------------------------------------------------
  // Small guarded helpers
  // -------------------------------------------------------------------------

  /**
   * The injected clock, made total. A clock that throws or returns `NaN` must not be
   * able to break the debounce arithmetic or an outcome's timestamp.
   */
  #now(): number {
    try {
      const now = this.#clock()
      return Number.isFinite(now) ? now : Date.now()
    } catch (error) {
      this.#report(error, 'clock')
      return Date.now()
    }
  }

  /**
   * The current zone, or an all-null zone if the tracker throws or has nothing.
   *
   * The `??` is not dead code despite the non-nullable return type: `getZone` is an
   * injected function and a tracker that has not seen a zone yet is entitled to hand
   * back nothing at runtime. Every consumer downstream (the namer, the sidecar)
   * already handles each field being null.
   */
  #zoneNow(at: number): CurrentZone {
    try {
      return this.#getZone() ?? unknownZone(at)
    } catch (error) {
      this.#report(error, 'get-zone')
      return unknownZone(at)
    }
  }

  /** Publishes a record. A throwing subscriber must not break the pipeline. */
  #emitClip(record: ClipRecord): void {
    try {
      this.#emitter.emit('clip', record)
    } catch (error) {
      this.#report(error, 'clip-listener')
    }
  }

  /** Publishes an outcome. A throwing subscriber must not break the pipeline. */
  #emitOutcome(outcome: ClipOutcome): void {
    try {
      this.#emitter.emit('outcome', outcome)
    } catch (error) {
      this.#report(error, 'outcome-listener')
    }
  }

  /** Diagnostic hand-off. A hook that throws is itself swallowed. */
  #report(error: unknown, context: string): void {
    try {
      this.#onInternalError(error, context)
    } catch {
      // A logger must never be the thing that crashes the main process.
    }
  }
}
