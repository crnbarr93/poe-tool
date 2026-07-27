/**
 * test/zone-tracker.test.ts
 * =========================
 *
 * The two-line merge: `Generating level 69 area "2_11_endgame_town" with seed 1`
 * (DEBUG, ~1s early, carries the ids) and `You have entered Karui Shores.` (INFO,
 * carries the name). Getting this wrong does not crash anything - it silently
 * mislabels every clip for the rest of the session, which is why the ordering and
 * expiry cases are all covered explicitly.
 *
 * Driven through a REAL `PoeEventBus`, because "wire the tracker to the app bus" is
 * the only way it is ever used, and events come from the REAL `parseLine` so a
 * regression in the patterns surfaces here too.
 */

import { describe, expect, it } from 'vitest'

import { PoeEventBus } from '../src/main/events/event-bus'
import { parseLine } from '../src/main/log/parse-line'
import { DEFAULT_PAIRING_WINDOW_MS, ZoneTracker } from '../src/main/log/zone-tracker'
import type { AreaGeneratedEvent, CurrentZone, ZoneEnteredEvent } from '../src/shared/events'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AREA_LINE =
  '2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1'
const ZONE_LINE =
  '2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'
const OTHER_AREA_LINE =
  '2026/07/26 19:31:02 1018683171 1186a8a3 [DEBUG Client 50396] Generating level 83 area "MapWorldsCrypt" with seed 848291'
const OTHER_ZONE_LINE =
  '2026/07/26 19:31:03 1018684171 cffb0658 [INFO Client 50396] : You have entered Crypt.'

const T0 = 1_700_000_000_000

/** Parses a known area line. Throws loudly if the pattern ever stops matching. */
function area(line: string, detectedAt: number, backlog = false): AreaGeneratedEvent {
  const parsed = parseLine(line, { detectedAt, backlog, selfName: '' })
  if (parsed.type !== 'area-generated') throw new Error(`not an area line: ${line}`)
  return parsed
}

/** Parses a known zone line. Throws loudly if the pattern ever stops matching. */
function zone(line: string, detectedAt: number, backlog = false): ZoneEnteredEvent {
  const parsed = parseLine(line, { detectedAt, backlog, selfName: '' })
  if (parsed.type !== 'zone-entered') throw new Error(`not a zone line: ${line}`)
  return parsed
}

interface Harness {
  readonly bus: PoeEventBus
  readonly tracker: ZoneTracker
  readonly changes: CurrentZone[]
}

function harness(pairingWindowMs?: number): Harness {
  const bus = new PoeEventBus()
  const changes: CurrentZone[] = []
  bus.on('zone-changed', (z) => changes.push(z))
  const tracker = new ZoneTracker(
    pairingWindowMs === undefined ? { bus, clock: () => T0 } : { bus, clock: () => T0, pairingWindowMs }
  )
  return { bus, tracker, changes }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('ZoneTracker initial state', () => {
  it('reports an all-unknown zone before anything has been seen', () => {
    const { tracker, changes } = harness()

    expect(tracker.current).toEqual({
      displayName: null,
      areaId: null,
      areaLevel: null,
      seed: null,
      enteredAt: T0
    })
    // The initial zone is not a TRANSITION, so nothing is announced.
    expect(changes).toHaveLength(0)
  })

  it('subscribes in the constructor, with no separate start() step', () => {
    const { bus, tracker } = harness()
    expect(tracker.running).toBe(true)

    bus.publish(zone(ZONE_LINE, T0))

    expect(tracker.current.displayName).toBe('Karui Shores')
  })
})

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

describe('ZoneTracker merging', () => {
  it('merges the DEBUG area line into the INFO zone line that follows it', () => {
    const { bus, tracker, changes } = harness()

    // Real ordering: generating fires ~1s BEFORE "You have entered".
    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_000))

    expect(tracker.current).toEqual({
      displayName: 'Karui Shores',
      areaId: '2_11_endgame_town',
      areaLevel: 69,
      seed: 1,
      enteredAt: T0 + 1_000
    })
    // Exactly ONE announcement per transition: the area line only arms the merge.
    expect(changes).toEqual([tracker.current])
  })

  it('announces nothing on the area line alone', () => {
    const { bus, tracker, changes } = harness()

    bus.publish(area(AREA_LINE, T0))

    expect(changes).toHaveLength(0)
    // A snapshot taken in this one-second gap must not report a half-built zone.
    expect(tracker.current.displayName).toBeNull()
    expect(tracker.current.areaId).toBeNull()
  })

  it('reports a zone with null ids when no area line preceded it', () => {
    const { bus, tracker } = harness()

    // Attaching mid-session: the "Generating level" line was before we were watching.
    bus.publish(zone(ZONE_LINE, T0))

    expect(tracker.current).toEqual({
      displayName: 'Karui Shores',
      areaId: null,
      areaLevel: null,
      seed: null,
      enteredAt: T0
    })
  })

  it('consumes the pending area so it cannot be reused by the next zone', () => {
    const { bus, tracker } = harness()

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_000))
    // Second transition with NO area line of its own (some transitions log only one
    // of the two). It must not inherit the first zone's ids.
    bus.publish(zone(OTHER_ZONE_LINE, T0 + 2_000))

    expect(tracker.current).toEqual({
      displayName: 'Crypt',
      areaId: null,
      areaLevel: null,
      seed: null,
      enteredAt: T0 + 2_000
    })
  })

  it('lets a newer area line supersede an unconsumed older one', () => {
    const { bus, tracker } = harness()

    bus.publish(area(AREA_LINE, T0))
    bus.publish(area(OTHER_AREA_LINE, T0 + 500))
    bus.publish(zone(OTHER_ZONE_LINE, T0 + 1_500))

    expect(tracker.current.areaId).toBe('MapWorldsCrypt')
    expect(tracker.current.areaLevel).toBe(83)
    expect(tracker.current.seed).toBe(848_291)
  })

  it('preserves seed 1, the marker for a non-procedural town/hideout', () => {
    const { bus, tracker } = harness()

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_000))

    // 0 would be falsy-adjacent and 1 is easy to lose to a `|| null`; assert it.
    expect(tracker.current.seed).toBe(1)
  })

  it('tracks consecutive transitions independently', () => {
    const { bus, tracker, changes } = harness()

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_000))
    bus.publish(area(OTHER_AREA_LINE, T0 + 60_000))
    bus.publish(zone(OTHER_ZONE_LINE, T0 + 61_000))

    expect(changes.map((z) => z.displayName)).toEqual(['Karui Shores', 'Crypt'])
    expect(changes.map((z) => z.areaId)).toEqual(['2_11_endgame_town', 'MapWorldsCrypt'])
    expect(tracker.current).toBe(changes[1])
  })
})

// ---------------------------------------------------------------------------
// The pairing window
// ---------------------------------------------------------------------------

describe('ZoneTracker pairing window', () => {
  it('drops an area line that is older than the window', () => {
    const { bus, tracker } = harness(1_000)

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_001))

    // Better a zone with unknown ids than a zone confidently labelled with the
    // WRONG ids - that is a mislabelled clip the user cannot detect.
    expect(tracker.current.displayName).toBe('Karui Shores')
    expect(tracker.current.areaId).toBeNull()
  })

  it('accepts an area line exactly at the window boundary', () => {
    const { bus, tracker } = harness(1_000)

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_000))

    expect(tracker.current.areaId).toBe('2_11_endgame_town')
  })

  it('pairs lines read in the same tick, whose detectedAt is identical', () => {
    const { bus, tracker } = harness(0)

    // A single readDelta() stamps every line it decoded with one detectedAt, so a
    // pair drained together has a delta of zero and must still pair - even with the
    // window closed to nothing.
    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0))

    expect(tracker.current.areaId).toBe('2_11_endgame_town')
  })

  it('does not discard an area line when the clock jumped backwards', () => {
    const { bus, tracker } = harness(1_000)

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 - 5_000))

    expect(tracker.current.areaId).toBe('2_11_endgame_town')
  })

  it('clears an expired area line instead of re-testing it forever', () => {
    const { bus, tracker } = harness(1_000)

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 9_999))
    expect(tracker.current.areaId).toBeNull()

    // A stale area kept around could never become valid again, but WOULD be within
    // the window of some later zone if it were re-stamped. It is gone.
    bus.publish(zone(OTHER_ZONE_LINE, T0 + 10_000))
    expect(tracker.current.areaId).toBeNull()
  })

  it('refuses to pair lines that are far apart IN THE FILE but share one detectedAt', () => {
    // REGRESSION: `log-watcher` stamps every line of ONE read with a single
    // `Date.now()`, so inside a batch the read-time delta is always 0 and the
    // read-time window is inert. A post-rotation drain (or a `tail:debug` replay)
    // hands over the whole file in such batches, so an area line from hours earlier
    // would merge into an unrelated zone - here labelling the town of Karui Shores
    // (a static `2_11_endgame_town`, seed 1) as a level-83 procedural map, and
    // mislabelling every clip for the rest of the session.
    const { bus, tracker } = harness()

    const staleArea =
      '2026/07/26 10:00:00 100000 1186a8a3 [DEBUG Client 50396] Generating level 83 area "MapWorldsCrypt" with seed 848291'
    const muchLaterZone =
      '2026/07/26 12:00:00 7300000 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'

    // Same detectedAt: exactly what one readDelta() produces.
    bus.publish(area(staleArea, T0, true))
    bus.publish(zone(muchLaterZone, T0, true))

    expect(tracker.current.displayName).toBe('Karui Shores')
    expect(tracker.current.areaId).toBeNull()
    expect(tracker.current.areaLevel).toBeNull()
    expect(tracker.current.seed).toBeNull()
  })

  it('still pairs a whole batch of backlog lines that belong together', () => {
    // The other half of the same rule: a drained backlog must STILL produce a
    // correct current zone, or every clip after a rotation loses its area id.
    const { bus, tracker } = harness()

    bus.publish(area(AREA_LINE, T0, true))
    bus.publish(zone(ZONE_LINE, T0, true))
    bus.publish(area(OTHER_AREA_LINE, T0, true))
    bus.publish(zone(OTHER_ZONE_LINE, T0, true))

    expect(tracker.current.displayName).toBe('Crypt')
    expect(tracker.current.areaId).toBe('MapWorldsCrypt')
    expect(tracker.current.areaLevel).toBe(83)
  })

  it('refuses to pair an area line that comes AFTER its zone line in the log', () => {
    // Out of order in the file means they are not a pair, and the buffered area
    // would otherwise leak into the NEXT zone.
    const { bus, tracker } = harness()

    // OTHER_AREA_LINE is at clientMs 1018683171; ZONE_LINE at 1018543171 - earlier.
    bus.publish(area(OTHER_AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0))

    expect(tracker.current.displayName).toBe('Karui Shores')
    expect(tracker.current.areaId).toBeNull()
  })

  it('honours an explicit in-file window override', () => {
    const bus = new PoeEventBus()
    // The ground-truth pair is 687ms apart in the log.
    const tracker = new ZoneTracker({ bus, clock: () => T0, inFileWindowMs: 500 })

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + 1_000))

    expect(tracker.current.areaId).toBeNull()
  })

  it('falls back to the default window for a non-finite override', () => {
    const bus = new PoeEventBus()
    const tracker = new ZoneTracker({ bus, pairingWindowMs: Number.NaN })

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + DEFAULT_PAIRING_WINDOW_MS))
    expect(tracker.current.areaId).toBe('2_11_endgame_town')

    bus.publish(area(AREA_LINE, T0))
    bus.publish(zone(ZONE_LINE, T0 + DEFAULT_PAIRING_WINDOW_MS + 1))
    expect(tracker.current.areaId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

describe('ZoneTracker backlog handling', () => {
  it('processes backlog events - this is state, not a side effect', () => {
    const { bus, tracker, changes } = harness()

    bus.publish(area(AREA_LINE, T0, true))
    bus.publish(zone(ZONE_LINE, T0 + 1_000, true))

    // After a rotation re-read, the last zone in the backlog IS where the player is
    // standing. Skipping it would mislabel every clip for the rest of the session.
    expect(tracker.current.displayName).toBe('Karui Shores')
    expect(tracker.current.areaId).toBe('2_11_endgame_town')
    expect(changes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('ZoneTracker lifecycle', () => {
  it('stops updating after stop() and resumes after start()', () => {
    const { bus, tracker } = harness()

    bus.publish(zone(ZONE_LINE, T0))
    tracker.stop()
    expect(tracker.running).toBe(false)

    bus.publish(zone(OTHER_ZONE_LINE, T0 + 1_000))
    // Left as it was: a clip still mid-move must not lose its zone metadata.
    expect(tracker.current.displayName).toBe('Karui Shores')

    tracker.start()
    bus.publish(zone(OTHER_ZONE_LINE, T0 + 2_000))
    expect(tracker.current.displayName).toBe('Crypt')
  })

  it('drops a half-formed pairing on stop()', () => {
    const { bus, tracker } = harness()

    bus.publish(area(AREA_LINE, T0))
    tracker.stop()
    tracker.start()
    bus.publish(zone(ZONE_LINE, T0 + 1_000))

    expect(tracker.current.areaId).toBeNull()
  })

  it('is idempotent in both directions and detaches exactly one subscription', () => {
    const { bus, tracker, changes } = harness()

    tracker.start()
    tracker.start()
    bus.publish(zone(ZONE_LINE, T0))
    // A second start() must not double-register, or every zone would announce twice.
    expect(changes).toHaveLength(1)

    tracker.stop()
    tracker.stop()
    bus.publish(zone(OTHER_ZONE_LINE, T0 + 1_000))
    expect(changes).toHaveLength(1)
  })

  it('contains a throwing zone-changed listener', () => {
    const errors: unknown[] = []
    const bus = new PoeEventBus()
    const tracker = new ZoneTracker({ bus, onError: (error) => errors.push(error) })

    const boom = new Error('subscriber exploded')
    bus.on('zone-changed', () => {
      throw boom
    })

    // Runs inside the tail loop's setInterval callback; a throw here kills the app.
    expect(() => bus.publish(zone(ZONE_LINE, T0))).not.toThrow()
    expect(errors).toEqual([boom])
    // The state update happens BEFORE the announcement, so it survives the failure.
    expect(tracker.current.displayName).toBe('Karui Shores')
  })
})
