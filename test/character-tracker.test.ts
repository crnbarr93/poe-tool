/**
 * test/character-tracker.test.ts
 * ==============================
 *
 * Who counts as "me": `override > detected > none`, and the persistence that makes
 * the middle rung survivable.
 *
 * The failure modes here are all SILENT, which is why they are pinned individually:
 * resolve to the wrong character and every clip is somebody else's death; resolve to
 * nobody and the app does nothing at all, with no error anywhere; lose the detection
 * on restart and it goes back to doing nothing until the next level-up, which for a
 * level-98 character may be never.
 *
 *
 * WHY THE EVENTS ARE BUILT BY HAND HERE AND NOT BY `parseLine`
 * -----------------------------------------------------------
 * `test/zone-tracker.test.ts` drives its tracker through the real parser, because its
 * subject IS the relationship between two specific log lines. This class's subject is
 * the RESOLUTION RULES over already-decoded events, and it reads only three fields.
 * Coupling it to the level-up REGEX would make a parser change fail here as well as in
 * `parse-line.test.ts`, in a file whose failures should mean "resolution is wrong".
 *
 * The envelope is still real: {@link metaOf} runs a verbatim Client.txt line through
 * `parseLine` and keeps the `LogLineMeta` it decoded (which `parseLine` produces for
 * recognised and unrecognised bodies alike), so the fixtures carry a genuine
 * timestamp, clientMs and system-marker flag rather than an invented one.
 *
 * Every line below is verbatim from the user's real 375,087-line Client.txt.
 */

import { describe, expect, it } from 'vitest'

import { PoeEventBus } from '../src/main/events/event-bus'
import {
  CharacterTracker,
  type DetectedCharacter,
  type PersistedCharacter
} from '../src/main/log/character-tracker'
import { parseLine } from '../src/main/log/parse-line'
import type {
  ActiveCharacter,
  DeathCause,
  DeathEvent,
  LevelUpEvent,
  LogLineMeta
} from '../src/shared/events'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Verbatim. The first level-up in the reference log. */
const LEVEL_LINE =
  '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2'
/** Verbatim. A normal death. */
const DEATH_LINE =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'

const T0 = 1_700_000_000_000

/**
 * The decoded envelope of a real line.
 *
 * Uses `parseLine` for the envelope only: `meta` is present on a recognised event and
 * on an `UnmatchedLine` whose envelope parsed, so this returns the same real metadata
 * whether or not the parser knows the body pattern yet. Throws loudly if the ENVELOPE
 * ever stops matching, which would be a genuine regression.
 */
function metaOf(line: string): LogLineMeta {
  const parsed = parseLine(line, { detectedAt: T0, backlog: false, selfName: '' })
  if (parsed.meta === null) throw new Error(`envelope did not parse: ${line}`)
  return parsed.meta
}

function levelUp(
  characterName: string,
  className: string,
  level: number,
  backlog = false
): LevelUpEvent {
  return {
    type: 'level-up',
    meta: metaOf(LEVEL_LINE),
    detectedAt: T0,
    backlog,
    characterName,
    className,
    level
  }
}

function death(characterName: string, cause: DeathCause = 'slain'): DeathEvent {
  return {
    type: 'death',
    meta: metaOf(DEATH_LINE),
    detectedAt: T0,
    backlog: false,
    characterName,
    cause,
    // Irrelevant to this class - it is the OUTPUT of the resolution being tested here,
    // computed by `parseLine` from the name this tracker resolves.
    isSelf: false
  }
}

/** Nothing configured, nothing ever detected. */
const NOTHING_PERSISTED: PersistedCharacter = { name: null, className: null, level: null }

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly bus: PoeEventBus
  readonly tracker: CharacterTracker
  /** Every `character-changed` payload, in order. */
  readonly changes: ActiveCharacter[]
  /** Every `persist` call, in order. */
  readonly writes: DetectedCharacter[]
  /** Anything the tracker contained and reported. */
  readonly errors: unknown[]
  /** Stands in for `settings.character.override`; change it, then `refreshOverride()`. */
  setOverride: (value: string) => void
  /** Stands in for `settings.character.detected*` - what a NEW instance would read. */
  readonly storage: () => PersistedCharacter
}

interface HarnessOptions {
  readonly override?: string
  readonly persisted?: PersistedCharacter
  /** Injected failures, for the containment cases. */
  readonly failPersist?: boolean
  readonly failGetOverride?: boolean
  readonly failGetPersisted?: boolean
}

/**
 * A tracker wired to a REAL `PoeEventBus` and to a mutable stand-in for the settings
 * store: `persist` writes into the same cell `getPersisted` reads from, exactly as
 * `SettingsStore.save` / `get` do. That is what makes the restart test honest -
 * {@link Harness.storage} can be handed to a second instance verbatim.
 */
function harness(options: HarnessOptions = {}): Harness {
  const bus = new PoeEventBus()
  const changes: ActiveCharacter[] = []
  const writes: DetectedCharacter[] = []
  const errors: unknown[] = []

  let override = options.override ?? ''
  let persisted: PersistedCharacter = options.persisted ?? NOTHING_PERSISTED

  bus.on('character-changed', (character) => changes.push(character))

  const tracker = new CharacterTracker({
    bus,
    getOverride: () => {
      if (options.failGetOverride === true) throw new Error('settings unreadable')
      return override
    },
    getPersisted: () => {
      if (options.failGetPersisted === true) throw new Error('settings unreadable')
      return persisted
    },
    persist: (detected) => {
      writes.push(detected)
      if (options.failPersist === true) throw new Error('disk full')
      persisted = { name: detected.name, className: detected.className, level: detected.level }
    },
    onError: (error) => errors.push(error)
  })

  return {
    bus,
    tracker,
    changes,
    writes,
    errors,
    setOverride: (value: string): void => {
      override = value
    },
    storage: (): PersistedCharacter => persisted
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('CharacterTracker initial state', () => {
  it('resolves to nobody when nothing is configured and nothing was ever detected', () => {
    const { tracker, changes } = harness()

    expect(tracker.active()).toEqual({
      name: null,
      className: null,
      level: null,
      source: 'none'
    })
    // This is the state the UI must warn about: every `isSelf` is false, so the
    // clipper never fires and the user sees nothing happen.
    expect(changes).toHaveLength(0)
  })

  it('subscribes in the constructor, with no separate start() step', () => {
    const { bus, tracker } = harness()
    expect(tracker.running).toBe(true)

    bus.emit('level-up', levelUp('LargeThumbThomasReturns', 'Marauder', 2))

    expect(tracker.active().name).toBe('LargeThumbThomasReturns')
  })

  it('announces nothing at construction - startup state is not a change', () => {
    const { changes } = harness({
      override: 'WorldWordleChamp',
      persisted: { name: 'OneLongToe', className: 'Berserker', level: 55 }
    })

    expect(changes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Priority: override > detected > none
// ---------------------------------------------------------------------------

describe('CharacterTracker resolution priority', () => {
  it('lets a non-empty override beat a detected character', () => {
    const h = harness({ override: 'WorldWordleChamp' })

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Marauder', 2))

    // Group play: the level-up may have been a party member's. A typed name is the
    // only thing that can out-rank the detector, and it must.
    expect(h.tracker.active()).toEqual({
      name: 'WorldWordleChamp',
      className: null,
      level: null,
      source: 'override'
    })
  })

  it('keeps class and level when the override names the character we detected', () => {
    const h = harness({ override: 'largethumbthomasreturns' })

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))

    // Same character, typed in a different case - the same comparison `isSelf` uses.
    // The name is reported as the USER typed it; the class and level are ours to add.
    expect(h.tracker.active()).toEqual({
      name: 'largethumbthomasreturns',
      className: 'Berserker',
      level: 93,
      source: 'override'
    })
  })

  it('falls through to the detected character for an empty override', () => {
    const h = harness({ override: '' })

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Marauder', 2))

    expect(h.tracker.active()).toEqual({
      name: 'LargeThumbThomasReturns',
      className: 'Marauder',
      level: 2,
      source: 'detected'
    })
  })

  it('treats a whitespace-only override as no override at all', () => {
    const h = harness({ override: '   ' })

    h.tracker.ingest(levelUp('OneLongToe', 'Berserker', 55))

    // A stray space must not become an override that matches no character - that
    // would silently stop all clipping.
    expect(h.tracker.active().source).toBe('detected')
    expect(h.tracker.active().name).toBe('OneLongToe')
  })

  it('trims an override before using it', () => {
    const h = harness({ override: '  Burgertrash  ' })

    expect(h.tracker.active()).toEqual({
      name: 'Burgertrash',
      className: null,
      level: null,
      source: 'override'
    })
  })

  it('reports an override even when nothing has ever been detected', () => {
    const h = harness({ override: 'Burgertrash' })

    expect(h.tracker.active()).toEqual({
      name: 'Burgertrash',
      className: null,
      level: null,
      source: 'override'
    })
  })
})

// ---------------------------------------------------------------------------
// Detection from level-ups
// ---------------------------------------------------------------------------

describe('CharacterTracker detection', () => {
  it('detects, persists and announces on a level-up', () => {
    const h = harness()

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Marauder', 2))

    expect(h.tracker.active()).toEqual({
      name: 'LargeThumbThomasReturns',
      className: 'Marauder',
      level: 2,
      source: 'detected'
    })
    expect(h.writes).toEqual([
      { name: 'LargeThumbThomasReturns', className: 'Marauder', level: 2 }
    ])
    expect(h.changes).toEqual([h.tracker.active()])
  })

  it('switches character when a DIFFERENT character levels up', () => {
    const h = harness()

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    h.tracker.ingest(levelUp('WorldWordleChamp', 'Slayer', 98))

    // The alt-swap signal, and the only one there is.
    expect(h.tracker.active().name).toBe('WorldWordleChamp')
    expect(h.changes.map((c) => c.name)).toEqual(['LargeThumbThomasReturns', 'WorldWordleChamp'])
    expect(h.writes).toHaveLength(2)
  })

  it('announces a level change for the same character', () => {
    const h = harness()

    h.tracker.ingest(levelUp('OneLongToe', 'Berserker', 54))
    h.tracker.ingest(levelUp('OneLongToe', 'Berserker', 55))

    expect(h.changes.map((c) => c.level)).toEqual([54, 55])
    expect(h.tracker.active().level).toBe(55)
  })

  it('announces an ascendancy change under a fixed name', () => {
    const h = harness()

    // Real: LargeThumbThomasReturns is a Marauder to level 40 and a Berserker from 41.
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Marauder', 40))
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 41))

    expect(h.changes.map((c) => c.className)).toEqual(['Marauder', 'Berserker'])
    expect(h.writes).toHaveLength(2)
  })

  it('does not re-announce or re-persist a repeated level-up of the same character', () => {
    const h = harness()

    const line = levelUp('LargeThumbThomasReturns', 'Berserker', 93)
    h.tracker.ingest(line)
    h.tracker.ingest(line)
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))

    // A rotation re-read can legitimately replay a line we have already seen, and
    // every write here is an fsync + rename on settings.json.
    expect(h.changes).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
  })

  it('is a no-op when driven twice for one event - bus subscription plus a manual ingest', () => {
    const h = harness()

    const event = levelUp('LargeThumbThomasReturns', 'Berserker', 93)
    // The assembled app may wire the `event` channel to `ingest` while the constructor
    // is also subscribed to `level-up`. Both paths for one line must total one change.
    h.bus.emit('level-up', event)
    h.tracker.ingest(event)

    expect(h.changes).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
  })

  it('processes backlog level-ups - this is state, not a side effect', () => {
    const h = harness()

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93, true))

    // Backlog is produced by a rotation re-read or by a log file that appeared late.
    // Those are exactly the cases where the only level-up we will ever see is in the
    // bytes we just drained; skipping them would throw the detection away.
    expect(h.tracker.active().name).toBe('LargeThumbThomasReturns')
    expect(h.writes).toHaveLength(1)
  })

  it('ignores deaths, which name whoever died rather than whoever is playing', () => {
    const h = harness()

    h.tracker.ingest(death('Tenning'))
    h.tracker.ingest(death('LargeThumbThomasReturns', 'suicide'))

    // Detecting from a death would latch onto the first party member to die next to
    // us and then attribute all of OUR deaths to them.
    expect(h.tracker.active().source).toBe('none')
    expect(h.writes).toHaveLength(0)
    expect(h.changes).toHaveLength(0)
  })

  it('ignores zone events', () => {
    const h = harness()

    h.tracker.ingest({
      type: 'zone-entered',
      meta: metaOf(DEATH_LINE),
      detectedAt: T0,
      backlog: false,
      zoneName: 'Karui Shores'
    })

    expect(h.tracker.active().source).toBe('none')
    expect(h.changes).toHaveLength(0)
  })

  it('ignores a level-up with an unusable name or level', () => {
    const h = harness({ persisted: { name: 'OneLongToe', className: 'Berserker', level: 55 } })

    h.tracker.ingest(levelUp('   ', 'Marauder', 2))
    h.tracker.ingest(levelUp('Burgertrash', 'Slayer', Number.NaN))

    // Unreachable through `parseLine`, but a half-formed detection would OUT-RANK the
    // persisted one and silently blank a working configuration.
    expect(h.tracker.active().name).toBe('OneLongToe')
    expect(h.writes).toHaveLength(0)
    expect(h.changes).toHaveLength(0)
  })

  it('keeps detecting behind an active override, without announcing', () => {
    const h = harness({ override: 'WorldWordleChamp' })

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))

    // The override still wins, so the ANSWER did not change and nothing is announced.
    expect(h.tracker.active().name).toBe('WorldWordleChamp')
    expect(h.changes).toHaveLength(0)
    // But detection must keep running underneath, or clearing the override later
    // would fall back to a stale character - or to nothing at all.
    expect(h.writes).toEqual([
      { name: 'LargeThumbThomasReturns', className: 'Berserker', level: 93 }
    ])
    h.setOverride('')
    h.tracker.refreshOverride()
    expect(h.tracker.active().name).toBe('LargeThumbThomasReturns')
  })

  it('announces when a level-up updates the character the override names', () => {
    const h = harness({ override: 'OneLongToe' })

    h.tracker.ingest(levelUp('OneLongToe', 'Berserker', 55))

    expect(h.changes).toEqual([
      { name: 'OneLongToe', className: 'Berserker', level: 55, source: 'override' }
    ])
  })

  it('trims the name and class off the event', () => {
    const h = harness()

    h.tracker.ingest(levelUp(' Burgertrash ', ' Slayer ', 97))

    expect(h.writes).toEqual([{ name: 'Burgertrash', className: 'Slayer', level: 97 }])
  })
})

// ---------------------------------------------------------------------------
// Persistence - the sparse-level-up scenario
// ---------------------------------------------------------------------------

describe('CharacterTracker persistence', () => {
  it('restores a detection from settings on a fresh instance that sees no level-up', () => {
    // THE SCENARIO THIS CLASS EXISTS FOR. A level-98 character can be played for weeks
    // without a single level-up line, so the detection has to survive restarts on its
    // own; anything held only in RAM means the app quietly stops clipping.
    const first = harness()
    first.tracker.ingest(levelUp('WorldWordleChamp', 'Slayer', 98))

    // Restart: a brand new tracker, a brand new bus, reading the settings the first
    // one wrote. No events at all this session.
    const second = harness({ persisted: first.storage() })

    expect(second.tracker.active()).toEqual({
      name: 'WorldWordleChamp',
      className: 'Slayer',
      level: 98,
      source: 'detected'
    })
  })

  it('reports a persisted name whose class and level were lost', () => {
    const h = harness({ persisted: { name: 'Burgertrash', className: null, level: null } })

    // A hand-edited settings.json can produce this, and `validateSettings` preserves
    // it. The NAME is the part `isSelf` depends on, so it must still resolve.
    expect(h.tracker.active()).toEqual({
      name: 'Burgertrash',
      className: null,
      level: null,
      source: 'detected'
    })
  })

  it('treats a blank persisted name as never detected', () => {
    const h = harness({ persisted: { name: '   ', className: 'Slayer', level: 40 } })

    expect(h.tracker.active()).toEqual(
      expect.objectContaining({ name: null, className: null, level: null, source: 'none' })
    )
  })

  it('prefers this session detection over an older persisted one', () => {
    const h = harness({ persisted: { name: 'OneLongToe', className: 'Berserker', level: 55 } })

    h.tracker.ingest(levelUp('FyascoWorbinTime', 'Elementalist', 93))

    expect(h.tracker.active().name).toBe('FyascoWorbinTime')
  })

  it('does not rewrite settings when the level-up merely confirms what is stored', () => {
    const h = harness({
      persisted: { name: 'WorldWordleChamp', className: 'Slayer', level: 98 }
    })

    h.tracker.ingest(levelUp('WorldWordleChamp', 'Slayer', 98))

    expect(h.writes).toHaveLength(0)
    // And nothing changed, so nothing is announced either.
    expect(h.changes).toHaveLength(0)
  })

  it('keeps the detection for this session when the write fails', () => {
    const h = harness({ failPersist: true })

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))

    // `SettingsStore.save` throws on a full or read-only disk. Losing durability is
    // survivable; losing the running session's detection is not.
    expect(h.tracker.active().name).toBe('LargeThumbThomasReturns')
    expect(h.errors).toHaveLength(1)
    expect(h.changes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// refreshOverride
// ---------------------------------------------------------------------------

describe('CharacterTracker.refreshOverride', () => {
  it('announces when a newly typed override changes the answer', () => {
    const h = harness()
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    h.changes.length = 0

    h.setOverride('WorldWordleChamp')
    h.tracker.refreshOverride()

    expect(h.changes).toEqual([
      { name: 'WorldWordleChamp', className: null, level: null, source: 'override' }
    ])
  })

  it('falls back to the detected character when the override is cleared', () => {
    const h = harness({ override: 'WorldWordleChamp' })
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    h.changes.length = 0

    h.setOverride('')
    h.tracker.refreshOverride()

    // Clearing an override must fall back to the detection, not wipe it - which is
    // why the two are stored separately in the first place.
    expect(h.tracker.active()).toEqual({
      name: 'LargeThumbThomasReturns',
      className: 'Berserker',
      level: 93,
      source: 'detected'
    })
    expect(h.changes).toHaveLength(1)
  })

  it('announces when only the source changes', () => {
    const h = harness()
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    h.changes.length = 0

    h.setOverride('LargeThumbThomasReturns')
    h.tracker.refreshOverride()

    // Same name, class and level - but "detected, and correctable" and "the user typed
    // this" are different things to show, and the renderer replaces its state from
    // this payload alone.
    expect(h.changes).toEqual([
      {
        name: 'LargeThumbThomasReturns',
        className: 'Berserker',
        level: 93,
        source: 'override'
      }
    ])
  })

  it('announces nothing when the answer did not change', () => {
    const h = harness({ override: 'Burgertrash' })

    h.tracker.refreshOverride()
    h.setOverride('  Burgertrash  ')
    h.tracker.refreshOverride()

    expect(h.changes).toHaveLength(0)
  })

  it('picks up a suggestion chosen from the picker', () => {
    // The `source: 'none'` recovery path: the UI offers harvested names, the user
    // clicks one, main writes it to `character.override` and calls this.
    const h = harness()
    expect(h.tracker.active().source).toBe('none')

    h.setOverride('LargerThumbThomas')
    h.tracker.refreshOverride()

    expect(h.changes).toEqual([
      { name: 'LargerThumbThomas', className: null, level: null, source: 'override' }
    ])
  })
})

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

describe('CharacterTracker.suggestionsFrom', () => {
  it('returns distinct names from level-ups AND deaths, most frequent first', () => {
    const names = CharacterTracker.suggestionsFrom([
      death('WorldWordleChamp'),
      levelUp('LargeThumbThomasReturns', 'Marauder', 2),
      death('LargeThumbThomasReturns'),
      death('LargeThumbThomasReturns', 'suicide'),
      levelUp('WorldWordleChamp', 'Slayer', 98),
      death('OneLongToe')
    ])

    // Deaths count here even though they never drive detection: the claim is only
    // "this name appears in your log", which a picker can afford to get slightly wide.
    expect(names).toEqual(['LargeThumbThomasReturns', 'WorldWordleChamp', 'OneLongToe'])
  })

  it('breaks ties by most recent activity', () => {
    const names = CharacterTracker.suggestionsFrom([
      death('FyascoWorbinTime'),
      death('Burgertrash'),
      levelUp('LargerThumbThomas', 'Berserker', 90)
    ])

    // One event each: the newest is the likeliest to be the character in play now.
    expect(names).toEqual(['LargerThumbThomas', 'Burgertrash', 'FyascoWorbinTime'])
  })

  it('groups names case-insensitively and shows the first spelling seen', () => {
    const names = CharacterTracker.suggestionsFrom([
      levelUp('Burgertrash', 'Duelist', 10),
      death('BURGERTRASH'),
      death('burgertrash')
    ])

    // Two entries that resolve to the same character would make the picker look like
    // it is offering a meaningful choice when it is not.
    expect(names).toEqual(['Burgertrash'])
  })

  it('ignores zone events and blank names', () => {
    const names = CharacterTracker.suggestionsFrom([
      {
        type: 'zone-entered',
        meta: metaOf(DEATH_LINE),
        detectedAt: T0,
        backlog: false,
        zoneName: 'Karui Shores'
      },
      {
        type: 'area-generated',
        meta: metaOf(DEATH_LINE),
        detectedAt: T0,
        backlog: false,
        areaLevel: 69,
        areaId: '2_11_endgame_town',
        seed: 1
      },
      death('  '),
      death('OneLongToe')
    ])

    expect(names).toEqual(['OneLongToe'])
  })

  it('returns an empty list for no events - a normal answer, not an error', () => {
    // A fresh log, or a character that has never levelled and never died. The UI still
    // has to offer free-text entry.
    expect(CharacterTracker.suggestionsFrom([])).toEqual([])
  })

  it('trims the names it reports', () => {
    expect(CharacterTracker.suggestionsFrom([death(' OneLongToe ')])).toEqual(['OneLongToe'])
  })
})

// ---------------------------------------------------------------------------
// The LogWatcher view
// ---------------------------------------------------------------------------

describe('CharacterTracker.characterSource', () => {
  it('exposes the resolved character as a live property, not a method', () => {
    const h = harness()
    const source = h.tracker.characterSource

    expect(source.active.name).toBeNull()
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))

    // `LogWatcher` reads `source.active.name` once per LINE, so it must see the new
    // answer without being re-wired. Handing it the tracker itself would read the
    // METHOD's own `.name` - the string "active" - and silently match no death ever.
    expect(source.active).toEqual({
      name: 'LargeThumbThomasReturns',
      className: 'Berserker',
      level: 93,
      source: 'detected'
    })
  })

  it('feeds level-ups back in through the same view', () => {
    const h = harness()

    // The other half of the watcher's loop: it learns from the line before it
    // publishes it, so the NEXT line already resolves against the new character.
    h.tracker.characterSource.handleLevelUp(levelUp('OneLongToe', 'Berserker', 55))

    expect(h.tracker.active().name).toBe('OneLongToe')
    expect(h.writes).toHaveLength(1)
  })

  it('is a stable identity', () => {
    const h = harness()
    expect(h.tracker.characterSource).toBe(h.tracker.characterSource)
  })
})

// ---------------------------------------------------------------------------
// Containment - nothing may escape into the tail loop
// ---------------------------------------------------------------------------

describe('CharacterTracker containment', () => {
  it('contains a throwing character-changed listener', () => {
    const h = harness()
    const boom = new Error('subscriber exploded')
    h.bus.on('character-changed', () => {
      throw boom
    })

    // Runs inside the tail loop's setInterval callback; a throw here kills the app.
    expect(() =>
      h.bus.emit('level-up', levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    ).not.toThrow()
    expect(h.errors).toEqual([boom])
    // The state update happens BEFORE the announcement, so it survives the failure.
    expect(h.tracker.active().name).toBe('LargeThumbThomasReturns')
  })

  it('does not re-announce a value a throwing listener already received', () => {
    const h = harness()
    const seen: ActiveCharacter[] = []
    h.bus.on('character-changed', (character) => {
      seen.push(character)
      throw new Error('subscriber exploded')
    })

    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    h.tracker.ingest(levelUp('LargeThumbThomasReturns', 'Berserker', 93))

    expect(seen).toHaveLength(1)
  })

  it('degrades to the detected character when the override cannot be read', () => {
    const h = harness({ failGetOverride: true })

    h.tracker.ingest(levelUp('OneLongToe', 'Berserker', 55))

    expect(h.tracker.active().name).toBe('OneLongToe')
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('degrades to nobody when the persisted detection cannot be read', () => {
    const h = harness({ failGetPersisted: true })

    expect(h.tracker.active()).toEqual({
      name: null,
      className: null,
      level: null,
      source: 'none'
    })
    // Refusing to guess is the point: a wrong name clips somebody else's deaths.
    expect(h.errors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('CharacterTracker lifecycle', () => {
  it('stops detecting after stop() and resumes after start()', () => {
    const h = harness()

    h.bus.emit('level-up', levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    h.tracker.stop()
    expect(h.tracker.running).toBe(false)

    h.bus.emit('level-up', levelUp('WorldWordleChamp', 'Slayer', 98))
    // Left as it was: a death still in flight must not lose its `isSelf`.
    expect(h.tracker.active().name).toBe('LargeThumbThomasReturns')

    h.tracker.start()
    h.bus.emit('level-up', levelUp('WorldWordleChamp', 'Slayer', 98))
    expect(h.tracker.active().name).toBe('WorldWordleChamp')
  })

  it('is idempotent in both directions and detaches exactly one subscription', () => {
    const h = harness()

    h.tracker.start()
    h.tracker.start()
    h.bus.emit('level-up', levelUp('LargeThumbThomasReturns', 'Berserker', 93))
    // A second start() must not double-register. It would be invisible here thanks to
    // the change dedupe, so assert on the write instead.
    expect(h.writes).toHaveLength(1)

    h.tracker.stop()
    h.tracker.stop()
    h.bus.emit('level-up', levelUp('WorldWordleChamp', 'Slayer', 98))
    expect(h.writes).toHaveLength(1)
  })
})
