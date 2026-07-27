/**
 * test/event-bus.test.ts
 * ======================
 *
 * `PoeEventBus.publish` - the ONE fan-out rule the whole app depends on - and its
 * promise that a throwing listener cannot escape.
 *
 * Events are produced by the REAL `parseLine` against the real Client.txt sample
 * lines rather than hand-built literals. A hand-built `DeathEvent` would keep these
 * tests passing even if the parser stopped setting `isSelf`, which is precisely the
 * bug that would silently disable clipping.
 */

import { describe, expect, it } from 'vitest'

import { PoeEventBus } from '../src/main/events/event-bus'
import { parseLine } from '../src/main/log/parse-line'
import type {
  AreaGeneratedEvent,
  DeathEvent,
  LevelUpEvent,
  ParseResult,
  PoeEventChannel,
  UnmatchedLine,
  ZoneEnteredEvent
} from '../src/shared/events'

// ---------------------------------------------------------------------------
// Fixtures - the verified ground-truth lines
// ---------------------------------------------------------------------------

const DEATH_LINE =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
const ZONE_LINE =
  '2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'
const AREA_LINE =
  '2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1'
/** PoE's `/kill`. A real death - it just must never become a clip. */
const SUICIDE_LINE =
  '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : LargeThumbThomasReturns has committed suicide.'
/** The line auto-detection is built on. Verbatim; note the absent trailing period. */
const LEVEL_UP_LINE =
  '2026/07/26 13:26:59 996840125 cffb0658 [INFO Client 53252] : FyascoWorbinTime (Elementalist) is now level 92'
/** Player chat: the system marker is absent, so nothing may ever match it. */
const CHAT_LINE =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] Bob: FyascoWorbinTime has been slain.'

const DETECTED_AT = 1_700_000_000_000

function parse(line: string, selfName = 'FyascoWorbinTime', backlog = false): ParseResult {
  return parseLine(line, { detectedAt: DETECTED_AT, backlog, selfName })
}

/**
 * Records every channel a publish touched, in order, with the payload.
 *
 * SUBSCRIBES TO EVERY CHANNEL IN `PoeEventMap`, including the derived-state ones
 * (`zone-changed`, `character-changed`) that `publish` must never touch. That is
 * what turns each `toEqual` below into a statement about the whole bus rather than
 * about the handful of channels a test happened to think of.
 */
function recorder(bus: PoeEventBus): Array<[PoeEventChannel, unknown]> {
  const seen: Array<[PoeEventChannel, unknown]> = []
  bus.on('event', (e) => seen.push(['event', e]))
  bus.on('death', (e) => seen.push(['death', e]))
  bus.on('death:self', (e) => seen.push(['death:self', e]))
  bus.on('zone-entered', (e) => seen.push(['zone-entered', e]))
  bus.on('area-generated', (e) => seen.push(['area-generated', e]))
  bus.on('level-up', (e) => seen.push(['level-up', e]))
  bus.on('unmatched', (e) => seen.push(['unmatched', e]))
  bus.on('zone-changed', (z) => seen.push(['zone-changed', z]))
  bus.on('character-changed', (c) => seen.push(['character-changed', c]))
  bus.on('watcher-status', (s) => seen.push(['watcher-status', s]))
  return seen
}

const channelsOf = (seen: Array<[PoeEventChannel, unknown]>): PoeEventChannel[] =>
  seen.map(([channel]) => channel)

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

describe('PoeEventBus.publish fan-out', () => {
  it('sends a self death to event, death and death:self - in that order', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(DEATH_LINE)
    expect(parsed.type).toBe('death')
    expect((parsed as DeathEvent).isSelf).toBe(true)

    bus.publish(parsed)

    expect(channelsOf(seen)).toEqual(['event', 'death', 'death:self'])
    // The SAME object on every channel - consumers compare by identity.
    for (const [, payload] of seen) expect(payload).toBe(parsed)
  })

  it("sends a party member's death to death but NOT death:self", () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(DEATH_LINE, 'SomebodyElse')
    expect((parsed as DeathEvent).isSelf).toBe(false)

    bus.publish(parsed)

    // This is what keeps the clipper from firing on a party wipe.
    expect(channelsOf(seen)).toEqual(['event', 'death'])
  })

  it('still publishes a BACKLOG self death on death:self', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    bus.publish(parse(DEATH_LINE, 'FyascoWorbinTime', true))

    // The bus is a dumb pipe: skipping historical deaths is the CLIPPER's job, and
    // it needs to see them to report `skipped-backlog`. Filtering here would also
    // starve the UI feed of the events it is meant to show on launch.
    expect(channelsOf(seen)).toEqual(['event', 'death', 'death:self'])
  })

  it('sends a zone-entered to event and zone-entered only', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(ZONE_LINE)
    expect((parsed as ZoneEnteredEvent).zoneName).toBe('Karui Shores')

    bus.publish(parsed)

    // `zone-changed` is DERIVED state and belongs to the zone tracker, not here.
    expect(channelsOf(seen)).toEqual(['event', 'zone-entered'])
  })

  it('sends an area-generated to event and area-generated only', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(AREA_LINE)
    expect((parsed as AreaGeneratedEvent).areaId).toBe('2_11_endgame_town')

    bus.publish(parsed)

    expect(channelsOf(seen)).toEqual(['event', 'area-generated'])
  })

  it('sends a level-up to event and level-up only', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(LEVEL_UP_LINE)
    expect(parsed.type).toBe('level-up')
    expect((parsed as LevelUpEvent).characterName).toBe('FyascoWorbinTime')
    expect((parsed as LevelUpEvent).level).toBe(92)

    bus.publish(parsed)

    // `character-changed` is DERIVED state and belongs to the character tracker.
    // This channel is the raw observation; the tracker decides what it means.
    expect(channelsOf(seen)).toEqual(['event', 'level-up'])
  })

  it("sends someone else's level-up out unfiltered, with no :self variant", () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    // Resolved character is somebody else entirely - and it changes nothing.
    bus.publish(parse(LEVEL_UP_LINE, 'SomebodyElse'))

    // There is deliberately no `level-up:self`: a level-up is the evidence that
    // ESTABLISHES who self is, so filtering it on the current answer would leave
    // detection unable to bootstrap from "nothing known".
    expect(channelsOf(seen)).toEqual(['event', 'level-up'])
  })

  it('sends a SUICIDE to death and death:self like any other death', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(SUICIDE_LINE, 'LargeThumbThomasReturns')
    expect(parsed.type).toBe('death')
    expect((parsed as DeathEvent).cause).toBe('suicide')
    expect((parsed as DeathEvent).isSelf).toBe(true)

    bus.publish(parsed)

    // The bus reports what happened; it does not decide what is interesting. A
    // `/kill` still counts for death stats and still belongs in the event feed.
    // Refusing to CLIP it is the replay clipper's job, and it filters on `cause` -
    // so this channel must keep carrying suicides for that filter to exist at all.
    expect(channelsOf(seen)).toEqual(['event', 'death', 'death:self'])
  })

  it('sends an unmatched line to unmatched and NOT to event', () => {
    const bus = new PoeEventBus()
    const seen = recorder(bus)

    const parsed = parse(CHAT_LINE)
    expect(parsed.type).toBe('unmatched')

    bus.publish(parsed)

    // `event` carries recognised events only - the IPC ring buffer subscribes there.
    expect(channelsOf(seen)).toEqual(['unmatched'])
  })

  it('publishes an envelope-less line as unmatched with meta null', () => {
    const bus = new PoeEventBus()
    const received: UnmatchedLine[] = []
    bus.on('unmatched', (line) => received.push(line))

    bus.publish(parse('not a log line at all'))

    expect(received).toHaveLength(1)
    expect(received[0]?.meta).toBeNull()
    expect(received[0]?.raw).toBe('not a log line at all')
  })

  it('publishes to a channel with no listeners without complaint', () => {
    const bus = new PoeEventBus()
    expect(() => bus.publish(parse(DEATH_LINE))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

describe('PoeEventBus listener containment', () => {
  it('does not let a throwing listener escape publish', () => {
    const errors: Array<[unknown, PoeEventChannel]> = []
    const bus = new PoeEventBus({
      onListenerError: (error, channel) => errors.push([error, channel])
    })

    const boom = new Error('listener exploded')
    bus.on('event', () => {
      throw boom
    })

    // The caller is the tail loop's setInterval callback: a throw here kills the app.
    expect(() => bus.publish(parse(DEATH_LINE))).not.toThrow()
    expect(errors).toEqual([[boom, 'event']])
  })

  it('still reaches death:self when the event listener throws', () => {
    const bus = new PoeEventBus()
    const clipped: DeathEvent[] = []

    bus.on('event', () => {
      throw new Error('the renderer window is gone')
    })
    bus.on('death:self', (death) => clipped.push(death))

    bus.publish(parse(DEATH_LINE))

    // Per-channel containment, not one try/catch around the fan-out: a dead window
    // must not cost the user their clip.
    expect(clipped).toHaveLength(1)
    expect(clipped[0]?.characterName).toBe('FyascoWorbinTime')
  })

  it('still reaches level-up when the event listener throws', () => {
    const bus = new PoeEventBus()
    const learned: LevelUpEvent[] = []

    bus.on('event', () => {
      throw new Error('the renderer window is gone')
    })
    bus.on('level-up', (event) => learned.push(event))

    bus.publish(parse(LEVEL_UP_LINE))

    // Same per-channel containment as `death:self`, and it matters for the same
    // reason: a dead window must not be able to stop the app finding out who the
    // player is - which would silently disable clipping for the whole session.
    expect(learned).toHaveLength(1)
    expect(learned[0]?.characterName).toBe('FyascoWorbinTime')
  })

  it('reports the channel each failure happened on', () => {
    const channels: PoeEventChannel[] = []
    const bus = new PoeEventBus({
      onListenerError: (_error, channel) => channels.push(channel)
    })

    for (const channel of ['event', 'death', 'death:self'] as const) {
      bus.on(channel, () => {
        throw new Error(channel)
      })
    }

    bus.publish(parse(DEATH_LINE))

    expect(channels).toEqual(['event', 'death', 'death:self'])
  })

  it('survives an onListenerError hook that throws', () => {
    const bus = new PoeEventBus({
      onListenerError: () => {
        throw new Error('the logger is broken too')
      }
    })
    bus.on('event', () => {
      throw new Error('listener exploded')
    })

    // A logger must never be the reason the main process dies.
    expect(() => bus.publish(parse(DEATH_LINE))).not.toThrow()
  })

  it('safeEmit reports whether the channel was handled cleanly', () => {
    const bus = new PoeEventBus()
    const status = { state: 'idle', path: null, since: DETECTED_AT } as const

    expect(bus.safeEmit('watcher-status', status)).toBe(false)

    bus.on('watcher-status', () => undefined)
    expect(bus.safeEmit('watcher-status', status)).toBe(true)

    bus.on('watcher-status', () => {
      throw new Error('nope')
    })
    // A throw is not "handled cleanly", even though an earlier listener did run.
    expect(bus.safeEmit('watcher-status', status)).toBe(false)
  })

  it('leaves the inherited emit propagating, so tools still fail loudly', () => {
    const bus = new PoeEventBus()
    bus.on('unmatched', () => {
      throw new Error('raw emit')
    })

    // Only `publish`/`safeEmit` contain throws. A test or CLI calling `emit`
    // directly should still see its own bug.
    expect(() => bus.emit('unmatched', { type: 'unmatched', meta: null, raw: 'x' })).toThrow(
      'raw emit'
    )
  })
})
