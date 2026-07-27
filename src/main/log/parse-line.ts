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
 *
 *
 * WHY THE PATTERNS ARE TRIED IN THE ORDER THEY ARE
 * ------------------------------------------------
 * CORRECTNESS DOES NOT DEPEND ON IT. Every body pattern in patterns.ts is
 * anchored `^...$` and the five sentence shapes are mutually exclusive - the
 * three that end in `.` have different fixed wording, and `LEVEL_UP` ends on a
 * digit so it cannot collide with any of them. No reordering can change which
 * pattern matches a given line; nothing here is shadowing anything.
 *
 * So the order is pure cost, and it is picked as "latency-critical first, then
 * descending frequency in the 375,087-line reference log":
 *
 *   1. DEATH        348 hits - FIRST regardless of frequency. This is the one
 *                   with a deadline: it triggers an OBS replay-buffer save, and
 *                   every microsecond here is a microsecond further from the
 *                   moment the player actually died.
 *   2. ZONE_ENTERED 8,065 hits - by far the most common system-gated line, so
 *                   the common match exits after two tests.
 *   3. LEVEL_UP     585 hits.
 *   4. SUICIDE      7 hits - the rarest thing in the log by two orders of
 *                   magnitude. It is last DESPITE being a death because it is
 *                   the one death that is explicitly never clipped (see
 *                   `DeathCause`), so unlike DEATH it has no deadline at all.
 *   5. AREA_GENERATED 8,070 hits - cannot move: it is the only ungated pattern
 *                   and lives outside the `isSystemMessage` block entirely.
 *
 * The overwhelmingly common case is a line that matches NOTHING and pays for
 * every test regardless; the ordering only decides how fast the hits get out.
 */

import type {
  AreaGeneratedEvent,
  DeathCause,
  DeathEvent,
  LevelUpEvent,
  LogLineMeta,
  ParseResult,
  ZoneEnteredEvent
} from '../../shared/events'
import {
  AREA_GENERATED,
  DEATH,
  ENVELOPE,
  LEVEL_UP,
  SUICIDE,
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
   * The RESOLVED active character name - `ActiveCharacter.name` from
   * src/shared/events.ts, i.e. the manual override if one is set, else the
   * auto-detected name, else nothing. Resolving it is the caller's job; this
   * function takes a single string and does not know the priority rules.
   *
   * Used only to compute `DeathEvent.isSelf`, for both causes. `""` means
   * UNCONFIGURED AND NEVER DETECTED, which forces `isSelf` to false - we refuse
   * to guess, because guessing wrong means clipping a party member's deaths.
   * Note the consequence: with `""` the clipper never fires at all, silently,
   * which is precisely why "nothing detected yet" has to be surfaced as a
   * warning in the UI rather than left to be noticed as a missing clip.
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
  //     player chat, which is the entire anti-spoofing design. See the header
  //     for why they are tried in this order (cost only - they cannot shadow
  //     one another).
  if (isSystemMessage) {
    const death = DEATH.exec(body)
    if (death !== null) {
      // Group 2 is the speculative " by <killer>" clause; `DeathEvent` is a
      // frozen contract with nowhere to put it, so it is intentionally dropped.
      const [, characterName = ''] = death
      return buildDeath(characterName, 'slain', meta, opts)
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

    const levelUp = LEVEL_UP.exec(body)
    if (levelUp !== null) {
      const [, characterName = '', className = '', level = ''] = levelUp
      const event: LevelUpEvent = {
        type: 'level-up',
        meta,
        detectedAt: opts.detectedAt,
        backlog: opts.backlog,
        characterName,
        className,
        // `LEVEL_UP` captures `\d+`, so this is always a finite non-negative
        // integer - no NaN branch is reachable and none is invented here.
        level: Number(level)
      }
      return event
    }

    // `/kill`. A real death that must never be clipped: same event, different
    // `cause`. NOT given an `isSelf` rule of its own - a suicide is ours or a
    // party member's by exactly the same test as any other death.
    const suicide = SUICIDE.exec(body)
    if (suicide !== null) {
      const [, characterName = ''] = suicide
      return buildDeath(characterName, 'suicide', meta, opts)
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
 * Builds a {@link DeathEvent} from a matched name plus the cause that matched it.
 *
 * Exists so the `'slain'` and `'suicide'` branches CANNOT DRIFT. They are tried
 * three checks apart (see the ordering note in the header), and the difference
 * between them must stay exactly one field - the discriminator. Constructing the
 * object twice inline would make it possible to add a field to the death shape,
 * update the branch you were looking at, and ship a suicide that is silently
 * missing it. In particular `isSelf` is computed here, once, so a suicide can
 * never accidentally get a laxer or stricter self-test than a slaying.
 */
function buildDeath(
  characterName: string,
  cause: DeathCause,
  meta: LogLineMeta,
  opts: ParseLineOptions
): DeathEvent {
  return {
    type: 'death',
    meta,
    detectedAt: opts.detectedAt,
    backlog: opts.backlog,
    characterName,
    cause,
    isSelf: matchesSelf(characterName, opts.selfName)
  }
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
