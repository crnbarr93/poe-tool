/**
 * src/renderer/src/components/EventFeedSection.tsx
 * ================================================
 *
 * The last N parsed events, newest first. This is the section that proves the log
 * pipeline works: zone into a map and rows appear within a poll interval.
 *
 * WHAT THE ROWS DELIBERATELY SPELL OUT
 * ------------------------------------
 *  - `backlog` events are tagged. They came from bytes that were already in the file
 *    when the watcher attached (startup catch-up, or a re-read after a rotation), and
 *    they intentionally trigger NO side effects - no clip is saved for a death from
 *    two hours ago. Seeing them tagged is how a user tells "poe-tool ignored my death"
 *    apart from "poe-tool never saw my death".
 *  - a death row says whether it was YOU or a party member, because that single
 *    distinction is the whole reason `character.name` exists.
 *  - `seed 1` is called out as a static area (town/hideout), matching the meaning
 *    documented on `AreaGeneratedEvent`.
 *
 * The raw log line is on each row's `title`, so hovering a row shows the exact text it
 * was parsed from - the fastest possible way to check a parser rule against reality.
 */

import type { ReactElement } from 'react'

import type { PoeEvent } from '../../../shared/events'
import type { PoeToolApi } from '../../../shared/ipc'
import { formatClock } from '../format'
import { useEventFeed } from '../hooks'
import { Section } from './Section'
import type { BadgeTone } from './StatusBadge'
import { StatusBadge } from './StatusBadge'

/** How many events the feed keeps. Enough to cover a few map runs. */
const MAX_EVENTS = 60

interface EventRowContent {
  readonly tone: BadgeTone
  readonly typeLabel: string
  /** The headline: zone name or character name. */
  readonly subject: string
  /** Supporting detail, or `''` for none. */
  readonly detail: string
}

/** Exhaustive over the `PoeEvent` union - a new event type is a compile error here. */
function describeEvent(event: PoeEvent): EventRowContent {
  switch (event.type) {
    case 'zone-entered':
      return { tone: 'info', typeLabel: 'zone', subject: event.zoneName, detail: 'entered' }
    case 'area-generated':
      return {
        tone: 'idle',
        typeLabel: 'area',
        subject: event.areaId,
        detail:
          event.seed === 1
            ? `level ${event.areaLevel} · static area (town or hideout)`
            : `level ${event.areaLevel} · seed ${event.seed}`
      }
    case 'death':
      return {
        tone: event.isSelf ? 'bad' : 'warn',
        typeLabel: 'death',
        subject: event.characterName,
        detail: event.isSelf ? 'you' : 'party member — ignored'
      }
  }
}

function EventRow({ event }: { readonly event: PoeEvent }): ReactElement {
  const content = describeEvent(event)

  return (
    <li className="event" title={event.meta.raw}>
      <span className="event__time">{formatClock(event.meta.timestamp)}</span>
      <span className={`tag tag--${content.tone}`}>{content.typeLabel}</span>
      <span className="event__subject">{content.subject}</span>
      <span className="event__detail">{content.detail}</span>
      {event.backlog && (
        <span className="tag tag--idle" title="Read from the existing file on attach; no clip was taken.">
          backlog
        </span>
      )}
    </li>
  )
}

export interface EventFeedSectionProps {
  readonly api: PoeToolApi
}

export function EventFeedSection({ api }: EventFeedSectionProps): ReactElement {
  const events = useEventFeed(api, MAX_EVENTS)

  return (
    <Section
      index="5"
      title="Live events"
      description="Everything the parser has recognised, newest first. Hover a row to see the raw log line."
      aside={
        events.length === 0 ? (
          <StatusBadge tone="idle" label="No events yet" />
        ) : (
          <StatusBadge tone="ok" label="Receiving" detail={`${events.length} shown`} />
        )
      }
    >
      {events.length === 0 ? (
        <p className="feed__empty">
          Nothing parsed yet. Zone into any area in game — a <span className="mono">zone</span> and
          an <span className="mono">area</span> row should appear within a poll interval.
        </p>
      ) : (
        <ul className="feed__list feed__list--events">
          {events.map((item) => (
            <EventRow key={item.key} event={item.value} />
          ))}
        </ul>
      )}
    </Section>
  )
}
