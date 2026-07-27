/**
 * src/main/log/parse-line.ts
 * ==========================
 *
 * Turns one raw Client.txt line into a {@link ParseResult}. This is the single
 * most important function in the project: everything downstream (event bus,
 * zone tracker, replay clipper, UI) is a consequence of what this decides.
 *
 * CONTRACT
 * --------
 *  - PURE. No I/O, no `Date.now()`, no reads of module state. `detectedAt` is
 *    INJECTED by the caller precisely so the function stays deterministic and
 *    testable; a backlog replay of a two-hour-old file must be able to stamp
 *    events with the read time without this function knowing what a clock is.
 *  - TOTAL. Never throws, for any string, including `""`, binary garbage, or a
 *    half-flushed partial line. An unrecognised line is data
 *    ({@link UnmatchedLine}), not an exception - the tail loop must never be
 *    able to take down the main process.
 *  - No `electron`, no `node:*`. Runs under plain node and vitest.
 *
 * ORDER OF OPERATIONS (each step is load-bearing):
 *   1. strip trailing CR      - Windows CRLF would break every `$` anchor
 *   2. match the ENVELOPE     - fail here => UnmatchedLine with `meta: null`
 *   3. build LogLineMeta      - timestamp parsed as LOCAL time
 *   4. detect + strip `": "`  - the system-marker gate
 *   5. try event patterns     - system-gated ones first, then the DEBUG one
 *   6. fall through           - UnmatchedLine WITH meta
 */

import type {
  AreaGeneratedEvent,
  DeathEvent,
  LogLineMeta,
  ParseResult,
  ZoneEnteredEvent
} from '../../shared/events'
import {
  AREA_GENERATED,
  DEATH,
  ENVELOPE,
  SYSTEM_MARKER,
  TRAILING_CR,
  ZONE_ENTERED
} from './patterns'

/**
 * Everything {@link parseLine} needs that it is not allowed to find out for
 * itself.
 */
export interface ParseLineOptions {
  /**
   * `Date.now()` at the moment the line was READ - injected, never sampled in
   * here, so the function stays pure and unit-testable. For live tailing this
   * is within milliseconds of `meta.timestamp`; for backlog replay the two can
   * be hours apart, and debounce windows must use THIS one.
   */
  readonly detectedAt: number
  /**
   * True when this line came from bytes that already existed in the file before
   * we attached. Copied verbatim onto the event so that side-effecting
   * consumers (the replay clipper above all) can early-return. `parseLine`
   * itself does not change behaviour based on it.
   */
  readonly backlog: boolean
  /**
   * The local player's character name, used only to compute
   * `DeathEvent.isSelf`. `""` means UNCONFIGURED, which forces `isSelf` to
   * false - we refuse to guess, because guessing wrong means clipping a party
   * member's deaths.
   */
  readonly selfName: string
}

/**
 * Parses one line of Client.txt.
 *
 * @param raw One line WITHOUT its trailing `\n` (a trailing `\r` from CRLF is
 *   tolerated and stripped). Passing a multi-line string is a caller bug: the
 *   envelope will match only if the first line is well-formed, and `.` in the
 *   body patterns does not cross newlines, so it degrades to `UnmatchedLine`
 *   rather than doing anything clever.
 * @returns A recognised {@link PoeEvent}, or an {@link UnmatchedLine} whose
 *   `meta` is null only when the envelope itself failed to parse.
 */
export function parseLine(raw: string, opts: ParseLineOptions): ParseResult {
  // 1. Windows CRLF hygiene. Everything below - `meta.raw` included - works on
  //    the stripped line, so a fixture read on macOS and a live Windows tail
  //    produce byte-identical results.
  const line = raw.replace(TRAILING_CR, '')

  // 2. Envelope. A failure here is a genuinely unreadable line (truncated
  //    partial write, or not a log line at all). Report it with `meta: null`
  //    and keep `raw` so tail:debug can show the user what was skipped.
  const envelope = ENVELOPE.exec(line)
  if (envelope === null) {
    return { type: 'unmatched', meta: null, raw: line }
  }

  // Named groups are far more legible than 13 positional ones. The annotation
  // (rather than `envelope.groups ?? {}` inline) is what lets the destructuring
  // defaults apply: `{}` has no such properties, so the union would not
  // type-check. Every default is unreachable in practice - the regex makes all
  // of these mandatory except `body` - but defaults keep this total with no
  // `any`, no `!`, and no branch that cannot be tested.
  const groups: Record<string, string | undefined> = envelope.groups ?? {}
  const {
    year = '',
    month = '',
    day = '',
    hour = '',
    minute = '',
    second = '',
    clientMs = '',
    threadTag = '',
    level = '',
    subsystem = '',
    pid = '',
    body: markedBody = ''
  } = groups

  // 4. The system-marker gate. Detect BEFORE stripping, because `isSystemMessage`
  //    is what the death/zone patterns are conditioned on, and expose the body
  //    with the marker removed so those patterns can be written against the
  //    message text alone.
  const isSystemMessage = SYSTEM_MARKER.test(markedBody)
  const body = isSystemMessage ? markedBody.replace(SYSTEM_MARKER, '') : markedBody

  // 3. Envelope -> meta.
  const meta: LogLineMeta = {
    raw: line,
    // LOCAL time on purpose. Client.txt writes wall-clock time with NO UTC
    // offset, so the component constructor - which interprets its arguments in
    // the host timezone - is the only correct reading. `new Date(stamp)` would
    // be wrong twice over: "2026/07/26 19:26:31" is not ISO-8601 (so parsing is
    // implementation-defined) and any ISO-ish reshaping of it would risk being
    // read as UTC.
    timestamp: new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ),
    clientMs: Number(clientMs),
    threadTag,
    level,
    subsystem,
    pid: Number(pid),
    isSystemMessage,
    body
  }

  // 5a. System-gated patterns. Everything in this block is unreachable for
  //     player chat, which is the entire anti-spoofing design.
  if (isSystemMessage) {
    const death = DEATH.exec(body)
    if (death !== null) {
      // Group 2 is the speculative " by <killer>" clause; `DeathEvent` is a
      // frozen contract with nowhere to put it, so it is intentionally dropped.
      const [, characterName = ''] = death
      const event: DeathEvent = {
        type: 'death',
        meta,
        detectedAt: opts.detectedAt,
        backlog: opts.backlog,
        characterName,
        isSelf: matchesSelf(characterName, opts.selfName)
      }
      return event
    }

    const zone = ZONE_ENTERED.exec(body)
    if (zone !== null) {
      const [, zoneName = ''] = zone
      const event: ZoneEnteredEvent = {
        type: 'zone-entered',
        meta,
        detectedAt: opts.detectedAt,
        backlog: opts.backlog,
        zoneName
      }
      return event
    }
  }

  // 5b. NOT system-gated: "Generating level ..." is a DEBUG line with no marker.
  //     Gating it would drop every area-generated event. Safe because the
  //     pattern is fully anchored and the sentence is not chat-shaped.
  const area = AREA_GENERATED.exec(body)
  if (area !== null) {
    const [, areaLevel = '', areaId = '', seed = ''] = area
    const event: AreaGeneratedEvent = {
      type: 'area-generated',
      meta,
      detectedAt: opts.detectedAt,
      backlog: opts.backlog,
      areaLevel: Number(areaLevel),
      areaId,
      seed: Number(seed)
    }
    return event
  }

  // 6. Read fine, recognised nothing. The overwhelming majority of Client.txt
  //    lands here; `meta` is present so tail:debug can show the decoded
  //    envelope while hunting for a new pattern.
  return { type: 'unmatched', meta, raw: line }
}

/**
 * Case-insensitive, whitespace-tolerant character-name comparison for
 * `DeathEvent.isSelf`.
 *
 * Returns FALSE when no character name is configured. That is a deliberate
 * refusal rather than a fallback: with no name we cannot tell our own death
 * from a party member's, and guessing "yes" would spray clips for other
 * people's deaths. A whitespace-only setting is treated identically to empty.
 */
function matchesSelf(characterName: string, selfName: string): boolean {
  const configured = selfName.trim()
  if (configured === '') return false
  return characterName.trim().toLowerCase() === configured.toLowerCase()
}
