/**
 * test/session-stats.test.ts
 * ==========================
 *
 * The session counters. Nothing here crashes when it goes wrong - a wrong count is just a
 * number on screen that nobody can check against anything, which is exactly why every
 * rule that decides whether an event counts is pinned down explicitly:
 *
 *  - BACKLOG IS NOT COUNTED. PoE truncates Client.txt mid-session and the re-read hands
 *    the watcher back a stretch of file it has already seen. Counting it would jump the
 *    death total by fifty in one tick, and no user could tell that from a terrible map.
 *  - PARTY DEATHS ARE NOT COUNTED. `death` carries everyone's; only `isSelf` is ours.
 *  - SUICIDES ARE COUNTED, AND ALSO COUNTED SEPARATELY. `/kill` is a real death (see
 *    `src/shared/events.ts`), so it belongs in the total - but it is the one death that
 *    never becomes a clip, so `deaths - suicides` has to stay recoverable.
 *  - THE COUNTS ARE LIVE, not derived from any bounded buffer. The last test in the file
 *    drives more events than the IPC layer's 200-entry ring buffer holds and checks the
 *    totals still reflect all of them.
 *
 * Driven through a REAL `PoeEventBus` with events from the REAL `parseLine`, matching
 * `test/zone-tracker.test.ts`: "wired to the app bus" is the only way this class is ever
 * used, and a regression in the patterns surfaces here too.
 */

import { describe, expect, it } from 'vitest'

import { PoeEventBus } from '../src/main/events/event-bus'
import { parseLine } from '../src/main/log/parse-line'
import { SessionStats, type SessionCharacterSource } from '../src/main/stats/session-stats'
import type { ActiveCharacter, DeathEvent, ZoneEnteredEvent } from '../src/shared/events'
import type { SessionStatsSnapshot } from '../src/shared/ipc'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ZONE_LINE =
  '2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'
const OTHER_ZONE_LINE =
  '2026/07/26 19:31:03 1018684171 cffb0658 [INFO Client 50396] : You have entered Crypt.'
const SLAIN_LINE =
  '2026/07/26 19:29:02 1018563171 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
const SUICIDE_LINE =
  '2026/07/26 19:29:32 1018593171 cffb0658 [INFO Client 50396] : FyascoWorbinTime has committed suicide.'
const PARTY_SLAIN_LINE =
  '2026/07/26 19:29:52 1018613171 cffb0658 [INFO Client 50396] : SomebodyElse has been slain.'

const SELF = 'FyascoWorbinTime'
const T0 = 1_700_000_000_000

/** Parses a known zone line. Throws loudly if the pattern ever stops matching. */
function zone(detectedAt: number, backlog = false, line = ZONE_LINE): ZoneEnteredEvent {
  const parsed = parseLine(line, { detectedAt, backlog, selfName: SELF })
  if (parsed.type !== 'zone-entered') throw new Error(`not a zone line: ${line}`)
  return parsed
}

/**
 * Parses a known death line. `selfName` is what stamps `isSelf`, exactly as the watcher
 * does per line - so a party death is produced by parsing with OUR name and a line naming
 * somebody else, never by hand-building an event with `isSelf: false`.
 */
function death(line: string, detectedAt: number, backlog = false): DeathEvent {
  const parsed = parseLine(line, { detectedAt, backlog, selfName: SELF })
  if (parsed.type !== 'death') throw new Error(`not a death line: ${line}`)
  return parsed
}

/** A character source in the shape `CharacterTracker` satisfies. */
function characterAt(level: number | null): SessionCharacterSource {
  const active: ActiveCharacter = {
    name: SELF,
    className: 'Marauder',
    level,
    source: 'detected'
  }
  return { active: () => active }
}

interface Harness {
  readonly bus: PoeEventBus
  readonly stats: SessionStats
  /** Every snapshot broadcast on the `stats` channel, in order. */
  readonly pushes: readonly SessionStatsSnapshot[]
  /** Moves the injected clock. */
  readonly advance: (ms: number) => void
}

function harness(characters: SessionCharacterSource = characterAt(93)): Harness {
  const bus = new PoeEventBus()
  let now = T0

  const pushes: SessionStatsSnapshot[] = []
  const stats = new SessionStats({ bus, characters, clock: () => now })
  stats.on('stats', (snapshot) => pushes.push(snapshot))

  return {
    bus,
    stats,
    pushes,
    advance: (ms) => {
      now += ms
    }
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('SessionStats initial state', () => {
  it('starts at zero, stamped with the injected clock', () => {
    const { stats } = harness()

    expect(stats.snapshot).toEqual({
      startedAt: T0,
      uptimeMs: 0,
      areasEntered: 0,
      deaths: 0,
      suicides: 0,
      characterLevel: 93
    })
  })

  it('subscribes in the constructor, with no separate start() step', () => {
    const { bus, stats } = harness()
    expect(stats.running).toBe(true)

    bus.publish(zone(T0))

    expect(stats.snapshot.areasEntered).toBe(1)
  })

  it('announces nothing for the starting state', () => {
    const { pushes } = harness()
    // Startup is not a CHANGE. A window that opens later asks `stats:session`.
    expect(pushes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

describe('SessionStats counting', () => {
  it('counts every area entered, towns and hideouts included', () => {
    const { bus, stats } = harness()

    bus.publish(zone(T0))
    bus.publish(zone(T0 + 1_000, false, OTHER_ZONE_LINE))
    bus.publish(zone(T0 + 2_000))

    expect(stats.snapshot.areasEntered).toBe(3)
  })

  it('counts our own deaths', () => {
    const { bus, stats } = harness()

    bus.publish(death(SLAIN_LINE, T0))
    bus.publish(death(SLAIN_LINE, T0 + 1_000))

    expect(stats.snapshot.deaths).toBe(2)
    expect(stats.snapshot.suicides).toBe(0)
  })

  it('pushes a complete snapshot on every counted event', () => {
    const { bus, pushes } = harness()

    bus.publish(zone(T0))
    bus.publish(death(SLAIN_LINE, T0 + 1_000))

    expect(pushes.map((p) => ({ areas: p.areasEntered, deaths: p.deaths }))).toEqual([
      { areas: 1, deaths: 0 },
      { areas: 1, deaths: 1 }
    ])
  })

  it('keeps counting after stop() is called for the events it already saw', () => {
    const { bus, stats } = harness()

    bus.publish(zone(T0))
    stats.stop()
    bus.publish(zone(T0 + 1_000))

    // Detached, so the second area is not counted - but the first is NOT forgotten.
    // `stop()` only unsubscribes; blanking the totals on the way down would make a
    // `stats:session` answered during shutdown report a session that never happened.
    expect(stats.running).toBe(false)
    expect(stats.snapshot.areasEntered).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

describe('SessionStats backlog handling', () => {
  it('ignores backlog areas and backlog deaths', () => {
    const { bus, stats, pushes } = harness()

    bus.publish(zone(T0, true))
    bus.publish(death(SLAIN_LINE, T0, true))
    bus.publish(death(SUICIDE_LINE, T0, true))

    expect(stats.snapshot.areasEntered).toBe(0)
    expect(stats.snapshot.deaths).toBe(0)
    expect(stats.snapshot.suicides).toBe(0)
    // Nothing moved, so nothing is announced either.
    expect(pushes).toHaveLength(0)
  })

  it('counts live events that arrive in the same batch as backlog ones', () => {
    const { bus, stats } = harness()

    // A rotation drain: the file is re-read with `backlog: true`, and the lines written
    // after we re-attached arrive live. Only the live ones are this session's.
    bus.publish(zone(T0, true))
    bus.publish(zone(T0, true))
    bus.publish(zone(T0 + 500, false))

    expect(stats.snapshot.areasEntered).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Whose death
// ---------------------------------------------------------------------------

describe('SessionStats death attribution', () => {
  it('does not count a party member dying', () => {
    const { bus, stats, pushes } = harness()

    const partyDeath = death(PARTY_SLAIN_LINE, T0)
    // Guard the fixture itself: if `isSelf` ever stopped being stamped from `selfName`,
    // this test would pass for the wrong reason.
    expect(partyDeath.isSelf).toBe(false)

    bus.publish(partyDeath)

    expect(stats.snapshot.deaths).toBe(0)
    expect(pushes).toHaveLength(0)
  })

  it('counts nothing at all when no character is resolved', () => {
    // `source: 'none'` is the state in which `isSelf` is false for every line and the
    // clipper sits idle. The counters must agree with the clipper, not paper over it.
    const nobody: SessionCharacterSource = {
      active: () => ({ name: null, className: null, level: null, source: 'none' })
    }
    const bus = new PoeEventBus()
    const stats = new SessionStats({ bus, characters: nobody, clock: () => T0 })

    const parsed = parseLine(SLAIN_LINE, { detectedAt: T0, backlog: false, selfName: '' })
    if (parsed.type !== 'death') throw new Error('not a death line')
    bus.publish(parsed)

    expect(stats.snapshot.deaths).toBe(0)
    expect(stats.snapshot.characterLevel).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Suicides
// ---------------------------------------------------------------------------

describe('SessionStats suicides', () => {
  it('counts a suicide separately from a slain death, and in the total', () => {
    const { bus, stats } = harness()

    bus.publish(death(SLAIN_LINE, T0))
    bus.publish(death(SUICIDE_LINE, T0 + 1_000))

    const snapshot = stats.snapshot
    // `/kill` IS a death - `src/shared/events.ts` is explicit that death counts include
    // it, and the event feed beside this number shows it - so the total is 2...
    expect(snapshot.deaths).toBe(2)
    // ...and the separate counter is what explains why only ONE of them could ever have
    // produced a clip.
    expect(snapshot.suicides).toBe(1)
    expect(snapshot.deaths - snapshot.suicides).toBe(1)
  })

  it('does not count a party member’s suicide', () => {
    const { bus, stats } = harness()

    const parsed = parseLine(
      '2026/07/26 19:29:32 1018593171 cffb0658 [INFO Client 50396] : SomebodyElse has committed suicide.',
      { detectedAt: T0, backlog: false, selfName: SELF }
    )
    if (parsed.type !== 'death') throw new Error('not a death line')
    expect(parsed.cause).toBe('suicide')

    bus.publish(parsed)

    expect(stats.snapshot.deaths).toBe(0)
    expect(stats.snapshot.suicides).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

describe('SessionStats uptime', () => {
  it('derives uptime from the injected clock, against a fixed origin', () => {
    const { stats, advance } = harness()

    advance(90_000)
    expect(stats.snapshot).toMatchObject({ startedAt: T0, uptimeMs: 90_000 })

    advance(30_000)
    expect(stats.snapshot).toMatchObject({ startedAt: T0, uptimeMs: 120_000 })
  })

  it('clamps a backwards clock jump to zero rather than reporting a negative session', () => {
    const { stats, advance } = harness()

    // An OS clock correction (or a DST-naive VM) mid-session.
    advance(-60_000)

    expect(stats.snapshot.uptimeMs).toBe(0)
    // The origin does NOT move: it is this session's identity, read once.
    expect(stats.snapshot.startedAt).toBe(T0)
  })

  it('does not announce anything just because time passed', () => {
    const { pushes, advance } = harness()

    advance(600_000)

    // `uptimeMs` is excluded from the change comparison on purpose - a push per tick
    // would be a permanent heartbeat into an idle window for a value it can compute.
    expect(pushes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The character's level
// ---------------------------------------------------------------------------

describe('SessionStats character level', () => {
  it('reads the level from the tracker rather than counting level-ups', () => {
    let level: number | null = 92
    const characters: SessionCharacterSource = {
      active: () => ({ name: SELF, className: 'Marauder', level, source: 'detected' })
    }
    const { stats } = harness(characters)

    expect(stats.snapshot.characterLevel).toBe(92)

    // The tracker moved (a level-up, or a detection read back from settings.json). No
    // event was published here at all, and the snapshot is still current - which is what
    // "read, not tracked" means.
    level = 93
    expect(stats.snapshot.characterLevel).toBe(93)
  })

  it('announces when character-changed reports a new level', () => {
    let level: number | null = 92
    const characters: SessionCharacterSource = {
      active: () => ({ name: SELF, className: 'Marauder', level, source: 'detected' })
    }
    const { bus, pushes } = harness(characters)

    level = 93
    bus.emit('character-changed', { name: SELF, className: 'Marauder', level: 93, source: 'detected' })

    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.characterLevel).toBe(93)
  })

  it('says nothing when character-changed did not move the level', () => {
    const { bus, pushes } = harness(characterAt(93))

    // The user re-saved an override, or re-typed the same name: `character-changed` fires,
    // but nothing this snapshot reports has moved.
    bus.emit('character-changed', { name: SELF, className: 'Marauder', level: 93, source: 'override' })

    expect(pushes).toHaveLength(0)
  })

  it('reports null for an unreadable or non-finite level instead of NaN', () => {
    const broken: SessionCharacterSource = {
      active: () => {
        throw new Error('tracker exploded')
      }
    }
    const bus = new PoeEventBus()
    const errors: unknown[] = []
    const stats = new SessionStats({
      bus,
      characters: broken,
      clock: () => T0,
      onError: (error) => errors.push(error)
    })

    // Never throws out of the getter - it is called from an IPC handler and from inside
    // the tail loop's thread of control.
    expect(stats.snapshot.characterLevel).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The point of the whole class
// ---------------------------------------------------------------------------

describe('SessionStats totals are live, not derived from a bounded buffer', () => {
  it('keeps counting past the size of the events:recent ring buffer', () => {
    const { bus, stats } = harness()

    // `RECENT_EVENTS_LIMIT` is 200. A count derived from that buffer would have evicted
    // the early deaths by now and would report fewer than were published - silently, and
    // in the direction that makes a bad session look like a good one.
    for (let i = 0; i < 250; i++) {
      bus.publish(zone(T0 + i))
      bus.publish(death(SLAIN_LINE, T0 + i))
    }

    expect(stats.snapshot.areasEntered).toBe(250)
    expect(stats.snapshot.deaths).toBe(250)
  })

  it('never lets a throwing listener stop the counting', () => {
    const { bus, stats } = harness()
    stats.on('stats', () => {
      throw new Error('a dead window')
    })

    bus.publish(zone(T0))
    bus.publish(death(SLAIN_LINE, T0 + 1))

    expect(stats.snapshot).toMatchObject({ areasEntered: 1, deaths: 1 })
  })
})
