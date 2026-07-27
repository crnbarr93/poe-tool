/**
 * test/activity-derive.test.ts
 * ============================
 *
 * The two INFERENCES the Activity view makes, and the clocks it prints.
 *
 * WHY THESE HAVE TESTS AND THE REST OF THE VIEW DOES NOT
 * -----------------------------------------------------
 * Everything else on that screen is a field off the wire rendered as-is. These two are
 * poe-tool deciding something it was not told:
 *
 *   1. WHICH ZONE a death happened in. The log never says. It is reconstructed from the
 *      pair of lines the game writes a second apart, exactly as `ZoneTracker` does in
 *      main - and if this drifts from that, the Area column will disagree with the file
 *      name of the clip sitting next to it, which is the kind of inconsistency a user
 *      cannot resolve and can only distrust.
 *
 *   2. WHICH DEATH a clip belongs to. There is no id linking the two, so the badge is a
 *      match on time and character. A false positive here is the app telling somebody
 *      they have a recording of a death they have no recording of; they find out when
 *      they go looking for it. The cases below are the ones that would produce one:
 *      a `/kill`, a party member, a replayed backlog line, a debounced double death,
 *      and a clip that belongs to the death after this one.
 *
 * The functions are pure and React-free precisely so this file can exist: the dependency
 * set is frozen, so there is no DOM test environment to render the component in (the same
 * reasoning as `test/detection-swap.test.ts`).
 */

import { describe, expect, it } from 'vitest'

import type {
  AreaGeneratedEvent,
  DeathEvent,
  LevelUpEvent,
  LogLineMeta,
  PoeEvent,
  ZoneEnteredEvent
} from '../src/shared/events'
import type { ClipRecord } from '../src/shared/ipc'
import {
  deriveRowZones,
  eventDetail,
  eventTag,
  findLiveZoneKey,
  formatElapsed,
  formatSessionLength,
  matchClipsToDeaths,
  UNKNOWN,
  type Keyed
} from '../src/renderer/src/activity-derive'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Wall clock of the reference log's last death, as a local-time Date. */
const T0 = new Date(2026, 6, 26, 19, 26, 31).getTime()

/** Read time. Distinct from the wall clock above so the two can never be confused. */
const READ0 = 1_800_000_000_000

function meta(clientMs: number, offsetMs = 0, raw = 'line'): LogLineMeta {
  return {
    raw,
    timestamp: new Date(T0 + offsetMs),
    clientMs,
    threadTag: 'cffb0658',
    level: 'INFO',
    subsystem: 'Client',
    pid: 50396,
    isSystemMessage: true,
    body: raw
  }
}

interface Timing {
  /** `meta.clientMs` - the in-file clock. */
  readonly clientMs: number
  /** Offset from {@link T0} for both the wall clock and `detectedAt`. */
  readonly offsetMs: number
  readonly backlog?: boolean
}

function area(timing: Timing, areaId = '2_11_endgame_town', areaLevel = 69, seed = 12345): AreaGeneratedEvent {
  return {
    type: 'area-generated',
    meta: meta(timing.clientMs, timing.offsetMs),
    detectedAt: READ0 + timing.offsetMs,
    backlog: timing.backlog ?? false,
    areaId,
    areaLevel,
    seed
  }
}

function zone(timing: Timing, zoneName = 'Karui Shores'): ZoneEnteredEvent {
  return {
    type: 'zone-entered',
    meta: meta(timing.clientMs, timing.offsetMs),
    detectedAt: READ0 + timing.offsetMs,
    backlog: timing.backlog ?? false,
    zoneName
  }
}

function death(
  timing: Timing,
  characterName = 'FyascoWorbinTime',
  isSelf = true,
  cause: DeathEvent['cause'] = 'slain'
): DeathEvent {
  return {
    type: 'death',
    meta: meta(timing.clientMs, timing.offsetMs),
    detectedAt: READ0 + timing.offsetMs,
    backlog: timing.backlog ?? false,
    characterName,
    cause,
    isSelf
  }
}

function levelUp(timing: Timing): LevelUpEvent {
  return {
    type: 'level-up',
    meta: meta(timing.clientMs, timing.offsetMs),
    detectedAt: READ0 + timing.offsetMs,
    backlog: timing.backlog ?? false,
    characterName: 'LargeThumbThomas',
    className: 'Marauder',
    level: 2
  }
}

function clip(id: string, savedOffsetMs: number, characterName = 'FyascoWorbinTime'): ClipRecord {
  return {
    id,
    savedAt: READ0 + savedOffsetMs,
    originalPath: 'C:\\obs\\replay.mkv',
    finalPath: 'C:\\Videos\\poe-tool\\clip.mkv',
    zoneName: 'Karui Shores',
    areaId: '2_11_endgame_town',
    areaLevel: 69,
    characterName,
    cause: 'slain',
    moved: true,
    note: null,
    upload: { state: 'disabled' }
  }
}

/**
 * Builds a feed the way `useEventFeed` hands one over: NEWEST FIRST, each row carrying the
 * key React renders it under. The arguments are listed oldest first because that is how a
 * log reads; the array is reversed here so a test never has to think backwards.
 */
function feed<T>(prefix: string, ...oldestFirst: readonly T[]): readonly Keyed<T>[] {
  return oldestFirst
    .map((value, index) => ({ key: `${prefix}${index}`, value }))
    .reverse()
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

describe('formatSessionLength', () => {
  it('shows seconds for the first minute, so a fresh launch is not a motionless 0m', () => {
    expect(formatSessionLength(0)).toBe('0s')
    expect(formatSessionLength(45_000)).toBe('45s')
  })

  it('shows whole minutes, then hours and minutes', () => {
    expect(formatSessionLength(60_000)).toBe('1m')
    expect(formatSessionLength(59 * 60_000)).toBe('59m')
    expect(formatSessionLength(60 * 60_000)).toBe('1h 0m')
    expect(formatSessionLength(3 * 60 * 60_000 + 12 * 60_000)).toBe('3h 12m')
  })

  it('refuses rather than guessing when the arithmetic is impossible', () => {
    // An OS clock adjustment mid-session can make `now - startedAt` negative. "-4m" would
    // be a reading; an em-dash is the truth.
    expect(formatSessionLength(-1)).toBe(UNKNOWN)
    expect(formatSessionLength(Number.NaN)).toBe(UNKNOWN)
    expect(formatSessionLength(Number.POSITIVE_INFINITY)).toBe(UNKNOWN)
  })
})

describe('formatElapsed', () => {
  it('keeps seconds visible until the hour', () => {
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(4 * 60_000 + 12_000)).toBe('4m 12s')
    expect(formatElapsed(60 * 60_000 + 4 * 60_000)).toBe('1h 04m')
  })

  it('refuses a negative interval', () => {
    expect(formatElapsed(-5)).toBe(UNKNOWN)
  })
})

// ---------------------------------------------------------------------------
// The Area column
// ---------------------------------------------------------------------------

describe('deriveRowZones', () => {
  it('pairs the DEBUG area line with the INFO zone line that follows it', () => {
    // The ground-truth pair from the reference log: ~687ms apart in the file.
    const rows = feed<PoeEvent>(
      'e',
      area({ clientMs: 1_000_000, offsetMs: 0 }),
      zone({ clientMs: 1_000_687, offsetMs: 687 })
    )

    const zones = deriveRowZones(rows)

    expect(zones.get('e1')).toEqual({
      name: 'Karui Shores',
      qualifier: 'level 69',
      enteredAt: T0 + 687
    })
  })

  it('calls a seed-1 area static, matching what the event contract says it means', () => {
    const rows = feed<PoeEvent>(
      'e',
      area({ clientMs: 1_000_000, offsetMs: 0 }, '1_hideout', 68, 1),
      zone({ clientMs: 1_000_600, offsetMs: 600 }, 'Coastal Hideout')
    )

    expect(deriveRowZones(rows).get('e1')?.qualifier).toBe('level 68 · static')
  })

  it('carries the zone forward onto the deaths and level-ups that follow it', () => {
    const rows = feed<PoeEvent>(
      'e',
      area({ clientMs: 1_000_000, offsetMs: 0 }),
      zone({ clientMs: 1_000_687, offsetMs: 687 }),
      death({ clientMs: 1_090_000, offsetMs: 90_000 }),
      levelUp({ clientMs: 1_120_000, offsetMs: 120_000 })
    )

    const zones = deriveRowZones(rows)

    expect(zones.get('e2')?.name).toBe('Karui Shores')
    expect(zones.get('e3')?.name).toBe('Karui Shores')
  })

  it('leaves a row with no zone at all when none has been seen yet', () => {
    // The window can begin mid-session: the death is real, its area is simply not known,
    // and the column shows an em-dash rather than the next zone the player walked into.
    const rows = feed<PoeEvent>(
      'e',
      death({ clientMs: 900_000, offsetMs: 0 }),
      zone({ clientMs: 1_000_687, offsetMs: 60_000 })
    )

    expect(deriveRowZones(rows).has('e0')).toBe(false)
  })

  it('refuses to pair across a game restart, where clientMs goes backwards', () => {
    const rows = feed<PoeEvent>(
      'e',
      area({ clientMs: 5_000_000, offsetMs: 0 }),
      zone({ clientMs: 4_000, offsetMs: 3_000 })
    )

    // The zone is still reported - it is a real line - but it is NOT given the level and
    // seed of an area generated in a previous run of the game.
    expect(deriveRowZones(rows).get('e1')?.qualifier).toBeNull()
  })

  it('refuses to pair two lines that are far apart in the file but read in one batch', () => {
    // A post-rotation drain hands every line the same `detectedAt`, so the read-time window
    // cannot bound this on its own - `clientMs` is what says these are 45 minutes apart.
    const rows = feed<PoeEvent>(
      'e',
      area({ clientMs: 1_000_000, offsetMs: 0 }),
      zone({ clientMs: 3_700_000, offsetMs: 0 })
    )

    expect(deriveRowZones(rows).get('e1')?.qualifier).toBeNull()
  })

  it('shows the internal area id on the area row itself, never an invented name', () => {
    const rows = feed<PoeEvent>('e', area({ clientMs: 1_000_000, offsetMs: 0 }))

    expect(deriveRowZones(rows).get('e0')).toEqual({
      name: '2_11_endgame_town',
      qualifier: 'level 69',
      enteredAt: null
    })
  })
})

describe('findLiveZoneKey', () => {
  it('picks the newest zone line', () => {
    const rows = feed<PoeEvent>(
      'e',
      zone({ clientMs: 1_000_000, offsetMs: 0 }, 'The Coast'),
      zone({ clientMs: 1_200_000, offsetMs: 200_000 }, 'Karui Shores')
    )

    expect(findLiveZoneKey(rows)).toBe('e1')
  })

  it('refuses a backlog zone line, which may be from a session that ended yesterday', () => {
    const rows = feed<PoeEvent>(
      'e',
      zone({ clientMs: 1_000_000, offsetMs: 0, backlog: true }, 'Karui Shores')
    )

    // Otherwise the clock would claim the player has been standing in that area since
    // whenever the game was last open.
    expect(findLiveZoneKey(rows)).toBeNull()
  })

  it('has no answer when nothing in the window is a zone line', () => {
    expect(findLiveZoneKey(feed<PoeEvent>('e', death({ clientMs: 1, offsetMs: 0 })))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The clip badge
// ---------------------------------------------------------------------------

describe('matchClipsToDeaths', () => {
  it('badges the death a clip followed', () => {
    const events = feed<PoeEvent>('e', death({ clientMs: 1_000_000, offsetMs: 0 }))
    const clips = feed('c', clip('clip-1', 1_400))

    expect(matchClipsToDeaths(events, clips).get('e0')?.id).toBe('clip-1')
  })

  it('never badges a /kill, a party member, or a replayed backlog line', () => {
    const events = feed<PoeEvent>(
      'e',
      death({ clientMs: 1_000_000, offsetMs: 0 }, 'FyascoWorbinTime', true, 'suicide'),
      death({ clientMs: 1_010_000, offsetMs: 10_000 }, 'SomeoneElse', false),
      death({ clientMs: 1_020_000, offsetMs: 20_000, backlog: true })
    )
    // Three clips, so nothing is left unbadged for want of one.
    const clips = feed('c', clip('c1', 1_000), clip('c2', 11_000), clip('c3', 21_000))

    expect(matchClipsToDeaths(events, clips).size).toBe(0)
  })

  it('gives a debounced double death its one clip, and does not invent a second', () => {
    // `clips.debounceMs` suppressed the save for the second line; only one clip exists, and
    // it belongs to the death that opened the window.
    const events = feed<PoeEvent>(
      'e',
      death({ clientMs: 1_000_000, offsetMs: 0 }),
      death({ clientMs: 1_002_000, offsetMs: 2_000 })
    )
    const clips = feed('c', clip('clip-1', 3_000))

    const matched = matchClipsToDeaths(events, clips)

    expect(matched.get('e0')?.id).toBe('clip-1')
    expect(matched.has('e1')).toBe(false)
  })

  it('keeps two unrelated deaths on their own clips', () => {
    const events = feed<PoeEvent>(
      'e',
      death({ clientMs: 1_000_000, offsetMs: 0 }),
      death({ clientMs: 1_020_000, offsetMs: 20_000 })
    )
    const clips = feed('c', clip('clip-1', 1_000), clip('clip-2', 21_000))

    const matched = matchClipsToDeaths(events, clips)

    // The second clip is inside the FIRST death's 30s window too; a "nearest clip" rule
    // would have handed clip-2 to the wrong row.
    expect(matched.get('e0')?.id).toBe('clip-1')
    expect(matched.get('e1')?.id).toBe('clip-2')
  })

  it('never claims a clip that was saved before the death', () => {
    const events = feed<PoeEvent>('e', death({ clientMs: 1_000_000, offsetMs: 10_000 }))
    const clips = feed('c', clip('clip-1', 9_000))

    expect(matchClipsToDeaths(events, clips).size).toBe(0)
  })

  it('never claims a clip from far enough away to be a different death', () => {
    const events = feed<PoeEvent>('e', death({ clientMs: 1_000_000, offsetMs: 0 }))
    const clips = feed('c', clip('clip-1', 31_000))

    expect(matchClipsToDeaths(events, clips).size).toBe(0)
  })

  it('never crosses characters', () => {
    const events = feed<PoeEvent>('e', death({ clientMs: 1_000_000, offsetMs: 0 }, 'Someone'))
    const clips = feed('c', clip('clip-1', 1_000, 'SomebodyElse'))

    expect(matchClipsToDeaths(events, clips).size).toBe(0)
  })

  it('matches case-insensitively, and lets a clip with no recorded character through', () => {
    const events = feed<PoeEvent>(
      'e',
      death({ clientMs: 1_000_000, offsetMs: 0 }, ' fyascoworbintime '),
      death({ clientMs: 1_020_000, offsetMs: 20_000 })
    )
    // `''` is the documented "nobody was resolved at capture time" - it cannot disagree
    // with a name, so it must not veto the match either.
    const clips = feed('c', clip('clip-1', 500), clip('clip-2', 20_500, ''))

    const matched = matchClipsToDeaths(events, clips)

    expect(matched.get('e0')?.id).toBe('clip-1')
    expect(matched.get('e1')?.id).toBe('clip-2')
  })
})

// ---------------------------------------------------------------------------
// Row copy
// ---------------------------------------------------------------------------

describe('eventDetail', () => {
  it('says a /kill of yours was deliberate and was never clipped', () => {
    // The one case where a death of yours legitimately produces nothing. Left unexplained,
    // it looks like the app failing at the exact moment it is behaving correctly.
    const detail = eventDetail(
      death({ clientMs: 1, offsetMs: 0 }, 'FyascoWorbinTime', true, 'suicide')
    )

    expect(detail).toContain('/kill')
    expect(detail).toContain('never clipped')
  })

  it('names a party member and says their death was ignored', () => {
    const detail = eventDetail(death({ clientMs: 1, offsetMs: 0 }, 'PartyFriend', false))

    expect(detail).toContain('PartyFriend')
    expect(detail).toContain('ignored')
  })

  it('calls out a static area rather than showing a bare seed of 1', () => {
    expect(eventDetail(area({ clientMs: 1, offsetMs: 0 }, '1_hideout', 68, 1))).toContain(
      'town or hideout'
    )
  })
})

describe('eventTag', () => {
  it('tags deaths with the accent, zones and areas neutral, level-ups outlined', () => {
    expect(eventTag(death({ clientMs: 1, offsetMs: 0 })).className).toBe('tag tag-accent')
    expect(eventTag(zone({ clientMs: 1, offsetMs: 0 })).className).toBe('tag tag-neutral')
    expect(eventTag(area({ clientMs: 1, offsetMs: 0 })).className).toBe('tag tag-neutral')
    expect(eventTag(levelUp({ clientMs: 1, offsetMs: 0 })).className).toBe('tag tag-outline')
  })

  it('labels a /kill as one, so it is never mistaken for a death that should have clipped', () => {
    expect(
      eventTag(death({ clientMs: 1, offsetMs: 0 }, 'FyascoWorbinTime', true, 'suicide')).label
    ).toBe('/kill')
  })
})
