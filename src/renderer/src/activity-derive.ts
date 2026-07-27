/**
 * src/renderer/src/activity-derive.ts
 * ===================================
 *
 * The Activity view's arithmetic, with the React taken out.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 * -----------------------------------
 * Two of the things `ActivityView.tsx` puts on screen are INFERENCES rather than fields
 * off the wire - which zone a death happened in, and which clip a death produced - and an
 * inference that is wrong is this app telling a user something untrue about their own
 * session. The frozen dependency set has no DOM test environment (see the head of
 * `test/detection-swap.test.ts`), so the only way those rules can be pinned by a test is
 * for them to live in a file that imports neither React nor `window`. Hence this module,
 * and `test/activity-derive.test.ts` beside it.
 *
 * NOTHING HERE MAY IMPORT FROM `./hooks` OR FROM REACT. `test/**` is typechecked with the
 * node project's options (`lib: ["ES2023"]`, no DOM), so a single `import type { FeedItem }
 * from './hooks'` would drag `window.setTimeout` into a compiler that has never heard of
 * `window`. {@link Keyed} is the structural stand-in, and `FeedItem<T>` satisfies it.
 *
 * THE HOUSE RULE, RESTATED FOR THIS FILE: every function here returns "unknown" rather
 * than a plausible value. There is no fallback that guesses.
 */

import type { AreaGeneratedEvent, PoeEvent, ZoneEnteredEvent } from '../../shared/events'
import type { ClipRecord } from '../../shared/ipc'

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * A feed row: a value plus the React key it is rendered under.
 *
 * Structurally identical to `FeedItem<T>` in `./hooks`, and deliberately declared here
 * instead of imported - see the file header.
 */
export interface Keyed<T> {
  readonly key: string
  readonly value: T
}

/** What every unknown renders as. An em-dash, never a zero and never a plausible guess. */
export const UNKNOWN = '—'

/**
 * The `area-generated` -> `zone-entered` pairing windows, mirroring
 * `DEFAULT_PAIRING_WINDOW_MS` / `DEFAULT_IN_FILE_WINDOW_MS` in
 * `src/main/log/zone-tracker.ts`.
 *
 * Transcribed rather than imported: `src/renderer/**` may not import from `src/main/**`
 * (that project is compiled with node typings and the renderer is not), and these are not
 * part of the frozen IPC contract. If the tracker's windows move, move these with them -
 * the cost of drifting is the Area column disagreeing with the clip that main named from
 * the very same pair of lines.
 */
export const PAIRING_WINDOW_MS = 15_000
export const IN_FILE_WINDOW_MS = 15_000

/**
 * How long after a death's line was read a clip may still be claimed by it.
 *
 * The real gap is the OBS round-trip: `SaveReplayBuffer`, the `ReplayBufferSaved` event,
 * then the move into the library - well under a second on a healthy setup, but a large
 * buffer flushed to a slow disk stretches it. 30s is generous enough to cover that and far
 * too short to reach the next death of a normal session.
 */
export const CLIP_MATCH_WINDOW_MS = 30_000

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Epoch milliseconds from a `LogLineMeta.timestamp`, or `null` when it is unusable.
 *
 * The structured clone algorithm preserves `Date` across IPC, so this is a `Date` in
 * practice - but a bad value would throw inside a render and take the whole window down
 * over a cosmetic column, which is the reasoning every helper in `./format.ts` is written
 * with.
 */
export function timestampMs(value: Date): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/**
 * `"3h 12m"` / `"12m"` / `"48s"`. The session's age, at the granularity the design asks
 * for, dropping to seconds only for the first minute so a freshly launched app does not
 * sit at a motionless `0m`.
 */
export function formatSessionLength(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return UNKNOWN
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes >= 60) return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
  if (totalMinutes >= 1) return `${totalMinutes}m`
  return `${Math.floor(ms / 1000)}s`
}

/**
 * `"1h 04m"` / `"4m 12s"` / `"12s"`. Time in the current area, which is read at a glance
 * against a map that has gone on too long - so seconds stay visible until the hour.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return UNKNOWN
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** Case-insensitive, trimmed name comparison - the same rule main resolves `isSelf` with. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// The Area column
// ---------------------------------------------------------------------------

/** The merged view of a zone, as the Area column shows it. */
export interface RowZone {
  /** Display name, or the internal area id when only the DEBUG line has been seen. */
  readonly name: string
  /** The smaller, dimmer half: level, and whether the area is static. */
  readonly qualifier: string | null
  /**
   * Wall-clock ms of the `zone-entered` line, for the live clock. `null` on a row that
   * describes an area the player has not been reported entering.
   */
  readonly enteredAt: number | null
}

/** `level 69` / `level 69 · static` - `seed === 1` means a town or hideout. */
export function areaQualifier(area: AreaGeneratedEvent): string {
  return area.seed === 1 ? `level ${area.areaLevel} · static` : `level ${area.areaLevel}`
}

/**
 * Whether this `area-generated` and this `zone-entered` describe the SAME transition.
 *
 * Both clocks are checked, exactly as the zone tracker does. `detectedAt` bounds how long
 * an unpaired area may wait; `meta.clientMs` (milliseconds since the game client started,
 * immune to OS clock changes) is what stops a post-rotation drain - where every line shares
 * one `detectedAt` - from pairing two lines that are hours apart in the file. A NEGATIVE
 * in-file delta means the lines are out of order or the game restarted between them, and
 * neither may pair.
 */
export function pairs(area: AreaGeneratedEvent, zone: ZoneEnteredEvent): boolean {
  const readDelta = zone.detectedAt - area.detectedAt
  const fileDelta = zone.meta.clientMs - area.meta.clientMs
  return (
    readDelta >= 0 &&
    readDelta <= PAIRING_WINDOW_MS &&
    fileDelta >= 0 &&
    fileDelta <= IN_FILE_WINDOW_MS
  )
}

/**
 * The zone each row happened in, keyed by feed key.
 *
 * Walks the feed OLDEST FIRST (it arrives newest first) so a zone can be carried forward
 * onto the rows that follow it, which is the only way a death row can name an area at all:
 * a death line says who died and nothing else.
 *
 * A row with no entry in the returned map genuinely has no known zone - it happened before
 * the oldest `zone-entered` still in the window - and renders an em-dash. Nothing is
 * extrapolated past the end of the feed.
 */
export function deriveRowZones(items: readonly Keyed<PoeEvent>[]): ReadonlyMap<string, RowZone> {
  const zones = new Map<string, RowZone>()
  let pending: AreaGeneratedEvent | null = null
  let current: RowZone | null = null

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined) continue
    const event = item.value

    switch (event.type) {
      case 'area-generated':
        pending = event
        // Its own row shows the internal id: the readable name is on the line that has not
        // arrived yet, and inventing one from the id would be a guess at a translation.
        zones.set(item.key, {
          name: event.areaId,
          qualifier: areaQualifier(event),
          enteredAt: null
        })
        break

      case 'zone-entered': {
        const paired = pending !== null && pairs(pending, event) ? pending : null
        pending = null
        const zone: RowZone = {
          name: event.zoneName,
          qualifier: paired === null ? null : areaQualifier(paired),
          enteredAt: timestampMs(event.meta.timestamp)
        }
        current = zone
        zones.set(item.key, zone)
        break
      }

      case 'death':
      case 'level-up':
        if (current !== null) zones.set(item.key, current)
        break
    }
  }

  return zones
}

/**
 * The feed key of the row that started the area the player is in NOW, or `null`.
 *
 * BACKLOG ROWS ARE REFUSED. A replayed `zone-entered` is a line that was already in the
 * file when the watcher attached; it may be from a session that ended yesterday, and
 * ticking a clock against it would claim the player has been standing in that area for
 * fourteen hours. When the newest zone line is backlog, no row shows a time - which
 * corrects itself the moment the player zones anywhere.
 */
export function findLiveZoneKey(items: readonly Keyed<PoeEvent>[]): string | null {
  for (const item of items) {
    if (item.value.type !== 'zone-entered') continue
    return item.value.backlog ? null : item.key
  }
  return null
}

// ---------------------------------------------------------------------------
// The clip badge
// ---------------------------------------------------------------------------

/**
 * Which clip each death produced, keyed by the death's feed key.
 *
 * THERE IS NO CLIP -> DEATH ID IN THE CONTRACT, so this is a match on time and character,
 * and it is deliberately strict, because a false badge tells a user they have a recording
 * of a death they have no recording of. Every ambiguous case resolves to no badge.
 *
 * Only the deaths the replay clipper acts on are eligible at all - a party member's death,
 * a `/kill` and a replayed backlog line never produce a clip - and the walk is CAUSAL:
 * deaths oldest first, each claiming the earliest clip that appeared after it and that no
 * earlier death has already claimed.
 *
 *  - a debounced double death (two lines, one clip, because `clips.debounceMs` suppressed
 *    the second) badges the line the clip was actually taken for, and leaves the other
 *    bare - which is the truth, and is also the only way the second row's absence can be
 *    noticed;
 *  - two unrelated deaths with a clip each keep their own, which a "nearest clip" rule
 *    would get wrong the moment the second death happened inside the first's window.
 */
export function matchClipsToDeaths(
  events: readonly Keyed<PoeEvent>[],
  clips: readonly Keyed<ClipRecord>[]
): ReadonlyMap<string, ClipRecord> {
  const matched = new Map<string, ClipRecord>()
  const claimed = new Set<string>()

  // Both feeds arrive newest first; both are walked backwards, so this reads in the order
  // the events actually happened.
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const eventItem = events[eventIndex]
    if (eventItem === undefined) continue
    const event = eventItem.value
    if (event.type !== 'death') continue
    if (!event.isSelf || event.cause !== 'slain' || event.backlog) continue

    for (let clipIndex = clips.length - 1; clipIndex >= 0; clipIndex -= 1) {
      const clipItem = clips[clipIndex]
      if (clipItem === undefined) continue
      const clip = clipItem.value
      if (claimed.has(clip.id)) continue
      // `''` is the documented "nobody was resolved at capture time"; it cannot disagree
      // with a name, so it is not allowed to veto a match either.
      if (clip.characterName !== '' && !sameName(clip.characterName, event.characterName)) continue

      const delta = clip.savedAt - event.detectedAt
      if (delta < 0 || delta > CLIP_MATCH_WINDOW_MS) continue

      claimed.add(clip.id)
      matched.set(eventItem.key, clip)
      break
    }
  }

  return matched
}

// ---------------------------------------------------------------------------
// Row copy
// ---------------------------------------------------------------------------

/** The `.tag` class and label for one event. Exhaustive over the `PoeEvent` union. */
export function eventTag(event: PoeEvent): { readonly className: string; readonly label: string } {
  switch (event.type) {
    case 'zone-entered':
      return { className: 'tag tag-neutral', label: 'zone' }
    case 'area-generated':
      return { className: 'tag tag-neutral', label: 'area' }
    case 'death':
      // Accent for both kinds. A `/kill` is still a death and still counts; the label and
      // the detail are what say it was deliberate and produced no clip.
      return { className: 'tag tag-accent', label: event.cause === 'suicide' ? '/kill' : 'death' }
    case 'level-up':
      return { className: 'tag tag-outline', label: 'level' }
  }
}

/**
 * The Detail cell's sentence. Exhaustive over the union, and it keeps every distinction the
 * pre-redesign feed spelled out, because each of them explains an ABSENCE:
 *  - a party member's death is IGNORED - no clip, and it is not in your death count;
 *  - a `/kill` is deliberate and NEVER clipped, the one case where a death of yours
 *    legitimately produces nothing, and therefore the one that would otherwise look like
 *    the app failing at the exact moment it is behaving correctly;
 *  - a level-up is the character detector's only evidence, so seeing one is how a user
 *    connects "I levelled" to "the character warning went away";
 *  - `seed 1` is a static area - a town or hideout.
 */
export function eventDetail(event: PoeEvent): string {
  switch (event.type) {
    case 'zone-entered':
      return 'Entered'
    case 'area-generated':
      return event.seed === 1 ? 'Static area — town or hideout' : `Seed ${event.seed}`
    case 'death':
      if (event.cause === 'suicide') {
        return event.isSelf
          ? 'You — /kill, deliberate, never clipped'
          : `${event.characterName} — party member, ignored`
      }
      return event.isSelf ? 'You' : `${event.characterName} — party member, ignored`
    case 'level-up':
      return `${event.characterName} · ${event.className} · now level ${event.level}`
  }
}
