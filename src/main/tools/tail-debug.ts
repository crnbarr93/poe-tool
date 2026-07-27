/**
 * src/main/tools/tail-debug.ts
 * ============================
 *
 * `npm run tail:debug` - the CLI the user points at their REAL Client.txt to find
 * out whether the regexes in `../log/patterns.ts` actually match anything.
 *
 * This is the tool that comes FIRST. Every other consumer in the project (event
 * bus, zone tracker, replay clipper, UI) is downstream of `parseLine`, so a
 * pattern that is subtly wrong silently produces an app that does nothing. The
 * only honest way to find that out is to run the real parser over a real log and
 * print, line by line, what it decided - plus, crucially, a SUMMARY of the lines
 * it decided nothing about. The five most common unmatched line SHAPES are the
 * whole point of the summary: they are the list of patterns that are missing.
 *
 *
 * RULES FOR THIS FILE
 * -------------------
 *  - NO `electron`. It compiles under `tsconfig.tools.json`, which only includes
 *    `src/shared/**`, `src/main/log/**`, `src/main/events/**` and
 *    `src/main/tools/**` - trees that are guaranteed electron-free. It runs as
 *    plain CommonJS under `node dist-tools/main/tools/tail-debug.js`.
 *  - NO NEW DEPENDENCIES. The dependency set is frozen, so argument parsing is
 *    hand-rolled and colour is four hand-written ANSI escapes.
 *  - NO `any`, no `@ts-ignore`, no type assertions.
 *  - READ ONLY. It opens the log with `LogReader`, which uses `fs.open(path,
 *    'r')` and nothing else. Nothing in this process can write to Client.txt.
 *
 *
 * WHY IT DRIVES `LogReader` DIRECTLY RATHER THAN `LogWatcher`
 * ----------------------------------------------------------
 * The watcher exists to turn a file into a *live event stream* with a fixed poll
 * interval and a startup `seekToEnd()`. This tool needs the opposite of most of
 * that: start at offset 0, drain the whole file as fast as the disk allows, stop
 * at exactly N lines, and optionally never follow at all. Driving the reader
 * directly keeps the debug tool's control flow explicit and - more importantly -
 * keeps it usable as a diagnostic even if the watcher itself is what is broken.
 *
 * It still exercises the two pieces whose correctness is actually in question:
 * `LogReader` (offsets, CRLF, UTF-8 across chunk boundaries) and `parseLine`
 * (the patterns). Those are the layers a wrong answer would come from.
 *
 *
 * WHO COUNTS AS "ME": THE SAME ANSWER THE APP WOULD GIVE
 * ------------------------------------------------------
 * `DeathEvent.isSelf` is computed from the RESOLVED active character, and resolving
 * it is `CharacterTracker`'s job - `parseLine` only takes the finished name. So this
 * tool builds a REAL tracker and drives it exactly the way
 * `LogWatcher.#parseAndDeliver` does:
 *
 *   1. read the resolved name BEFORE parsing the line - a level-up is evidence
 *      about the lines AFTER it, never about itself;
 *   2. parse;
 *   3. hand a `level-up` straight back to the tracker, so the next line already
 *      resolves against it.
 *
 * `--char` is therefore the OVERRIDE half of `settings.character` - the manual choice
 * that outranks detection - and OMITTING it leaves the tool auto-detecting from
 * level-up lines, which is the behaviour the user actually has to verify against
 * their own log before trusting the app with it.
 *
 * NOTHING IS PERSISTED. `getPersisted` reports "never detected" and `persist` is a
 * no-op, on purpose and twice over: a read-only diagnostic must not write the user's
 * settings.json, and starting from zero on every run is what makes "did detection
 * work on THIS log?" an honest question rather than one the last run already
 * answered. (In the app that persistence is the whole point - level-ups are sparse -
 * but there it is `SettingsStore`'s job, and `SettingsStore` imports electron.)
 *
 * The one thing deliberately NOT identical to production is print ORDER: the `ACTIVE`
 * line is written AFTER the `MATCH level-up` that caused it, so the output reads
 * cause-then-effect. `LogWatcher` ingests before publishing; here "publishing" is
 * printing, so no state transition is affected by the swap.
 */

import { resolve as resolvePath } from 'node:path'

import type {
  ActiveCharacter,
  DeathCause,
  DeathEvent,
  LevelUpEvent,
  ParseResult,
  PoeEvent,
  PoeEventType
} from '../../shared/events'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { PoeEventBus } from '../events/event-bus'
import { CharacterTracker } from '../log/character-tracker'
import type { PersistedCharacter } from '../log/character-tracker'
import { autodetectLogPath, candidateLogPaths, fileExists } from '../log/default-paths'
import { DEFAULT_MAX_BYTES_PER_READ, LogReader } from '../log/log-reader'
import type { LogReadResult, LogReadStatus } from '../log/log-reader'
import { parseLine } from '../log/parse-line'

// ---------------------------------------------------------------------------
// Event type registry
// ---------------------------------------------------------------------------

/**
 * The event types `--filter` accepts, in the order the summary lists them.
 *
 * Kept in lockstep with {@link PoeEventType} in BOTH directions, at compile time
 * and with no assertions:
 *  - `satisfies` proves every entry here is a real event type (list ⊆ union),
 *  - {@link AssertNever} below proves no event type is missing (union ⊆ list).
 *
 * Adding a fifth event to the union therefore breaks this file loudly instead
 * of silently omitting the new type from `--filter` and from the summary - which
 * is exactly the class of bug this tool exists to expose in the first place.
 */
const EVENT_TYPES = [
  'death',
  'zone-entered',
  'area-generated',
  'level-up'
] as const satisfies readonly PoeEventType[]

/**
 * The death causes the summary breaks `death` down by, in listing order.
 *
 * Same two-way lockstep as {@link EVENT_TYPES}, for the same reason: `'suicide'` is
 * SEVEN lines in a 375,087-line log, so a cause that quietly stopped being counted
 * would never be noticed by eye. See `DeathCause` in src/shared/events.ts for why
 * the distinction exists at all (a suicide counts, but must never be clipped).
 */
const DEATH_CAUSES = ['slain', 'suicide'] as const satisfies readonly DeathCause[]

/** Compiles only when `T` is `never`. Purely a type-level assertion; no runtime cost. */
type AssertNever<T extends never> = T
/** Fails to compile if a {@link PoeEventType} is missing from {@link EVENT_TYPES}. */
type _AllEventTypesListed = AssertNever<Exclude<PoeEventType, (typeof EVENT_TYPES)[number]>>
/** Fails to compile if a {@link DeathCause} is missing from {@link DEATH_CAUSES}. */
type _AllDeathCausesListed = AssertNever<Exclude<DeathCause, (typeof DEATH_CAUSES)[number]>>

/** Narrows an arbitrary `--filter` value to a real event type. */
function isEventType(value: string): value is PoeEventType {
  return EVENT_TYPES.some((type) => type === value)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** A fully resolved, validated command line. */
interface CliOptions {
  /** Explicit `--path`, already made absolute. `null` means "autodetect". */
  readonly path: string | null
  /** `--replay`: start at offset 0 instead of at the end of the file. */
  readonly replay: boolean
  /** Keep polling after the initial read drains. Defaults to `!replay`. */
  readonly follow: boolean
  /** `--filter`: print only this event type. `null` means "print everything". */
  readonly filter: PoeEventType | null
  /** `--unmatched-only`: print only lines no pattern claimed. */
  readonly unmatchedOnly: boolean
  /**
   * `--char`: the MANUAL OVERRIDE, i.e. `settings.character.override`.
   *
   * `''` - the default - is not "unconfigured", it is "no override": the tool then
   * AUTO-DETECTS from level-up lines exactly as the app does. A non-empty value
   * outranks detection entirely, which is what makes this flag the group-play escape
   * hatch it is in the app.
   */
  readonly charOverride: string
  /** `--limit`: stop after this many input lines. `null` means "no limit". */
  readonly limit: number | null
}

/** Argument parsing either succeeds, asks for help, or fails with a message. */
type ArgvResult =
  | { readonly kind: 'options'; readonly options: CliOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }

/** Flags that consume a value, either as `--flag=value` or `--flag value`. */
const VALUE_FLAGS = ['--path', '--filter', '--char', '--limit'] as const
/** Flags that are simply present or absent. */
const BOOLEAN_FLAGS = ['--replay', '--follow', '--unmatched-only', '--help', '-h'] as const

/**
 * Hand-rolled argument parser. No dependencies, and no silent tolerance: an
 * unknown flag, a missing value or a bare positional argument is an error, not
 * something to ignore. A typo'd `--unmatchedonly` that quietly did nothing would
 * make the user distrust the tool's OUTPUT, which is the one thing that has to be
 * trustworthy here.
 *
 * @param argv Usually `process.argv.slice(2)`. Injected so this stays testable.
 */
function parseArgv(argv: readonly string[]): ArgvResult {
  let path: string | null = null
  let replay = false
  let followFlag = false
  let filter: PoeEventType | null = null
  let unmatchedOnly = false
  let charOverride = ''
  let limit: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // `noUncheckedIndexedAccess` makes this `string | undefined`. Unreachable
    // inside the loop bounds, but narrowing it costs one line and no assertion.
    if (arg === undefined) continue

    // `npm run x -- -- --flag` can leak a bare separator through. Harmless.
    if (arg === '--') continue

    // Split `--flag=value` once; a value containing `=` (a Windows path never
    // does, but a character name might) keeps everything after the FIRST `=`.
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1)

    const isValueFlag = VALUE_FLAGS.some((flag) => flag === name)
    const isBooleanFlag = BOOLEAN_FLAGS.some((flag) => flag === name)

    if (!isValueFlag && !isBooleanFlag) {
      return arg.startsWith('-')
        ? { kind: 'error', message: `unknown option "${arg}"` }
        : { kind: 'error', message: `unexpected argument "${arg}" (every option starts with --)` }
    }

    if (isBooleanFlag && inlineValue !== null) {
      return { kind: 'error', message: `option "${name}" does not take a value` }
    }

    // Resolve the value for value-flags: inline `=` form first, then the
    // following argv entry. A following entry that looks like a flag is treated
    // as a missing value rather than swallowed - `--path --replay` is a mistake,
    // not a request to open a file called "--replay".
    let value = ''
    if (isValueFlag) {
      if (inlineValue !== null) {
        value = inlineValue
      } else {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('-')) {
          return { kind: 'error', message: `option "${name}" requires a value (use ${name}=<value>)` }
        }
        value = next
        index += 1
      }
    }

    switch (name) {
      case '--help':
      case '-h':
        return { kind: 'help' }

      case '--replay':
        replay = true
        break

      case '--follow':
        followFlag = true
        break

      case '--unmatched-only':
        unmatchedOnly = true
        break

      case '--path': {
        if (value.trim() === '') return { kind: 'error', message: '--path requires a non-empty file path' }
        // Native `resolve`, not `win32.resolve`: --path is whatever this machine
        // uses. (Autodetect is the Windows-specific half, and it lives in
        // default-paths.ts where win32 is used deliberately.)
        path = resolvePath(value)
        break
      }

      case '--filter': {
        if (!isEventType(value)) {
          return {
            kind: 'error',
            message: `--filter must be one of: ${EVENT_TYPES.join(', ')} (got "${value}")`
          }
        }
        filter = value
        break
      }

      case '--char':
        // Not trimmed to empty-as-error: an empty --char is a legitimate way to
        // say "no manual override", which is the DEFAULT and the interesting case -
        // it is what leaves auto-detection in charge. `CharacterTracker` trims it
        // itself, so a stray space cannot become an override that matches nothing.
        charOverride = value
        break

      case '--limit': {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) {
          return { kind: 'error', message: `--limit must be a positive whole number (got "${value}")` }
        }
        limit = parsed
        break
      }

      default:
        // Unreachable: `name` was checked against both flag lists above. Kept as
        // a total switch rather than an assertion so adding a flag to a list but
        // forgetting the case here degrades to a clear error, not a silent no-op.
        return { kind: 'error', message: `unhandled option "${name}"` }
    }
  }

  if (filter !== null && unmatchedOnly) {
    return {
      kind: 'error',
      message: '--filter and --unmatched-only are mutually exclusive (nothing would ever print)'
    }
  }

  return {
    kind: 'options',
    options: {
      path,
      replay,
      // --follow is only meaningful alongside --replay; without --replay we are
      // already tailing live and following is the only sensible behaviour.
      follow: replay ? followFlag : true,
      filter,
      unmatchedOnly,
      charOverride,
      limit
    }
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `poe-tool tail:debug - read-only Client.txt pattern verifier

USAGE
  npm run tail:debug -- [options]

OPTIONS
  --path=<file>     Path to Client.txt. Omit to autodetect a Windows install.
  --replay          Read the whole existing file from offset 0 instead of
                    tailing from the end. This is how you check the patterns
                    against your history.
  --follow          Keep tailing after --replay drains. Already the default
                    when --replay is not given.
  --filter=<type>   Print only this event type: ${EVENT_TYPES.join(', ')}.
                    Cannot be combined with --unmatched-only.
  --unmatched-only  Print only lines that matched no pattern.
  --char=<name>     MANUAL OVERRIDE of the active character, exactly like
                    settings.character.override. Wins over auto-detection.
                    OMIT IT to auto-detect from "<name> (<class>) is now level
                    <n>" lines, which is what the app does by default - the
                    ACTIVE lines below are how you confirm that works.
  --limit=<n>       Stop after reading n lines. Useful with --replay.
  -h, --help        Show this text.

OUTPUT
  MATCH      <type>  <json>   a recognised event
  UNMATCHED  <raw line>       a line no pattern claimed
  ACTIVE     <name> ...       the resolved active character changed

  --filter and --unmatched-only change what is PRINTED, never what is COUNTED:
  the closing SUMMARY always describes every line that was read. ACTIVE lines
  are never filtered out - which character a death belongs to is the context
  that makes every other line readable.

  The SUMMARY ends with a CHARACTERS SEEN table (deaths, highest level, class,
  name) ordered by death count. Nothing is persisted, so the name at the top of
  that table is the one to pass to --char, or to type into the app's override.

EXAMPLES
  npm run tail:debug -- --replay                     (auto-detect; the real test)
  npm run tail:debug -- --replay --limit=5000 --char=FyascoWorbinTime
  npm run tail:debug -- --replay --unmatched-only --limit=20000
  npm run tail:debug -- --path="C:\\Games\\PoE\\logs\\Client.txt" --filter=death
  npm run tail:debug -- --replay --filter=level-up   (who has this log ever been?)

NOTES
  The log file is opened READ ONLY. This tool never writes to it, and it never
  writes your settings.json either - a detection here lasts only for this run.
  Ctrl-C prints the summary and exits cleanly.`

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Wraps text in an ANSI SGR sequence, or returns it untouched. */
type Paint = (text: string) => string

/** The four-ish colours this tool uses. Deliberately restrained. */
interface Palette {
  readonly match: Paint
  readonly unmatched: Paint
  readonly active: Paint
  readonly type: Paint
  readonly raw: Paint
  readonly note: Paint
  readonly head: Paint
  readonly strong: Paint
}

/**
 * Builds a palette. When `colour` is false every entry is the identity function,
 * so the exact same code path produces clean, pipe-safe text - there is no
 * second, untested "plain" formatter to drift out of sync.
 *
 * Gated on `process.stdout.isTTY` by the caller: escape codes in a redirected
 * file or a `| grep` pipeline are noise at best and break `grep` at worst.
 */
function makePalette(colour: boolean): Palette {
  const wrap = (code: string): Paint =>
    colour ? (text: string): string => `\u001b[${code}m${text}\u001b[0m` : (text: string): string => text

  return {
    match: wrap('1;32'), // bold green
    unmatched: wrap('33'), // yellow
    active: wrap('1;35'), // bold magenta
    type: wrap('36'), // cyan
    raw: wrap('90'), // bright black / grey
    note: wrap('35'), // magenta
    head: wrap('1;4'), // bold underline
    strong: wrap('1') // bold
  }
}

// ---------------------------------------------------------------------------
// Line formatting
// ---------------------------------------------------------------------------

/** Two-digit zero pad for the timestamp echo. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Re-renders the parsed `Date` back into the log's own `YYYY/MM/DD HH:MM:SS`
 * form.
 *
 * Deliberately reconstructed from the `Date` rather than echoed from the raw
 * line: if the local-time parsing in `parse-line.ts` were ever wrong (a UTC
 * misreading, an off-by-one month), the printed stamp would visibly disagree with
 * the raw line next to it. Echoing the source string would hide exactly that bug.
 */
function formatStamp(date: Date): string {
  const day = `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  return `${day} ${time}`
}

/** The JSON-serialisable value types this tool prints. Never `any`. */
type FieldValue = string | number | boolean

/**
 * The interesting fields of an event, for the compact JSON on a MATCH line.
 *
 * `meta` is omitted (it is the raw line plus the envelope, both of which the user
 * can already see) and `detectedAt` is omitted (it is wall-clock noise that
 * changes every run and would make output diffs useless). What is left is the
 * decoded payload plus the re-rendered timestamp - i.e. everything the patterns
 * actually claim to have extracted.
 */
function eventFields(event: PoeEvent): Record<string, FieldValue> {
  const at = formatStamp(event.meta.timestamp)

  switch (event.type) {
    case 'death':
      // `cause` is shown ALWAYS, not just for suicides. It is the field the replay
      // clipper branches on - `'suicide'` is never clipped - so a death line that
      // did not say which kind it was would hide the single most consequential
      // decision this parser makes about it.
      return { at, characterName: event.characterName, cause: event.cause, isSelf: event.isSelf }
    case 'zone-entered':
      return { at, zoneName: event.zoneName }
    case 'area-generated':
      return { at, areaLevel: event.areaLevel, areaId: event.areaId, seed: event.seed }
    case 'level-up':
      return {
        at,
        characterName: event.characterName,
        className: event.className,
        level: event.level
      }
    default: {
      // Unreachable while the union is exhausted; adding a variant breaks here.
      const exhaustive: never = event
      return { at, unhandled: String(exhaustive) }
    }
  }
}

/** `MATCH  <type>  <compact json>`, padded so the JSON columns line up. */
function formatMatch(event: PoeEvent, palette: Palette): string {
  const fields: Record<string, FieldValue> = eventFields(event)
  // `backlog` is a real event field and it changes what production consumers do
  // (the clipper early-returns on it), so it is shown - but only when true, to
  // keep the common live-tail case free of a constant `"backlog":false`.
  if (event.backlog) fields['backlog'] = true

  const label = palette.match('MATCH')
  const type = palette.type(event.type.padEnd(14))
  return `${label}  ${type}  ${JSON.stringify(fields)}`
}

/** `UNMATCHED  <raw line>`. */
function formatUnmatched(raw: string, palette: Palette): string {
  return `${palette.unmatched('UNMATCHED')}  ${palette.raw(raw)}`
}

/**
 * One resolved character, rendered for humans:
 * `LargeThumbThomasReturns (Berserker, level 98)  via detected`.
 *
 * `source` is printed rather than implied, because "which rule produced this name"
 * is the entire question `--char` exists to answer: `via override` means the flag
 * won, `via detected` means a level-up line did, and the two are indistinguishable
 * from the name alone.
 *
 * Class and level are omitted when unknown rather than shown as null - an override
 * is just a name the user typed, so it legitimately has neither until a level-up
 * for that character shows up.
 */
function describeCharacter(character: ActiveCharacter, palette: Palette): string {
  if (character.name === null) {
    return palette.raw('(nobody - no --char override and no level-up seen yet, so every isSelf is false)')
  }

  const details: string[] = []
  if (character.className !== null) details.push(character.className)
  if (character.level !== null) details.push(`level ${String(character.level)}`)
  const suffix = details.length === 0 ? '' : ` (${details.join(', ')})`

  return `${palette.strong(character.name)}${suffix}  ${palette.raw(`via ${character.source}`)}`
}

/** `ACTIVE  <name> (<class>, level <n>)  via <source>`. */
function formatActive(character: ActiveCharacter, palette: Palette): string {
  return `${palette.active('ACTIVE')}  ${describeCharacter(character, palette)}`
}

/**
 * The part of an {@link ActiveCharacter} that decides whether a change is worth a
 * line of output: everything EXCEPT the level.
 *
 * `character-changed` fires whenever name, class, level or source moves, which means
 * it fires on every single level-up - 585 of them in the reference log. Printing all
 * of those would bury the ~dozen alt swaps that are the actual signal, and they are
 * already visible one-for-one as `MATCH level-up` lines. Class is kept in the key
 * because an ascendancy (Marauder -> Berserker) is rare and makes the printed line
 * wrong if skipped; the level shown on the line is always the current one either way.
 *
 * A SPACE is a safe separator even though `className` is documented as free text:
 * the two fields BEFORE it cannot contain one - `source` is one of three literals,
 * and a PoE character name is a single whitespace-free token (which is exactly why
 * `patterns.ts` can anchor the name on `\S+`) - and the class comes last. So no two
 * distinct triples can collapse into the same key.
 */
function identityOf(character: ActiveCharacter): string {
  return `${character.source} ${character.name ?? ''} ${character.className ?? ''}`
}

// ---------------------------------------------------------------------------
// Unmatched line shapes
// ---------------------------------------------------------------------------

/** Longest shape rendered in the summary before it gets an ellipsis. */
const MAX_SHAPE_LENGTH = 110

/** Quoted strings collapse first, so digits inside them never leak into the shape. */
const QUOTED_STRING = /"[^"]*"/g
/** A RUN of digits collapses to a single `#`: `1018412156` and `3` group together. */
const DIGIT_RUN = /\d+/g

/**
 * Collapses the variable parts of a line so that lines which differ only in their
 * data group into one bucket.
 *
 * ```text
 * Loading texture "Art/Textures/Interface/2DItems/Currency/Chaos.dds"
 * Loading texture "Art/Textures/Interface/2DItems/Currency/Alch.dds"
 *   -> Loading texture "..."                                    (count 2)
 *
 * Compiled shader ShadowMapDepth variant 3 in 41 ms
 *   -> Compiled shader ShadowMapDepth variant # in # ms
 * ```
 *
 * Without this, the top-5 list on a real 100MB Client.txt would be five different
 * texture paths and would tell the user nothing. With it, the list is a ranked
 * inventory of the MESSAGE KINDS that no pattern claims - which is precisely the
 * shopping list for the next regex.
 */
function normaliseShape(text: string): string {
  return text.replace(QUOTED_STRING, '"..."').replace(DIGIT_RUN, '#')
}

/**
 * The grouping key for one unmatched line.
 *
 * Shapes the BODY, not the whole raw line: the envelope's timestamp, clientMs,
 * thread tag and pid are pure noise that would otherwise dominate every shape.
 * The level and the system marker ARE kept, because "is this a DEBUG line or an
 * engine message" is the first question you ask about a candidate pattern - and
 * whether the marker is present decides whether a new pattern may be gated on it.
 *
 * A line whose ENVELOPE failed to parse has no body to shape, so the whole raw
 * line is shaped instead and flagged: those are truncated partial writes or
 * non-log content, and they mean something different from "unknown message".
 */
function shapeOf(result: ParseResult): string {
  if (result.type !== 'unmatched') return ''
  if (result.meta === null) return `<no envelope>  ${normaliseShape(result.raw)}`

  const marker = result.meta.isSystemMessage ? ' :' : ''
  const shape = `[${result.meta.level}]${marker} ${normaliseShape(result.meta.body)}`
  return shape.length > MAX_SHAPE_LENGTH ? `${shape.slice(0, MAX_SHAPE_LENGTH)}...` : shape
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * One row of the CHARACTERS SEEN table: everything this log says about one name.
 *
 * Mutable on purpose - one instance is updated in place per occurrence, rather than
 * 375,087 lines rebuilding immutable records.
 */
interface CharacterTally {
  /** First spelling seen. Names are GROUPED case-insensitively (see {@link recordCharacter}). */
  readonly display: string
  /**
   * Class from the MOST RECENT level-up, or null when this name only ever died.
   *
   * Most recent rather than first, because ascending replaces the base class with the
   * ascendancy under an unchanged name (the reference log has
   * `LargeThumbThomasReturns` going Marauder -> Berserker), and the current one is
   * the useful one. Never an identity - see `LevelUpEvent.className`.
   */
  className: string | null
  /**
   * HIGHEST level seen, not the last. A character's level never goes down, so the
   * maximum is the honest summary of a name that appears at levels 2, 3 and 41 - and
   * it is robust to a re-read of the same lines after a rotation.
   */
  highestLevel: number | null
  /**
   * This name's deaths, by cause. The TOTAL ({@link deathTotal}) orders the table.
   *
   * Broken out per character rather than only in aggregate because the totals are
   * otherwise impossible to reconcile: this log's most-killed character shows 198
   * deaths against 193 `has been slain.` lines, and without a suicide column that gap
   * looks like a parser bug instead of five `/kill`s.
   */
  readonly deaths: Record<DeathCause, number>
}

/** Deaths of every cause for one character - the table's ordering key. */
function deathTotal(tally: CharacterTally): number {
  return DEATH_CAUSES.reduce((sum, cause) => sum + tally.deaths[cause], 0)
}

/** Everything the closing summary reports. Counts EVERY line, regardless of filters. */
interface Stats {
  /** Input lines read and parsed. */
  totalLines: number
  /** Per-event-type match counts. Zeros are reported too - a zero is a finding. */
  readonly matched: Record<PoeEventType, number>
  /**
   * Deaths broken down by cause. Sums to `matched.death`.
   *
   * Reported separately because the two are treated differently downstream and by
   * nothing else in this tool: a `'suicide'` is a real death that counts for stats but
   * is NEVER clipped. If this line ever reads `slain 0 / suicide 355` the parser has
   * swapped them, and the user would otherwise only find out by never getting a clip.
   */
  readonly deaths: Record<DeathCause, number>
  /** Lines that parsed but matched no event pattern. */
  unmatched: number
  /** Subset of `unmatched` whose envelope itself failed - truncated/non-log lines. */
  envelopeFailures: number
  /** Shape -> occurrences. Insertion-ordered, which gives a stable tie-break. */
  readonly shapes: Map<string, number>
  /**
   * Lower-cased name -> tally, for every name that died or levelled in this log.
   * Insertion-ordered, so the table's tie-break is "first appearance".
   */
  readonly characters: Map<string, CharacterTally>
}

function newStats(): Stats {
  return {
    totalLines: 0,
    // Object literal, not a loop over EVENT_TYPES: this is what makes TypeScript
    // enforce that every PoeEventType has a counter, with no assertion.
    matched: { death: 0, 'zone-entered': 0, 'area-generated': 0, 'level-up': 0 },
    // Same trick, same reason: a new DeathCause fails to compile here rather than
    // silently going uncounted.
    deaths: { slain: 0, suicide: 0 },
    unmatched: 0,
    envelopeFailures: 0,
    shapes: new Map<string, number>(),
    characters: new Map<string, CharacterTally>()
  }
}

function record(stats: Stats, result: ParseResult): void {
  stats.totalLines += 1

  if (result.type !== 'unmatched') {
    stats.matched[result.type] += 1
    if (result.type === 'death') {
      stats.deaths[result.cause] += 1
      recordCharacter(stats, result)
    }
    if (result.type === 'level-up') recordCharacter(stats, result)
    return
  }

  stats.unmatched += 1
  if (result.meta === null) stats.envelopeFailures += 1

  const shape = shapeOf(result)
  stats.shapes.set(shape, (stats.shapes.get(shape) ?? 0) + 1)
}

/**
 * Folds one death or level-up into the CHARACTERS SEEN table.
 *
 * DEATHS COUNT HERE EVEN THOUGH THEY ARE USELESS FOR DETECTION. The two rules differ
 * for the same reason they differ in `CharacterTracker`: detecting from a death would
 * latch onto whichever ally died next to us, but merely LISTING a name claims only
 * "this appears in your Client.txt", which is true of a party member too. A stray
 * name in this table costs one wrong row; a stray name in the detector costs every
 * clip. Zone and area events name places, not people, and are ignored.
 *
 * Grouped case-insensitively, matching `CharacterTracker.suggestionsFrom` and every
 * other name comparison in the app, so one character can never occupy two rows.
 */
function recordCharacter(stats: Stats, event: DeathEvent | LevelUpEvent): void {
  const name = event.characterName.trim()
  // Unreachable via `parse-line` (both patterns require a `\S+` token), and cheap
  // insurance against a blank row that would tell the user nothing.
  if (name === '') return

  const key = name.toLowerCase()
  let tally = stats.characters.get(key)
  if (tally === undefined) {
    tally = { display: name, className: null, highestLevel: null, deaths: { slain: 0, suicide: 0 } }
    stats.characters.set(key, tally)
  }

  if (event.type === 'death') {
    tally.deaths[event.cause] += 1
    return
  }

  const className = event.className.trim()
  if (className !== '') tally.className = className
  if (Number.isFinite(event.level) && (tally.highestLevel === null || event.level > tally.highestLevel)) {
    tally.highestLevel = event.level
  }
}

/**
 * The N most common shapes, most common first.
 *
 * Ties break by first appearance, because `Map` preserves insertion order and
 * `Array.prototype.sort` is stable - so two runs over the same file always print
 * the same list in the same order.
 */
function topShapes(shapes: ReadonlyMap<string, number>, n: number): Array<readonly [string, number]> {
  return [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

/**
 * The characters table, MOST DEATHS FIRST - which is the order that answers the
 * question the table exists for ("which of these names is mine?"), because the
 * character you actually play is the one that keeps dying.
 *
 * Ties break by first appearance, exactly as {@link topShapes} does and for the same
 * reason: insertion-ordered `Map` plus a stable `sort` means two runs over one file
 * print the same table. That matters most for the long tail of 0-death names, where
 * every row ties.
 */
function characterRows(characters: ReadonlyMap<string, CharacterTally>): readonly CharacterTally[] {
  return [...characters.values()].sort((a, b) => deathTotal(b) - deathTotal(a))
}

/** How many unmatched shapes the summary lists. */
const TOP_SHAPE_COUNT = 5

/**
 * How many characters the summary lists before truncating.
 *
 * Generous rather than tight: the list is bounded in practice by "people you have
 * partied with", and hiding a row is only safe because the table is sorted by the
 * very thing that makes a row interesting. The remainder is still counted and
 * announced, so a truncated table can never read as a complete one.
 */
const MAX_CHARACTER_ROWS = 20

/** Rendered in the table when a name only ever died, so class and level are unknown. */
const UNKNOWN_FIELD = '-'

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One line to stdout. */
function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Extracts a `node:fs`-style `error.code` from an unknown value. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code
    if (typeof code === 'string') return code
  }
  return null
}

/**
 * The closing report, in three blocks: the counts, then who was seen, then what was
 * not understood.
 *
 * @param active The character resolved at the END of the run - i.e. what the app
 *   would be using now, having learned everything this log has to teach it.
 */
function printSummary(stats: Stats, active: ActiveCharacter, palette: Palette): void {
  printCounts(stats, palette)
  printActive(active, palette)

  write('')
  if (stats.totalLines === 0) {
    // Distinguished from "everything matched": zero lines means the file was
    // missing, empty, or already fully consumed - not that the patterns are
    // perfect. Conflating the two would be the most misleading thing this
    // summary could possibly say.
    write(palette.note('no lines were read - nothing to report'))
    return
  }

  printCharacters(stats, palette)
  write('')
  printShapes(stats, palette)
}

/** Lines read, matches per type (deaths broken down by cause), and the misses. */
function printCounts(stats: Stats, palette: Palette): void {
  const label = (text: string): string => text.padEnd(22)
  const count = (value: number): string => palette.strong(String(value).padStart(9))

  write('')
  write(palette.head('SUMMARY'))
  write(`${label('lines read')}${count(stats.totalLines)}`)

  const matchedTotal = EVENT_TYPES.reduce((sum, type) => sum + stats.matched[type], 0)
  write(`${label('matched')}${count(matchedTotal)}`)
  for (const type of EVENT_TYPES) {
    write(`${label(`  ${type}`)}${count(stats.matched[type])}`)
    // Nested under `death` wherever `death` happens to sit in EVENT_TYPES, so
    // reordering that list cannot detach the causes from their parent.
    if (type === 'death') {
      for (const cause of DEATH_CAUSES) {
        write(`${label(`    ${cause}`)}${count(stats.deaths[cause])}`)
      }
    }
  }

  write(`${label('unmatched')}${count(stats.unmatched)}`)
  write(`${label('  no envelope')}${count(stats.envelopeFailures)}`)
}

/**
 * Who the app would consider "me" now, after this whole run.
 *
 * Printed even when it is nobody - especially then. `source: 'none'` is the state in
 * which every `isSelf` is false and the clipper silently never fires, so a summary
 * that omitted it would reproduce exactly the silence this tool exists to break.
 */
function printActive(active: ActiveCharacter, palette: Palette): void {
  write(`${'active character'.padEnd(22)}${describeCharacter(active, palette)}`)
}

/**
 * The CHARACTERS SEEN table - most deaths first.
 *
 * `deaths / slain / suicide / level / class / name`. The name is LAST because it is
 * the only column with no width bound, so nothing after it could stay aligned;
 * everything before it is fixed-width and therefore scannable down the page.
 */
function printCharacters(stats: Stats, palette: Palette): void {
  if (stats.characters.size === 0) {
    write(palette.note('no character names appeared - this log has no deaths and no level-ups'))
    return
  }

  const rows = characterRows(stats.characters)
  const shown = rows.slice(0, MAX_CHARACTER_ROWS)
  const classOf = (row: CharacterTally): string => row.className ?? UNKNOWN_FIELD
  const levelOf = (row: CharacterTally): string =>
    row.highestLevel === null ? UNKNOWN_FIELD : String(row.highestLevel)

  // Widths from the rows actually printed, floored at each header's own width, so the
  // columns line up whether the classes are "Witch" or "Trickster".
  const classWidth = shown.reduce((width, row) => Math.max(width, classOf(row).length), 'class'.length)
  // One column PER DEATH CAUSE, generated from DEATH_CAUSES rather than hand-written,
  // so a cause added to the union cannot end up counted in the total but invisible in
  // the breakdown - which is the exact failure this table exists to make impossible.
  const causeWidths = new Map<DeathCause, number>(
    DEATH_CAUSES.map((cause) => [
      cause,
      shown.reduce((width, row) => Math.max(width, String(row.deaths[cause]).length), cause.length)
    ])
  )
  const causeCells = (render: (cause: DeathCause) => string): string =>
    DEATH_CAUSES.map((cause) => render(cause).padStart(causeWidths.get(cause) ?? cause.length)).join('  ')

  write(
    palette.head('CHARACTERS SEEN') +
      palette.raw(` (${String(stats.characters.size)} distinct, most deaths first - this is the name to use with --char)`)
  )
  write(
    palette.raw(
      `${'deaths'.padStart(8)}  ${causeCells((cause) => cause)}  ` +
        `${'level'.padStart(5)}  ${'class'.padEnd(classWidth)}  name`
    )
  )
  for (const row of shown) {
    write(
      `${palette.strong(String(deathTotal(row)).padStart(8))}  ` +
        `${causeCells((cause) => String(row.deaths[cause]))}  ` +
        `${levelOf(row).padStart(5)}  ${classOf(row).padEnd(classWidth)}  ${row.display}`
    )
  }
  if (rows.length > shown.length) {
    write(palette.raw(`${'...'.padStart(8)}  and ${String(rows.length - shown.length)} more with fewer deaths`))
  }
}

/** The top unmatched shapes - the ranked shopping list for the next regex. */
function printShapes(stats: Stats, palette: Palette): void {
  if (stats.shapes.size === 0) {
    write(palette.note('every line matched a pattern - no unmatched shapes to report'))
    return
  }

  const shown = Math.min(TOP_SHAPE_COUNT, stats.shapes.size)
  const heading = `TOP ${String(shown)} UNMATCHED SHAPE${shown === 1 ? '' : 'S'}`
  write(palette.head(heading) + palette.raw(` (of ${String(stats.shapes.size)} distinct)`))
  for (const [shape, occurrences] of topShapes(stats.shapes, TOP_SHAPE_COUNT)) {
    write(`${palette.strong(String(occurrences).padStart(9))}  ${shape}`)
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

type PathResult =
  | { readonly kind: 'path'; readonly path: string; readonly autodetected: boolean }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Resolves the log path: explicit `--path` wins, otherwise autodetect.
 *
 * The failure message is the important part. Autodetect cannot find a Steam
 * install on a second drive (see the notes in `default-paths.ts`), so failing is
 * a NORMAL outcome and the message has to leave the user able to act: it lists
 * every candidate that was tried, and on a machine that is not Windows it says so
 * explicitly rather than printing a confusing empty list.
 */
async function resolveLogPath(options: CliOptions): Promise<PathResult> {
  if (options.path !== null) {
    return { kind: 'path', path: options.path, autodetected: false }
  }

  const found = await autodetectLogPath(process.env, fileExists)
  const first = found[0]
  if (first !== undefined) {
    return { kind: 'path', path: first, autodetected: true }
  }

  const tried = candidateLogPaths(process.env)
  const detail =
    tried.length === 0
      ? [
          'No candidate paths could even be built: this machine defines none of',
          '%ProgramFiles(x86)%, %ProgramFiles% or %ProgramW6432%, which is expected',
          'anywhere that is not Windows.'
        ].join('\n')
      : ['Tried these paths, none of which exist:', ...tried.map((path) => `  ${path}`)].join('\n')

  return {
    kind: 'error',
    message: [
      'could not find Client.txt automatically.',
      '',
      detail,
      '',
      'Pass it explicitly, e.g.:',
      '  npm run tail:debug -- --path="C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt"'
    ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// Character resolution
// ---------------------------------------------------------------------------

/**
 * Builds the {@link CharacterTracker} this run resolves `isSelf` against, and wires
 * its announcements to `ACTIVE` lines on stdout.
 *
 * This is a REAL tracker, not a CLI-shaped imitation of one: the point of the tool is
 * to answer "would the app detect my character from this log", and the only honest way
 * to answer it is to run the code the app runs. `--char` is fed in as the override, so
 * the priority rule under test - override > detected > none - is the production rule
 * rather than a second copy of it.
 *
 * TWO DELIBERATE DIFFERENCES FROM PRODUCTION, both about persistence:
 *  - `getPersisted` always reports "never detected". In the app this reads
 *    `settings.character.detected*`, which is what makes ONE level-up ever enough
 *    across restarts; here it must not, or a detection from last week's run would be
 *    mistaken for a detection from this log.
 *  - `persist` is a no-op. `SettingsStore` imports electron (so it cannot be reached
 *    from this build at all), and a read-only diagnostic has no business rewriting the
 *    user's configuration.
 *
 * The bus exists only as the return path for `character-changed`; nothing is ever
 * published on it. Level-ups reach the tracker by the direct `handleLevelUp` call in
 * {@link tail}, exactly as `LogWatcher` delivers them - which is also why the
 * tracker's own `level-up` subscription never fires here and cannot double-count.
 */
function createCharacterTracker(options: CliOptions, palette: Palette): CharacterTracker {
  const note = (text: string): void => write(palette.note(`--  ${text}`))
  const bus = new PoeEventBus()

  const tracker = new CharacterTracker({
    bus,
    getOverride: (): string => options.charOverride,
    getPersisted: (): PersistedCharacter => ({ name: null, className: null, level: null }),
    persist: (): void => undefined,
    onError: (error: unknown): void => {
      // Nothing here is expected to fail - the getters are closures over a parsed
      // command line and `persist` does nothing. Reported rather than swallowed so
      // that if it ever does, the output says so instead of quietly resolving to
      // nobody and printing an empty characters table.
      note(`character tracker: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Seeded from the tracker's OWN starting answer, which its constructor deliberately
  // does not announce. The banner prints that value once; seeding here is what stops
  // the first real change from re-printing something the user has already read.
  let lastIdentity = identityOf(tracker.active())
  bus.on('character-changed', (character): void => {
    const identity = identityOf(character)
    if (identity === lastIdentity) return
    lastIdentity = identity
    write(formatActive(character, palette))
  })

  return tracker
}

// ---------------------------------------------------------------------------
// Interruptible sleep
// ---------------------------------------------------------------------------

/**
 * Poll interval between reads while following, taken from the app's own default
 * so the CLI's timing matches what production will do.
 */
const POLL_INTERVAL_MS = DEFAULT_SETTINGS.log.pollIntervalMs

/** Set by SIGINT. The read loop checks it and unwinds normally. */
let stopRequested = false
/** Resolves the in-flight {@link sleep} early. `null` when not sleeping. */
let wakeSleeper: (() => void) | null = null

/**
 * `setTimeout` as a promise, cancellable by {@link requestStop}.
 *
 * Ctrl-C during a 500ms nap must not wait out the nap: the handler resolves this
 * immediately, the loop sees `stopRequested`, and the summary prints. Doing it
 * this way (rather than printing the summary from inside the signal handler)
 * means the summary is always produced by exactly one code path, so it can never
 * print twice or print while a read is half-finished.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      wakeSleeper = null
      resolvePromise()
    }, ms)

    wakeSleeper = (): void => {
      clearTimeout(timer)
      wakeSleeper = null
      resolvePromise()
    }
  })
}

function requestStop(): void {
  stopRequested = true
  if (wakeSleeper !== null) wakeSleeper()
}

// ---------------------------------------------------------------------------
// The read loop
// ---------------------------------------------------------------------------

/** Human-readable note for a non-`ok` read result. */
function statusNote(result: LogReadResult): string {
  const code = result.code === undefined ? '' : ` [${result.code}]`
  const message = result.error ?? 'unknown error'
  return result.status === 'file-missing'
    ? `file is not there right now${code}: ${message}`
    : `read error${code}: ${message}`
}

/**
 * Reads the file and prints a line per input line, until the file drains (when
 * not following), the `--limit` is hit, or Ctrl-C.
 *
 * @param characters Resolves who "me" is, and learns from every level-up read. See
 *   {@link createCharacterTracker}.
 * @returns The process exit code.
 */
async function tail(
  options: CliOptions,
  logPath: string,
  stats: Stats,
  characters: CharacterTracker,
  palette: Palette
): Promise<number> {
  const reader = new LogReader(logPath)
  const note = (text: string): void => write(palette.note(`--  ${text}`))

  if (!options.replay) {
    const seek = await reader.seekToEnd()
    if (seek.status !== 'ok') {
      note(statusNote(seek))
      note('nothing to tail; pass --path=<file> or start the game')
      return 1
    }
    note(`skipped ${String(reader.offset)} existing bytes - use --replay to read them`)
  }

  /** True while we are draining bytes that already existed before we attached. */
  let draining = options.replay
  /** Last reported status, so a missing file is announced once, not every 500ms. */
  let lastStatus: LogReadStatus | null = null

  while (!stopRequested) {
    const result = await reader.readDelta()

    if (result.status !== 'ok') {
      if (result.status !== lastStatus) note(statusNote(result))
      lastStatus = result.status
      if (!options.follow) return 1
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (lastStatus !== null && lastStatus !== 'ok') note('file is readable again')
    lastStatus = 'ok'

    if (result.rotated) {
      note('file was truncated or replaced - re-reading from offset 0 (these lines are backlog)')
    }

    // Pre-existing bytes: the initial replay, or a post-rotation re-read. Copied
    // onto every event so the printed JSON matches exactly what a production
    // consumer would receive - and what it would therefore refuse to clip.
    // `result.backlog` (not `result.rotated`) stays true for the WHOLE drain, which
    // for a 100MB Client.txt is many capped reads rather than one.
    const backlog = draining || result.backlog
    const detectedAt = Date.now()

    let hitLimit = false
    for (const line of result.lines) {
      // RESOLVE FIRST, exactly as `LogWatcher.#parseAndDeliver` does: `isSelf` must
      // describe what was known when this line was logged, and a level-up on this
      // very line is evidence about the lines AFTER it, never about itself.
      const parsed = parseLine(line, {
        detectedAt,
        backlog,
        selfName: characters.active().name ?? ''
      })
      record(stats, parsed)
      printResult(parsed, options, palette)

      // LEARN LAST. The production order is learn-then-publish; here "publish" is
      // printing, so the swap changes no state - it only puts the `ACTIVE` line after
      // the `MATCH level-up` that caused it, which is the order a human reads. The
      // tracker is still current before the next line is parsed, which is the part
      // that actually matters.
      //
      // Backlog level-ups teach it too, deliberately: `--replay` is nothing but
      // backlog, so skipping them would make auto-detection untestable here and would
      // throw away the only evidence a rotation drain ever provides in the app.
      if (parsed.type === 'level-up') characters.handleLevelUp(parsed)

      if (options.limit !== null && stats.totalLines >= options.limit) {
        hitLimit = true
        break
      }
    }
    if (hitLimit) {
      note(`--limit=${String(options.limit)} reached`)
      break
    }

    if (result.bytesRead === 0) {
      if (draining) {
        draining = false
        if (options.follow) note('backlog drained - following live writes (Ctrl-C to stop)')
      }
      if (!options.follow) break
    }

    // Read again immediately while there is definitely more to consume: during
    // the initial drain, and whenever LogReader's per-read byte cap engaged
    // (which means the file has more waiting right now). Otherwise pace the loop
    // at the poll interval so a live tail is not a spin loop.
    const capEngaged = result.bytesRead >= DEFAULT_MAX_BYTES_PER_READ
    const moreWaiting = capEngaged || (draining && result.bytesRead > 0)
    if (!moreWaiting) await sleep(POLL_INTERVAL_MS)
  }

  return 0
}

/** Applies `--filter` / `--unmatched-only` and prints, or prints nothing. */
function printResult(result: ParseResult, options: CliOptions, palette: Palette): void {
  if (result.type === 'unmatched') {
    if (options.filter !== null) return
    write(formatUnmatched(result.raw, palette))
    return
  }

  if (options.unmatchedOnly) return
  if (options.filter !== null && options.filter !== result.type) return
  write(formatMatch(result, palette))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2))

  if (parsed.kind === 'help') {
    write(USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    write(`tail:debug: ${parsed.message}`)
    write('')
    write(USAGE)
    return 1
  }

  const options = parsed.options
  const palette = makePalette(process.stdout.isTTY === true)

  const located = await resolveLogPath(options)
  if (located.kind === 'error') {
    write(`tail:debug: ${located.message}`)
    return 1
  }

  // Banner: every decision this run is operating under, before a single line of
  // output. When the user pastes their output into a bug report, this is the
  // context that makes it interpretable.
  const mode = options.replay ? (options.follow ? 'replay from start, then follow' : 'replay from start') : 'live tail from end'
  const showing =
    options.unmatchedOnly
      ? 'unmatched lines only'
      : options.filter !== null
        ? `${options.filter} events only`
        : 'everything'

  // Built before the banner so the banner can print the character the tracker
  // actually starts from, rather than a second rendering of the same rule.
  const characters = createCharacterTracker(options, palette)

  write(`${palette.strong('tail:debug')}  ${located.path}${located.autodetected ? palette.raw('  (autodetected)') : ''}`)
  write(`${palette.raw('mode      ')} ${mode}`)
  write(`${palette.raw('character ')} ${describeCharacter(characters.active(), palette)}`)
  if (options.charOverride.trim() === '') {
    write(palette.raw('           auto-detecting from level-up lines; ACTIVE marks every change'))
  } else {
    write(palette.raw('           --char is a manual OVERRIDE; detected level-ups cannot outrank it'))
  }
  write(`${palette.raw('showing   ')} ${showing}${options.limit === null ? '' : `, first ${String(options.limit)} lines`}`)
  write(palette.raw('the log file is opened READ ONLY; nothing is ever written to it, settings.json included'))
  write('')

  const stats = newStats()
  const exitCode = await tail(options, located.path, stats, characters, palette)
  // The character as resolved AFTER the whole run - i.e. everything this log had to
  // teach the detector, which is the answer the user came for.
  printSummary(stats, characters.active(), palette)
  return exitCode
}

// Piping into `head` closes stdout early; that is a normal way to use this tool,
// not a crash. Node would otherwise surface it as an unhandled EPIPE error.
process.stdout.on('error', (error: Error): void => {
  if (errorCodeOf(error) === 'EPIPE') process.exit(0)
})

// First Ctrl-C unwinds the loop so the summary prints from its single normal
// code path. A second one means the user is not willing to wait for an in-flight
// read (a spun-down or network drive), so exit hard.
let interrupts = 0
process.on('SIGINT', () => {
  interrupts += 1
  if (interrupts === 1) {
    requestStop()
    return
  }
  process.exit(130)
})

void main().then(
  (code) => {
    // `exitCode` rather than `process.exit()`: stdout writes to a pipe are async,
    // and exiting immediately would truncate the summary.
    process.exitCode = code
  },
  (error: unknown) => {
    // Nothing in main() is expected to throw - LogReader and parseLine are both
    // total. If something does, print it rather than dying with a bare stack.
    write(`tail:debug: unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
)
