/**
 * src/main/log/character-tracker.ts
 * =================================
 *
 * Derived state: "who is the user playing right now".
 *
 * This is the second half of the pair that `zone-tracker.ts` starts: that one answers
 * WHERE the player is, this one answers WHO they are. The answer matters because
 * `DeathEvent.isSelf` is computed from it (`parse-line.ts` takes it as `selfName`),
 * and `isSelf` is the only thing standing between "clip MY deaths" and "clip every
 * death in a six-man party".
 *
 * ```text
 * 2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2
 *                                                            |--- name ---------| |-class-|      |level|
 * ```
 *
 * RULES FOR THIS FILE (identical to the zone tracker's):
 *  - No `electron`. No `node:*` timers either.
 *  - No `any`, no `@ts-ignore`.
 *  - NOTHING may escape into the caller: `ingest` runs inside `TypedEmitter.emit`,
 *    which is driven by the tail loop's `setInterval` callback, where an uncaught
 *    throw takes the Electron main process down. Every injected dependency
 *    ({@link CharacterTrackerOptions.getOverride}, `getPersisted`, `persist`) and
 *    every bus emission is individually contained.
 *
 * NO CLOCK IS INJECTED, and that is the one place this class deliberately does not
 * mirror `ZoneTracker`. `ZoneTracker` needs one because `CurrentZone.enteredAt` is a
 * timestamp it has to invent for the initial all-unknown zone; {@link ActiveCharacter}
 * carries no timestamp at all, so a clock here would be an unused constructor
 * argument that every test had to pass.
 *
 *
 * WHY LEVEL-UPS ARE THE ONLY DETECTION SIGNAL
 * -------------------------------------------
 * `... (Marauder) is now level 2` is the ONLY line in Client.txt that names a
 * character and identifies it as one being played. Deaths look tempting - there are
 * 348 of them in the reference log against 585 level-ups - but a death line names
 * WHOEVER DIED, party members included, so detecting from deaths would latch onto the
 * first ally who died next to us and then attribute all of OUR deaths to them. Deaths
 * are used for exactly one thing here, {@link CharacterTracker.suggestionsFrom}, where
 * "names that appear in this log" is all that is being claimed.
 *
 *
 * WHY THE DETECTION IS PERSISTED, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------
 * LEVEL-UPS ARE SPARSE. A character at level 98 can be played for weeks without
 * producing a single one - the reference log's most-levelled character stops at 98 and
 * every session after that is invisible to this detector. A detection held only in RAM
 * would therefore be lost on the next app restart and the app would quietly go back to
 * clipping nothing.
 *
 * So {@link CharacterTrackerOptions.persist} is called with every new detection and
 * `settings.character.detected*` holds it across restarts: ONE level-up, EVER, is
 * enough. {@link CharacterTrackerOptions.getPersisted} reads it back, and a freshly
 * constructed tracker that never sees a single level-up still reports the right
 * character.
 *
 *
 * PRIORITY: OVERRIDE > DETECTED > NONE
 * ------------------------------------
 * Resolved by {@link CharacterTracker.active}, recorded in `ActiveCharacter.source` so
 * the UI can explain which rule fired:
 *
 *  1. `'override'` - a non-empty `settings.character.override`. A MANUAL choice always
 *     wins, and it exists for GROUP PLAY: it is not established that a party member's
 *     level-up stays out of our Client.txt, and if one does land here, auto-detection
 *     will honestly pick the wrong person. Typing a name settles it.
 *  2. `'detected'` - the in-memory detection from this session, else the persisted one
 *     from an earlier session. In-memory wins because it is strictly newer than what
 *     is on disk (the persist may even have failed - see below).
 *  3. `'none'` - nothing typed, nothing ever detected. `name` is null, every
 *     `isSelf` is false and the clipper never fires. THIS IS A SILENT NO-OP from the
 *     user's point of view, which is why it must be surfaced as a loud warning with a
 *     one-click picker built from {@link CharacterTracker.suggestionsFrom} rather than
 *     discovered later as a missing clip.
 *
 * `active()` re-reads the injected getters on every call rather than caching, matching
 * `LogWatcher`, which re-reads the character name on every tick so that changing it
 * takes effect on the very next line with no restart. Both getters are cheap
 * (a field read off the in-memory `AppSettings`).
 *
 *
 * EMISSION DISCIPLINE
 * -------------------
 * `character-changed` is announced ONLY when the RESOLVED value actually changes -
 * name, class, level or source. Emitting once per level-up would spray the renderer
 * with 60 identical payloads during a levelling session, and (worse) make
 * `character-changed` useless as a "something happened" signal.
 *
 * Persisting follows the same rule for a different reason: repeating a write of
 * settings.json costs an fsync + rename each time, and a post-rotation drain can
 * legitimately re-deliver level-up lines we have already seen.
 *
 *
 * BACKLOG IS PROCESSED, NOT SKIPPED
 * ---------------------------------
 * `PoeEventBase.backlog` means "this line existed before we attached". Side effects
 * (clips, sounds) must skip those. This is a PURE STATE UPDATE and must NOT: the two
 * situations that produce backlog - a rotation re-read, and a log file that appeared
 * after the watcher was already running - are exactly the situations where the only
 * level-up we will ever see is in the bytes we just drained. Skipping them would throw
 * away the one piece of evidence this class exists to collect.
 *
 * Persisting a backlog detection is likewise intended: it is how a first run on a
 * machine with an existing Client.txt bootstraps itself.
 */

import type { ActiveCharacter, LevelUpEvent, PoeEvent, PoeEventMap } from '../../shared/events'

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/**
 * The slice of the application event bus this class uses.
 *
 * Structural, in the same style as `ZoneTrackerBus`: `PoeEventBus`, a bare
 * `TypedEmitter<PoeEventMap>` and a hand-written stub all satisfy it. `on`/`off`
 * return `unknown` because `TypedEmitter` returns `this` for chaining while other
 * emitters return `void` or an unsubscribe function; the tracker ignores all three.
 */
export interface CharacterTrackerBus {
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

/**
 * A complete detection, as handed to {@link CharacterTrackerOptions.persist}.
 *
 * All three fields are non-null: a {@link LevelUpEvent} carries all three or the
 * tracker does not treat it as a detection at all. This maps one-to-one onto
 * `settings.character.detected` / `detectedClass` / `detectedLevel`.
 */
export interface DetectedCharacter {
  /** Character name exactly as logged, trimmed. Never empty. */
  readonly name: string
  /**
   * Class or ascendancy from the same line, e.g. `"Marauder"`, `"Berserker"`.
   * DISPLAY ONLY - it changes under a fixed name when the character ascends (the
   * reference log shows `LargeThumbThomasReturns` going Marauder -> Berserker at
   * level 41), so nothing may key identity on it.
   */
  readonly className: string
  /** Level from the same line. */
  readonly level: number
}

/**
 * What {@link CharacterTrackerOptions.getPersisted} returns: the `character.detected*`
 * trio straight off `AppSettings`, where every field is independently nullable.
 *
 * They are nullable SEPARATELY on purpose - a hand-edited settings.json can carry a
 * name with no class, and `validateSettings` will happily preserve that - so a name
 * with unknown class/level is a state this class has to report rather than reject.
 */
export interface PersistedCharacter {
  readonly name: string | null
  readonly className: string | null
  readonly level: number | null
}

/** Constructor arguments. All four dependencies are required; only `onError` is not. */
export interface CharacterTrackerOptions {
  /** Where `level-up` comes from and `character-changed` goes to. */
  readonly bus: CharacterTrackerBus
  /**
   * Reads `settings.character.override` - the MANUAL choice, `""` when unset.
   *
   * Called on every {@link CharacterTracker.active}, never cached, so a setting the
   * user just changed is in effect immediately. Trimmed here, so a stray space cannot
   * silently produce an override that matches nothing.
   */
  readonly getOverride: () => string
  /**
   * Reads `settings.character.detected` / `detectedClass` / `detectedLevel` - the
   * detection persisted by an EARLIER session.
   *
   * This is the half of the design that makes sparse level-ups survivable: a tracker
   * that never sees a level-up at all still resolves to the right character.
   */
  readonly getPersisted: () => PersistedCharacter
  /**
   * Writes a new detection back to settings. In production this is a
   * `SettingsStore.save({ character: { detected, detectedClass, detectedLevel } })`.
   *
   * MAY THROW - `SettingsStore.save` deliberately does on a failed write (full or
   * read-only disk), so that memory and disk never silently disagree. The throw is
   * contained here and the detection still stands FOR THIS SESSION; only its
   * durability is lost, which is exactly the right trade in the tail loop.
   */
  readonly persist: (detected: DetectedCharacter) => void
  /**
   * Called with anything a contained failure produced - a throwing `character-changed`
   * listener, a throwing settings getter, a failed persist. Purely diagnostic; the
   * default is a no-op and a hook that itself throws is ignored.
   */
  readonly onError?: (error: unknown) => void
}

/**
 * A detection with the class/level relaxed to nullable, because that is what a
 * PERSISTED one can degrade to. Internal: callers see {@link ActiveCharacter}.
 */
interface KnownCharacter {
  readonly name: string
  readonly className: string | null
  readonly level: number | null
}

/**
 * The two-way view `LogWatcher` drives, exposed as
 * {@link CharacterTracker.characterSource}.
 *
 * It exists for ONE shape mismatch: `CharacterSource` in `./log-watcher.ts` reads the
 * resolved character as a PROPERTY (`source.active.name`, once per line), while this
 * class exposes it as the {@link CharacterTracker.active} METHOD. Handing the tracker
 * over directly is a compile error rather than a silent misread - `active.name` on a
 * method would evaluate to the function's own name, `"active"`, and then no death
 * would ever match `isSelf` and nothing anywhere would say why.
 *
 * Declared STRUCTURALLY rather than by importing `CharacterSource`, so this file keeps
 * its "no imports beyond the frozen shared types" property and the watcher stays free
 * to widen its own contract. If the two ever drift, `src/main/index.ts` fails to
 * compile at the wiring line, which is exactly where the problem is.
 */
export interface CharacterSourceView {
  /** The resolved character right now. Cheap; never throws. */
  readonly active: ActiveCharacter
  /** Feeds a level-up in, so the NEXT line parsed resolves against it. Never throws. */
  handleLevelUp(event: LevelUpEvent): void
}

/**
 * Builds the {@link CharacterSourceView} for a tracker.
 *
 * A module-level function, not an inline object literal in the constructor, because
 * `this` inside an object literal's getter refers to the literal rather than to the
 * tracker.
 */
function characterSourceFor(tracker: CharacterTracker): CharacterSourceView {
  return {
    get active(): ActiveCharacter {
      return tracker.active()
    },
    handleLevelUp(event: LevelUpEvent): void {
      tracker.handleLevelUp(event)
    }
  }
}

/** The `source: 'none'` answer. One frozen instance; it carries no per-call state. */
const NOBODY: ActiveCharacter = Object.freeze({
  name: null,
  className: null,
  level: null,
  source: 'none'
})

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * Resolves the active character and publishes `character-changed`.
 *
 * ```ts
 * const characters = new CharacterTracker({
 *   bus,
 *   getOverride: () => store.get().character.override,
 *   getPersisted: () => ({
 *     name: store.get().character.detected,
 *     className: store.get().character.detectedClass,
 *     level: store.get().character.detectedLevel
 *   }),
 *   persist: (d) => {
 *     store.save({
 *       character: { detected: d.name, detectedClass: d.className, detectedLevel: d.level }
 *     })
 *   },
 *   onError: (error) => log.warn('character tracker', error)
 * })
 * // the watcher both reads the answer and feeds level-ups back in:
 * const watcher = new LogWatcher({ bus, getSettings, characters: characters.characterSource })
 * // settings changed (including the very first load):
 * characters.refreshOverride()
 * ```
 *
 * THE CONSTRUCTOR SUBSCRIBES to `level-up`, matching `ZoneTracker` and `ReplayClipper`:
 * a detector that silently never ran resolves to `source: 'none'` forever, which reads
 * exactly like "this user has never levelled" and would send the UI's warning banner up
 * for a bug rather than a real condition. {@link stop} detaches and {@link start}
 * re-attaches; both are idempotent.
 *
 * That subscription is a SECOND path, not the primary one. `LogWatcher` calls
 * {@link handleLevelUp} directly (see {@link characterSource}) because a bus channel
 * can be starved - `TypedEmitter.emit` stops at the first listener that throws, so a
 * badly behaved `level-up` listener registered ahead of us could keep detection from
 * ever happening. Having both costs nothing: one line delivered twice persists once
 * and announces once.
 */
export class CharacterTracker {
  readonly #bus: CharacterTrackerBus
  readonly #getOverride: () => string
  readonly #getPersisted: () => PersistedCharacter
  readonly #persist: (detected: DetectedCharacter) => void
  readonly #onError: (error: unknown) => void

  /** Stable identity, so `off` can actually find it again. */
  readonly #onLevelUp: (event: LevelUpEvent) => void

  /** Built once, so `characterSource` is a stable identity a caller can compare. */
  readonly #characterSource: CharacterSourceView

  #subscribed = false
  /** This session's detection. Beats {@link #getPersisted}, which may be older. */
  #detected: DetectedCharacter | null = null
  /** The last value announced on `character-changed`; the dedupe baseline. */
  #lastEmitted: ActiveCharacter

  constructor(options: CharacterTrackerOptions) {
    this.#bus = options.bus
    this.#getOverride = options.getOverride
    this.#getPersisted = options.getPersisted
    this.#persist = options.persist
    this.#onError = options.onError ?? ((): void => undefined)

    this.#onLevelUp = (event: LevelUpEvent): void => {
      this.handleLevelUp(event)
    }
    this.#characterSource = characterSourceFor(this)

    // Seed the dedupe baseline with what we already resolve to - typically the
    // detection persisted by an earlier session. Announcing THAT would be a lie:
    // nothing changed, it is simply what is true at startup, and the renderer reads
    // it with the `character:active` request instead. Seeded BEFORE subscribing so
    // no ordering question can arise.
    this.#lastEmitted = this.active()

    this.start()
  }

  /** Subscribes to the bus. Called by the constructor; idempotent. */
  start(): this {
    if (this.#subscribed) return this
    this.#subscribed = true
    this.#bus.on('level-up', this.#onLevelUp)
    return this
  }

  /**
   * Detaches from the bus. Idempotent.
   *
   * The detection is deliberately LEFT AS IS: it is still the last thing we knew, and
   * a shutdown path that blanked it would make `isSelf` go false for any death that is
   * still in flight.
   */
  stop(): this {
    if (!this.#subscribed) return this
    this.#subscribed = false
    this.#bus.off('level-up', this.#onLevelUp)
    return this
  }

  /** True while attached to the bus. */
  get running(): boolean {
    return this.#subscribed
  }

  /**
   * This tracker as the `CharacterSource` `LogWatcher` expects - pass it as that
   * class's `characters` option.
   *
   * `LogWatcher` reads the resolved character PER LINE to stamp `DeathEvent.isSelf`,
   * and hands level-ups back in before publishing them so the lines AFTER a level-up
   * already resolve against the character it named. Both directions are the same loop,
   * which is why the watcher takes them as one object. See {@link CharacterSourceView}
   * for why the tracker cannot be passed directly.
   *
   * The subscription this class makes in its own constructor stays useful alongside
   * it: it covers every OTHER producer on the bus, and driving both paths for one line
   * is a no-op (see {@link ingest}).
   */
  get characterSource(): CharacterSourceView {
    return this.#characterSource
  }

  /**
   * WHO COUNTS AS "ME" RIGHT NOW: override > detected > none. See the file header for
   * why that order, and `ActiveCharacter` for what each `source` means.
   *
   * Cheap and side-effect free - it NEVER emits, so it is safe to call from a getter,
   * an IPC handler or a hot loop. (The consequence: if the override is changed behind
   * our back and nobody calls {@link refreshOverride}, `active()` reports the new
   * value while `character-changed` has not fired yet. The next announcement corrects
   * itself, because the dedupe compares against the last EMITTED value, not against
   * the last resolved one.)
   *
   * NEVER THROWS: a settings getter that blows up degrades to "not configured" rather
   * than taking down the caller.
   */
  active(): ActiveCharacter {
    const override = this.#readOverride()
    const detected = this.#detected ?? this.#readPersisted()

    if (override !== '') {
      // An override is just a name the user typed, so its class and level are unknown
      // - UNLESS the name it points at is the one we detected, in which case we
      // already know both and hiding them would make the UI look broken right after a
      // level-up. Compared the same case-insensitive way `isSelf` is.
      const known = detected !== null && sameName(detected.name, override) ? detected : null
      return {
        name: override,
        className: known?.className ?? null,
        level: known?.level ?? null,
        source: 'override'
      }
    }

    if (detected !== null) {
      // `'detected'` covers BOTH the in-memory and the persisted case: a detection
      // read back from settings.json was still detected from a level-up line, just in
      // an earlier session, and `ActiveCharacter.source` has no fourth arm for it.
      return {
        name: detected.name,
        className: detected.className,
        level: detected.level,
        source: 'detected'
      }
    }

    return NOBODY
  }

  /**
   * Feeds one event in. Everything that is not a {@link LevelUpEvent} is ignored -
   * notably deaths, which name whoever died and would detect a party member as us.
   *
   * Accepts the whole `PoeEvent` union so a caller can wire the bus's `event` channel
   * straight to it. Doing that AND leaving the constructor's own `level-up`
   * subscription in place is safe: a repeated detection persists nothing and announces
   * nothing (see {@link handleLevelUp}), so double-driving is a genuine no-op.
   *
   * NEVER THROWS.
   */
  ingest(event: PoeEvent): void {
    if (event.type !== 'level-up') return
    this.handleLevelUp(event)
  }

  /**
   * Records a level-up as the current detection, persists it, and announces the
   * resolved character if it changed.
   *
   * Public so a producer that is not the bus (the debug CLI, a test) can drive the
   * tracker directly. NEVER THROWS.
   *
   * A level-up for a DIFFERENT character REPLACES the detection outright - that is the
   * alt-swap signal, and it is the only one there is. It is also why the manual
   * override exists: if the level-up came from a party member rather than from the
   * user, this is precisely where auto-detection goes wrong, and only a typed name can
   * out-rank it.
   *
   * THE REPLACEMENT IS HONOURED BUT NOT SILENT. It is honoured because a brand-new
   * character legitimately starts at level 1 and must start being clipped without the
   * user doing anything. It must not be silent because the same shape is a MULE: the
   * reference log ends with a level-2 Marauder displacing a level-93 Elementalist, and
   * from that moment `isSelf` is false for every real death, persisted, across
   * restarts, with nothing on screen saying so. The renderer diffs consecutive
   * `character-changed` payloads and raises a warning with a one-click "keep the old
   * name" - see `src/renderer/src/detection-swap.ts`. Nothing about that lives here:
   * this class's job is to report the best answer the log supports, not to second-guess
   * it.
   *
   * BACKLOG EVENTS ARE PROCESSED like any other - see the file header.
   */
  handleLevelUp(event: LevelUpEvent): void {
    const name = event.characterName.trim()
    // A nameless detection could never match a death line, but it WOULD out-rank the
    // persisted one and silently blank a working configuration. Unreachable through
    // `parse-line` (the pattern requires a non-space token); the guard is here so a
    // future producer cannot introduce it.
    if (name === '') return
    // Same reasoning for the level: `persist` writes this into settings.json, and a
    // NaN there serialises to `null`. Better to ignore a malformed line than to
    // half-overwrite a good detection with it.
    if (!Number.isFinite(event.level)) return

    const detected: DetectedCharacter = {
      name,
      className: event.className.trim(),
      level: Math.trunc(event.level)
    }

    // Persist only on a real change. A rotation re-read can legitimately replay
    // level-up lines we already saw, and each write is an fsync + rename.
    if (!this.#alreadyStored(detected)) {
      try {
        this.#persist(detected)
      } catch (error) {
        // The write failed (full/read-only disk). The detection still holds for THIS
        // session - see `CharacterTrackerOptions.persist`.
        this.#report(error)
      }
    }

    // Set AFTER the persist attempt but regardless of its outcome: in-memory truth is
    // what `active()` reports, and it must not depend on the disk.
    this.#detected = detected

    this.#announce()
  }

  /**
   * Re-resolves and announces if the answer changed. Call after ANY settings change -
   * the user typing an override, clearing it, or picking a name from the suggestion
   * picker - and after the initial `SettingsStore.load()` if the tracker was built
   * before it.
   *
   * Named for the case that motivates it, but it re-reads the persisted detection too,
   * so it also covers "the user cleared the detection" and "settings.json was
   * reloaded".
   *
   * NEVER THROWS.
   */
  refreshOverride(): void {
    this.#announce()
  }

  /**
   * Every distinct character name seen in the given events, MOST FREQUENT FIRST.
   *
   * This feeds the one-click picker the UI must offer when {@link active} resolves to
   * `source: 'none'`, because that state is otherwise a dead end: death clipping
   * quietly does nothing and the fix - type your character's name exactly - is
   * something the user has to get letter-perfect from memory. The names are already in
   * their log; offer them.
   *
   * DEATHS COUNT HERE, unlike in detection. The claim being made is only "this name
   * appears in your Client.txt", which is true of a party member too, and a party
   * member in the list costs one wrong entry in a picker. The contrast with
   * {@link handleLevelUp}, where a wrong name silently clips the wrong person's
   * deaths, is the whole reason the two rules differ.
   *
   * ORDERING: count descending, then most recently seen first, which assumes the
   * caller passes events in log order (a `name-scan.ts` sweep, the `events:recent` ring
   * buffer, and a `LogWatcher.replay` all do; the IPC handler concatenates the first two
   * in that order for exactly this reason). When it does not, the result is still
   * deterministic. The renderer is told not to re-sort - see
   * `CharacterSuggestionsResult`.
   *
   * PURE AND STATIC: no bus, no settings, no instance state. Names are grouped
   * case-insensitively (the same rule every other name comparison in the app uses) so
   * the picker cannot offer two entries that resolve to the same character; the first
   * spelling seen is the one shown.
   */
  static suggestionsFrom(events: Iterable<PoeEvent>): readonly string[] {
    interface Tally {
      readonly display: string
      count: number
      lastSeen: number
    }

    const byKey = new Map<string, Tally>()
    let index = 0

    for (const event of events) {
      index += 1
      // Deaths and level-ups only. Zone/area events name places, not people.
      if (event.type !== 'level-up' && event.type !== 'death') continue

      const name = event.characterName.trim()
      if (name === '') continue

      const key = name.toLowerCase()
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, { display: name, count: 1, lastSeen: index })
      } else {
        existing.count += 1
        existing.lastSeen = index
      }
    }

    return [...byKey.values()]
      .sort((a, b) => (b.count - a.count !== 0 ? b.count - a.count : b.lastSeen - a.lastSeen))
      .map((tally) => tally.display)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Announces the resolved character, but only if it differs from what was last
   * announced. Contained: this runs on the tail loop's thread of control.
   */
  #announce(): void {
    const next = this.active()
    if (sameCharacter(this.#lastEmitted, next)) return

    // Recorded BEFORE emitting, so a throwing listener cannot make the next event
    // re-announce a value the healthy listeners already received.
    this.#lastEmitted = next
    try {
      this.#bus.emit('character-changed', next)
    } catch (error) {
      this.#report(error)
    }
  }

  /**
   * True when `next` is exactly what we already hold - in memory this session, or in
   * settings from an earlier one. Compared EXACTLY (not case-insensitively): a
   * detection that differs only in capitalisation is still a correction worth writing.
   */
  #alreadyStored(next: DetectedCharacter): boolean {
    const known = this.#detected ?? this.#readPersisted()
    return (
      known !== null &&
      known.name === next.name &&
      known.className === next.className &&
      known.level === next.level
    )
  }

  /** The manual override, trimmed. `""` for unset, unreadable, or whitespace-only. */
  #readOverride(): string {
    try {
      return this.#getOverride().trim()
    } catch (error) {
      this.#report(error)
      return ''
    }
  }

  /**
   * The detection persisted by an earlier session, normalised.
   *
   * A blank name means "never detected" and yields `null` - the class and level are
   * then meaningless and are dropped with it. A name with a blank class or an
   * unusable level survives with those fields null, because the NAME is the part
   * everything downstream actually depends on.
   */
  #readPersisted(): KnownCharacter | null {
    try {
      const stored = this.#getPersisted()

      const name = stored.name === null ? '' : stored.name.trim()
      if (name === '') return null

      const className = stored.className === null ? '' : stored.className.trim()
      const level = stored.level !== null && Number.isFinite(stored.level) ? stored.level : null

      return { name, className: className === '' ? null : className, level }
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
// Comparisons
// ---------------------------------------------------------------------------

/**
 * Case-insensitive, whitespace-tolerant name comparison - the same rule
 * `parse-line.ts` uses for `DeathEvent.isSelf`, so "does the override name the
 * character we detected" and "is this death mine" can never disagree.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Whether two resolved characters are the same ANSWER, which is what
 * `character-changed` reports.
 *
 * `source` is part of it: flipping from `'detected'` to `'override'` for the same name
 * changes nothing about who we are but everything about what the UI must say (a
 * detection can be corrected, a manual choice must not be silently overruled), and the
 * renderer replaces its state from this payload alone.
 *
 * Names are compared EXACTLY here, not with {@link sameName}: this is a UI-facing
 * value, so re-capitalising a name is a change worth pushing.
 */
function sameCharacter(a: ActiveCharacter, b: ActiveCharacter): boolean {
  return (
    a.name === b.name &&
    a.className === b.className &&
    a.level === b.level &&
    a.source === b.source
  )
}
