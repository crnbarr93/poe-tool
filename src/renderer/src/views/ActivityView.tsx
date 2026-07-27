/**
 * src/renderer/src/views/ActivityView.tsx
 * =======================================
 *
 * The Activity view: what this session has actually seen. A stat strip, the parsed-event
 * table, and the clip grid - in the shape the Claude Design project draws them, wired to
 * the real feeds.
 *
 * Nothing here is on the critical path. Main tails the log, saves the clip and uploads it
 * with zero windows open; this view is a mirror, which is why every unknown below renders
 * as an em-dash instead of a retry or a guess.
 *
 *
 * THE RULE THIS FILE IS BUILT AROUND: A NUMBER MUST BE A READING, NOT A DECORATION
 * -------------------------------------------------------------------------------
 * The design supplies a full set of plausible figures. Three of them do not exist in this
 * build, and each is handled by refusing rather than inventing:
 *
 *  - "AVG MAP" is not derivable. An average needs per-area DURATIONS, which need an area
 *    timer that knows when an area was left as well as entered - a map exited to a
 *    hideout, a logout, an alt-tab. `uptimeMs / areasEntered` would produce a confident,
 *    plausible, wrong number that nobody could check. It renders as an em-dash that says
 *    so on hover. See the same note on `SessionStatsSnapshot` in `src/shared/ipc.ts`.
 *
 *  - "IN AREA" is known for exactly one row: the area the player is in NOW, ticked from
 *    the `zone-entered` line that started it. Every other row would need the duration of
 *    a FINISHED area, which is the same missing timer. Em-dash.
 *
 *  - A CLIP'S LENGTH is never known. poe-tool does not open the video file - it asks OBS
 *    to save the replay buffer and files the result - so the design's duration chip has
 *    no source. The chip carries the clip's saved time instead, which is a real reading
 *    of a real field, and the thumbnail area says "no preview" rather than pretending to
 *    a frame we never extracted.
 *
 *
 * WHAT *IS* DERIVED HERE, AND WHY THAT IS NOT THE SAME THING
 * ----------------------------------------------------------
 * Two columns are computed in the renderer from data already on screen, both of them
 * reproductions of a rule main already owns, both of them falling back to "unknown"
 * rather than to a guess:
 *
 *  - THE AREA COLUMN pairs each `area-generated` with the `zone-entered` that follows it,
 *    exactly as `src/main/log/zone-tracker.ts` does (~1s apart, DEBUG line first), and
 *    carries the result forward onto the death and level-up rows in between. A row whose
 *    zone never appeared in the loaded window gets an em-dash; nothing is extrapolated
 *    past the end of the feed.
 *
 *  - THE CLIP BADGE marks the death a clip belongs to. There is no clip -> death id in
 *    the contract, so this is a match on time and character, and it is deliberately
 *    strict: only a NON-BACKLOG death of the active character by `slain` can own a clip
 *    (those are the only deaths the clipper ever acts on - see `ReplayClipper`), the clip
 *    must have been saved within `CLIP_MATCH_WINDOW_MS` AFTER the line was read, and each
 *    clip is claimed by at most one death. A false badge would tell a user they have a
 *    recording of a death they have no recording of, so every ambiguous case resolves to
 *    no badge.
 *
 * Both rules, and the formatters beside them, live in `../activity-derive.ts` - React-free
 * so that `test/activity-derive.test.ts` can pin them. There is no DOM test environment in
 * this dependency set, so anything that must be tested has to be testable without one.
 *
 *
 * FONTS: `--font-mono` names JetBrains Mono first and falls back through the OS monospace
 * stack. Nothing is fetched - see the header of `../styles.css`.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import type { PoeEvent } from '../../../shared/events'
import type {
  ClipRecord,
  PoeToolApi,
  SessionStatsSnapshot,
  UploadOutcome
} from '../../../shared/ipc'
import {
  deriveRowZones,
  eventDetail,
  eventTag,
  findLiveZoneKey,
  formatElapsed,
  formatSessionLength,
  matchClipsToDeaths,
  UNKNOWN,
  type RowZone
} from '../activity-derive'
import { CopyButton } from '../components/CopyButton'
import { fileNameOf, formatClock, formatCount, formatEpochClock, formatEpochDateTime } from '../format'
import { useActiveCharacter, useClipFeed, useEventFeed } from '../hooks'
import type { FeedItem } from '../hooks'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many parsed events the table keeps. Enough to cover a few map runs. */
const MAX_EVENTS = 60

/** How many clips the grid keeps. A multiple of four, so the last row is never ragged. */
const MAX_CLIPS = 24

/**
 * How often the two live clocks (session length, time in the current area) redraw.
 *
 * One second, because the in-area clock shows seconds. This is a renderer-local
 * `setInterval` over values that are already in state - it costs no IPC, and it stops the
 * moment the user navigates away, because React unmounts this view.
 */
const TICK_MS = 1000

/**
 * A ticking `Date.now()`.
 *
 * Deliberately the ONLY timer in this view: both live figures derive from it, so they can
 * never drift apart, and there is exactly one interval to tear down.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, intervalMs)
    return () => {
      window.clearInterval(id)
    }
  }, [intervalMs])

  return now
}

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

interface StatProps {
  readonly label: string
  /** The reading, or `null` when there is none - which renders as an em-dash. */
  readonly value: string | null
  /** Smaller, dimmer qualifier beside the value (a level, a unit). */
  readonly qualifier?: string | undefined
  /** Why the value is what it is, or why it is missing. Always present on an unknown. */
  readonly title: string
  /** The one accent-coloured figure: deaths. */
  readonly accent?: boolean | undefined
  /** Extra class for the column that has to be allowed to grow (the character name). */
  readonly wide?: boolean | undefined
}

function Stat({ label, value, qualifier, title, accent, wide }: StatProps): ReactElement {
  const known = value !== null

  return (
    <div className={wide === true ? 'stat stat--wide' : 'stat'} title={title}>
      <span className="stat__label">{label}</span>
      <span
        className={
          known
            ? accent === true
              ? 'stat__value stat__value--accent'
              : 'stat__value'
            : 'stat__value stat__value--unknown'
        }
      >
        <span className="stat__reading">{known ? value : UNKNOWN}</span>
        {known && qualifier !== undefined && <span className="stat__qualifier">{qualifier}</span>}
        {/* An em-dash is not read aloud as anything useful; the reason is. */}
        {!known && <span className="sr-only">{title}</span>}
      </span>
    </div>
  )
}

interface StatStripProps {
  readonly api: PoeToolApi
  readonly stats: SessionStatsSnapshot | null
  readonly now: number
}

/**
 * Session / Areas / Avg map / Deaths / Character.
 *
 * `stats === null` covers both "the first answer has not arrived" and "main could not
 * read the counters" (see `stats:session`), and both render as em-dashes. A zero here
 * would not be an absence, it would be the CLAIM that nothing has happened - "you have
 * died 0 times" is exactly the kind of confident falsehood that lets a broken counter
 * pass for a quiet session.
 */
function StatStrip({ api, stats, now }: StatStripProps): ReactElement {
  // A second subscription to `push:character` (the header pill holds the first). Main fans
  // out to every listener and this costs one IPC listener, which is the price of the view
  // being self-contained rather than threading state through the shell.
  const character = useActiveCharacter(api)

  const sessionLength = stats === null ? null : formatSessionLength(now - stats.startedAt)

  const deathsTitle =
    stats === null
      ? 'Not available yet — the background process has not reported this session’s counters.'
      : stats.suicides > 0
        ? `Your deaths this session, counted live as they are parsed. ${stats.suicides} of them ${
            stats.suicides === 1 ? 'was' : 'were'
          } /kill, which is deliberate and never clipped.`
        : 'Your deaths this session, counted live as they are parsed. Party members’ deaths are not counted.'

  // "Not asked yet" and "genuinely nobody" both render an em-dash, but they must not say
  // the same thing: the second is a warning (no clip can ever be taken), the first is a
  // millisecond of waiting and would be a false alarm.
  const characterTitle =
    character === null
      ? 'Not available yet — waiting for the background process.'
      : character.name === null
        ? 'No character is resolved, so no death can be recognised as yours and no clip is ever taken. Set one in Settings › Character.'
        : character.source === 'override'
          ? 'Set by hand in Settings › Character.'
          : 'Auto-detected from a level-up in Client.txt.'

  // The level from the session counter and the level on the resolved character are the same
  // tracker's answer; preferring the snapshot keeps the strip internally consistent when a
  // level-up lands between the two pushes.
  const level = stats?.characterLevel ?? character?.level ?? null

  return (
    <div className="stat-strip">
      <Stat
        label="Session"
        value={sessionLength}
        title={
          stats === null
            ? 'Not available yet — the background process has not reported this session’s counters.'
            : `Since poe-tool started, at ${formatEpochDateTime(stats.startedAt)}. Not since this window opened.`
        }
      />
      <Stat
        label="Areas"
        value={stats === null ? null : formatCount(stats.areasEntered)}
        title={
          stats === null
            ? 'Not available yet — the background process has not reported this session’s counters.'
            : 'Areas entered this session, towns and hideouts included. Counted live, not read off the event list below.'
        }
      />
      {/*
        NEVER A NUMBER. See the header: an average needs per-area durations and this build
        has no area timer. The title is the whole point of the column.
      */}
      <Stat
        label="Avg map"
        value={null}
        title="Not tracked yet. An average needs how long each area lasted, which arrives with area timers — poe-tool currently sees only when you entered one."
      />
      <Stat
        label="Deaths"
        value={stats === null ? null : formatCount(stats.deaths)}
        title={deathsTitle}
        accent
      />
      <Stat
        label="Character"
        value={character?.name ?? null}
        qualifier={level === null ? undefined : `lvl ${String(level)}`}
        title={characterTitle}
        wide
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Events panel
// ---------------------------------------------------------------------------

/** The design's play triangle, inline - the dependency set has no icon package. */
function PlayGlyph({ size }: { readonly size: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

interface EventRowProps {
  readonly event: PoeEvent
  readonly zone: RowZone | undefined
  /** Live "time in area" for this row, or `null` when it is not the current area. */
  readonly inArea: string | null
  /** The clip this death produced, when one could be matched to it. */
  readonly clip: ClipRecord | undefined
}

function EventRow({ event, zone, inArea, clip }: EventRowProps): ReactElement {
  const tag = eventTag(event)

  return (
    // The raw log line on the row, matching the design and the feed it replaces: hovering
    // is the fastest possible way to check a parser rule against the text it fired on.
    <tr title={event.meta.raw}>
      <td className="event-table__time">{formatClock(event.meta.timestamp)}</td>
      <td>
        <span className={tag.className}>{tag.label}</span>
      </td>
      <td className="event-table__area">
        {zone === undefined ? (
          <span className="event-table__unknown" title="No zone line for this row is still in the list.">
            {UNKNOWN}
          </span>
        ) : (
          <>
            <span className="event-table__zone">{zone.name}</span>
            {zone.qualifier !== null && (
              <span className="event-table__qualifier">{zone.qualifier}</span>
            )}
          </>
        )}
      </td>
      <td className="event-table__in-area">
        {inArea === null ? (
          <span
            className="event-table__unknown"
            title="How long a finished area lasted is not tracked yet — that arrives with area timers. Only the area you are in now has a running clock."
          >
            {UNKNOWN}
          </span>
        ) : (
          inArea
        )}
      </td>
      {/*
        The flex row lives on a span INSIDE the cell, never on the `td` itself: a
        `display: flex` table cell stops being a table cell, the table generates an
        anonymous one around it, and the `colgroup` widths this table depends on quietly
        stop applying.
      */}
      <td>
        <span className="event-table__detail">
          <span>{eventDetail(event)}</span>
          {event.backlog && (
            <span
              className="tag"
              title="Read from bytes that were already in Client.txt when poe-tool attached. Nothing was clipped for it, and it is not in this session's counters."
            >
              backlog
            </span>
          )}
          {clip !== undefined && (
            <span
              className="tag tag-outline event-table__clip"
              title={`A clip was saved ${Math.max(
                0,
                Math.round((clip.savedAt - event.detectedAt) / 1000)
              )}s after this line: ${fileNameOf(clip.finalPath ?? clip.originalPath)}`}
            >
              <PlayGlyph size={11} />
              Clip
            </span>
          )}
        </span>
      </td>
    </tr>
  )
}

interface EventsPanelProps {
  readonly api: PoeToolApi
  readonly clips: readonly FeedItem<ClipRecord>[]
  readonly now: number
  readonly onOpenSettings: () => void
}

function EventsPanel({ api, clips, now, onOpenSettings }: EventsPanelProps): ReactElement {
  const events = useEventFeed(api, MAX_EVENTS)

  const zones = useMemo(() => deriveRowZones(events), [events])
  const liveZoneKey = useMemo(() => findLiveZoneKey(events), [events])
  const clipsByDeath = useMemo(() => matchClipsToDeaths(events, clips), [events, clips])

  const liveZone = liveZoneKey === null ? undefined : zones.get(liveZoneKey)
  const liveEnteredAt = liveZone?.enteredAt ?? null
  const liveInArea =
    liveEnteredAt === null || now < liveEnteredAt ? null : formatElapsed(now - liveEnteredAt)

  return (
    <section className="activity-panel" aria-labelledby="activity-events">
      <div className="activity-panel__head">
        <h2 className="activity-panel__title" id="activity-events">
          Events
        </h2>
        <span
          className="activity-panel__count"
          title={`The newest ${MAX_EVENTS} parsed lines. Older ones are still in Client.txt; this list is a window, not the session total.`}
        >
          {events.length === 0 ? 'none yet' : `${events.length} shown`}
        </span>
      </div>

      <div className="activity-panel__body">
        {events.length === 0 ? (
          <div className="activity-empty">
            <h3 className="activity-empty__title">Nothing parsed yet</h3>
            <p className="activity-empty__body">
              Point poe-tool at Client.txt, then zone into any area.
            </p>
            <button className="btn btn-primary" type="button" onClick={onOpenSettings}>
              Set Client.txt path
            </button>
          </div>
        ) : (
          <div className="event-table__scroll">
            <table className="table event-table">
              <colgroup>
                <col style={{ width: '74px' }} />
                <col style={{ width: '92px' }} />
                <col />
                <col style={{ width: '84px' }} />
                <col style={{ width: '34%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Area</th>
                  <th scope="col">In area</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((item) => (
                  <EventRow
                    key={item.key}
                    event={item.value}
                    zone={zones.get(item.key)}
                    inArea={item.key === liveZoneKey ? liveInArea : null}
                    clip={clipsByDeath.get(item.key)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Clips panel
// ---------------------------------------------------------------------------

/** `Karui Shores · lvl 69` from whichever of the zone fields survived. */
function describeClipZone(clip: ClipRecord): string {
  const name = clip.zoneName ?? clip.areaId
  const level = clip.areaLevel === null ? null : `lvl ${clip.areaLevel}`

  if (name === null && level === null) return 'Zone unknown'
  if (name === null) return level ?? 'Zone unknown'
  if (level === null) return name
  return `${name} · ${level}`
}

/**
 * One clip's Streamable upload, on its card. EXHAUSTIVE over {@link UploadOutcome}, so a
 * new upload state is a compile error rather than a card that silently renders nothing.
 *
 * THE TWO UNHAPPY ENDINGS ARE AS LOUD AS THE HAPPY ONE. `skipped` (we chose not to - over
 * the size cap, not on this machine, no credentials) and `failed` (we tried and could not)
 * are different problems and get different sentences, and neither is greyed out or hidden
 * behind a hover. A user who believes their deaths are being uploaded and finds out weeks
 * later that a size limit quietly dropped them is the outcome this project exists to avoid.
 *
 * `reason` and `message` are complete sentences written in main and are rendered verbatim.
 *
 * A FAILURE CAN STILL CARRY A LINK: when the upload worked and only the wait for
 * transcoding ran out, main sends the URL on the `failed`/`skipped` outcome. The video is
 * on Streamable; the only thing that failed was poe-tool watching it.
 */
function CardUpload({ upload }: { readonly upload: UploadOutcome }): ReactElement {
  switch (upload.state) {
    case 'disabled':
      return (
        <div className="clip-card__upload">
          {/*
            "uploading off" and the skip's "not uploaded" are deliberately DIFFERENT WORDS
            for different facts: this clip was never a candidate, whereas a skip was one
            and was declined. The design's palette has three tag variants and none of them
            is a green - so the distinction is carried in words, which is this app's rule
            anyway: colour is only ever the second signal.
          */}
          <span className="tag" title="Streamable uploading is switched off, so this clip was never a candidate.">
            uploading off
          </span>
        </div>
      )

    case 'pending':
      return (
        <div className="clip-card__upload">
          <span className="tag">upload queued</span>
        </div>
      )

    case 'uploading':
      return (
        <div className="clip-card__upload">
          {/*
            `percent: null` is the NORMAL case, not a missing value - the upload is one
            fetch of a multipart body with no per-chunk callback. "in progress" is honest;
            "0%" would look stuck.
          */}
          <span className="tag">
            {upload.percent === null ? 'uploading' : `uploading ${upload.percent}%`}
          </span>
        </div>
      )

    case 'processing':
      return (
        <div className="clip-card__upload">
          <span className="tag">processing</span>
          <p className="clip-card__note">
            Streamable has the file and is transcoding it — the link appears when it can be
            played.
          </p>
          <span className="clip-card__code mono">{upload.shortcode}</span>
        </div>
      )

    case 'done':
      return (
        <div className="clip-card__upload">
          {/* Plain, not accent-outlined: in this window the accent is the alarm colour. */}
          <span className="tag">uploaded</span>
          {/*
            `target="_blank"` is REQUIRED, not habit: `src/main/index.ts` blocks in-page
            navigation and routes window-open requests to `shell.openExternal`, so a
            same-window link would simply do nothing. `rel="noreferrer"` because Streamable
            has no business knowing where the click came from.
          */}
          <a className="clip-card__link" href={upload.url} target="_blank" rel="noreferrer">
            {upload.url}
          </a>
          <CopyButton text={upload.url} label="Copy link" srLabel="Streamable link" />
        </div>
      )

    case 'skipped':
      return (
        <div className="clip-card__upload">
          <span className="tag">not uploaded</span>
          <p className="clip-card__note clip-card__note--problem">{upload.reason}</p>
          <CardUploadLink url={upload.url} />
        </div>
      )

    case 'failed':
      return (
        <div className="clip-card__upload">
          <span className="tag tag-accent">upload failed</span>
          <p className="clip-card__note clip-card__note--failed">
            {upload.message} The clip itself is untouched — a failed upload never costs you
            the file.
          </p>
          <CardUploadLink url={upload.url} />
        </div>
      )
  }
}

/**
 * The link on an unhappy ending that nonetheless produced a video. Renders nothing at all
 * when there is no URL, which is every other skip and failure.
 */
function CardUploadLink({ url }: { readonly url: string | undefined }): ReactElement | null {
  if (url === undefined || url === '') return null
  return (
    <>
      <a className="clip-card__link" href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      <CopyButton text={url} label="Copy link" srLabel="Streamable link" />
    </>
  )
}

function ClipCard({ clip }: { readonly clip: ClipRecord }): ReactElement {
  const placed = clip.moved && clip.finalPath !== null
  const location = clip.finalPath ?? clip.originalPath

  return (
    <article className={placed ? 'clip-card' : 'clip-card clip-card--unplaced'}>
      {/*
        NOT A VIDEO STILL AND NOT PRETENDING TO BE ONE. poe-tool never opens the file - it
        asks OBS to save the replay buffer and files the result - so there is no frame to
        show and no duration to put in the design's chip. The chip carries the saved time,
        which is a real field.
      */}
      <div
        className="clip-card__thumb"
        title="poe-tool does not read the video file, so it has no preview frame and does not know how long the clip is."
      >
        <span className="clip-card__thumb-glyph" aria-hidden="true">
          <PlayGlyph size={22} />
        </span>
        <span className="clip-card__thumb-label">no preview</span>
        <span className="clip-card__chip">{formatEpochClock(clip.savedAt)}</span>
      </div>

      <div className="clip-card__body">
        <h3 className="clip-card__title" title={describeClipZone(clip)}>
          {describeClipZone(clip)}
        </h3>
        <p className="clip-card__meta">
          {formatEpochDateTime(clip.savedAt)}
          {clip.characterName !== '' && ` · ${clip.characterName}`}
        </p>

        <div className="clip-card__tags">
          {/*
            An unfiled clip keeps its card and says where the file actually is. A UI that
            filtered those out would turn "your clip is in the OBS folder instead of your
            library" into "poe-tool lost my clip".
          */}
          <span className={placed ? 'tag' : 'tag tag-accent'}>
            {placed ? 'In library' : 'Left in OBS folder'}
          </span>
          {clip.cause === 'suicide' ? (
            <span className="tag" title="PoE's /kill command — deliberate, normally never clipped.">
              /kill
            </span>
          ) : (
            <span className="tag" title="Killed by the game — the kind of death clips exist for.">
              slain
            </span>
          )}
        </div>

        <p className="clip-card__path mono" title={location}>
          {fileNameOf(location)}
        </p>
        {/*
          The FULL path, spelled out, for a clip that was not filed - and only for those.
          A user whose clip is sitting in the OBS recording folder has to be able to go and
          get it, and a tooltip is not a thing you can follow with a file manager open. A
          filed clip's path is one hover away and does not need three lines of a small card.
        */}
        {!placed && <p className="clip-card__path mono">{location}</p>}

        {clip.note !== null && clip.note !== '' && (
          <p className={placed ? 'clip-card__note' : 'clip-card__note clip-card__note--problem'}>
            {clip.note}
          </p>
        )}

        <CardUpload upload={clip.upload} />
      </div>
    </article>
  )
}

function ClipsPanel({ clips }: { readonly clips: readonly FeedItem<ClipRecord>[] }): ReactElement {
  return (
    <section className="activity-panel" aria-labelledby="activity-clips">
      <div className="activity-panel__head">
        <h2 className="activity-panel__title" id="activity-clips">
          Clips
        </h2>
        <span
          className="activity-panel__count"
          title={`The newest ${MAX_CLIPS} clips. Beyond that, the library folder is the archive.`}
        >
          {clips.length === 0 ? 'none yet' : `${clips.length} shown`}
        </span>
      </div>

      {clips.length === 0 ? (
        <div className="activity-panel__body">
          <div className="activity-empty">
            <h3 className="activity-empty__title">No clips</h3>
            <p className="activity-empty__body">
              One lands here each time you die with OBS replay buffer running — including any
              that could not be filed. Deaths from <span className="mono">/kill</span> are
              deliberately never clipped, and a clip is only taken for the character poe-tool
              has resolved as yours.
            </p>
          </div>
        </div>
      ) : (
        <div className="clip-grid">
          {clips.map((item) => (
            <ClipCard key={item.key} clip={item.value} />
          ))}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface ActivityViewProps {
  readonly api: PoeToolApi
  /**
   * This session's counters, or `null` when they have not arrived or could not be read.
   *
   * PASSED IN RATHER THAN FETCHED HERE so that the shell owns one subscription to
   * `push:stats` (see `useSessionStats`), and so this view has one obvious place where
   * "no counters" is handled instead of one per column.
   */
  readonly stats: SessionStatsSnapshot | null
  /** Navigate to the Settings view - the empty state's only action. */
  readonly onOpenSettings: () => void
}

export function ActivityView({ api, stats, onOpenSettings }: ActivityViewProps): ReactElement {
  const now = useNow(TICK_MS)
  // Held here rather than inside the clips panel because the events table needs the same
  // list to badge the deaths that produced a clip - two `useClipFeed` calls would be two
  // subscriptions and two independently-merged copies of one feed.
  const clips = useClipFeed(api, MAX_CLIPS)

  return (
    <div className="activity">
      <StatStrip api={api} stats={stats} now={now} />
      <EventsPanel api={api} clips={clips} now={now} onOpenSettings={onOpenSettings} />
      <ClipsPanel clips={clips} />
    </div>
  )
}
