/**
 * src/main/log/name-scan.ts
 * =========================
 *
 * A bounded, read-only sweep of the END of Client.txt for the character names it
 * mentions - the raw material for the one-click picker the UI shows when nothing has
 * been detected (`character:suggestions`).
 *
 * RULES FOR THIS FILE (it lives under `src/main/log/**`):
 *  - No `electron`. `node:fs` only, so it runs under vitest and the tools build.
 *  - No `any`, no `@ts-ignore`.
 *  - NEVER THROWS. Every failure - no path configured, file missing, permissions,
 *    a device error - comes back as an empty array. The caller is an IPC handler
 *    whose contract says an empty list is a NORMAL answer, so a failure here must
 *    degrade into that rather than reject an invoke into an opaque string.
 *  - READ ONLY, like every other consumer of this log: `fs.open(path, 'r')` and one
 *    positional read. Nothing in this process may write to Client.txt.
 *
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE SESSION RING BUFFER
 * -----------------------------------------------------
 * `character:suggestions` used to harvest names purely from the `events:recent` ring
 * buffer, and that is empty in exactly the state the picker exists for. `LogWatcher`
 * starts with `LogReader.seekToEnd()` - by design, so launching the app does not
 * replay hours of stale deaths - so on a FRESH LAUNCH not one pre-existing byte is
 * ever parsed. `settings.character.detected` is null on a first run, the override is
 * empty, so the UI raises its full-width "nothing will be clipped" alarm and offers a
 * picker containing nothing at all, while the six names that would fix it sit in the
 * log file the app is already tailing. The list would only fill after the user's first
 * death or level-up - i.e. after the first clip has already been silently lost, which
 * is the exact outcome the picker was specified to prevent.
 *
 * It is not much better later in a session: the ring buffer holds 200 events and the
 * stream is dominated by zone traffic (the reference log has 8,065 zone-entered +
 * 8,070 area-generated against 355 deaths), so a 200-event window can easily contain
 * no name-bearing event at all.
 *
 *
 * WHY THE TAIL, AND WHY BOUNDED
 * -----------------------------
 * A real Client.txt is 40-100MB+ and the user's is 375,087 lines. Reading it whole to
 * populate a picker would spike main-process memory for as long as the GC takes to
 * notice, and would be dominated by names from characters retired a year ago. The LAST
 * {@link DEFAULT_SCAN_BYTES} bytes are both cheap and the most relevant slice - at the
 * reference log's ~115 bytes/line that is tens of thousands of recent lines.
 *
 * Names are still ordered by the caller (`CharacterTracker.suggestionsFrom`), which
 * tallies frequency; this function only decides WHICH lines are looked at.
 *
 *
 * NOTHING IS PUBLISHED
 * --------------------
 * The events are RETURNED, never emitted onto the bus. That is not a stylistic choice:
 * the bus fan-out reaches `ReplayClipper` (via `death:self`) and `CharacterTracker`
 * (via `level-up`), so publishing a sweep of historical lines would ask OBS to save a
 * clip for a death from last week and could overwrite a good detection from a mule's
 * old level-up line. A pure function that hands back values cannot do either.
 */

import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

import type { DeathEvent, LevelUpEvent } from '../../shared/events'
import { parseLine } from './parse-line'

/**
 * How many bytes off the end of the log a scan reads by default: 4 MiB.
 *
 * Half of `LogReader`'s per-read cap, because this one is triggered by a button in the
 * UI rather than by the tail loop and buys nothing from being bigger: at the reference
 * log's ~115 bytes per line it covers ~36,000 lines, and name-bearing lines (deaths +
 * level-ups) run about 2.5 per 1,000 there, so a typical sweep still sees dozens of
 * them across every character recently played.
 */
export const DEFAULT_SCAN_BYTES = 4 * 1024 * 1024

/** The only two event types that name a character. Nothing else is kept. */
export type NameBearingEvent = DeathEvent | LevelUpEvent

/** Knobs. All optional; the defaults are what the IPC handler uses. */
export interface NameScanOptions {
  /**
   * Upper bound on the bytes read off the end of the file. Values below 1 or
   * non-finite fall back to {@link DEFAULT_SCAN_BYTES}, matching `LogReader`.
   */
  readonly maxBytes?: number
  /**
   * Clock for `PoeEventBase.detectedAt`. Injected so tests are deterministic.
   *
   * The events are stamped `backlog: true` regardless - they came from bytes that were
   * on disk before we looked, which is precisely what `backlog` means. Nothing
   * downstream of this function acts on either field (the names are all that is
   * wanted), but a value object that lied about its own provenance would be a trap for
   * whoever consumes this next.
   */
  readonly now?: () => number
  /** Diagnostic sink for the failure this function swallows. Default: no-op. */
  readonly onError?: (error: unknown) => void
}

/**
 * Every death and level-up in the last {@link NameScanOptions.maxBytes} bytes of
 * `logPath`, in file order.
 *
 * Feed the result to `CharacterTracker.suggestionsFrom` - alone, or concatenated
 * BEFORE the session ring buffer so the tally counts both and the recency tie-break
 * still sees the newest events last.
 *
 * @param logPath `settings.log.path`. `null` (or blank) means "not configured yet" and
 *   yields an empty array, exactly like a missing file.
 */
export async function scanLogForNameEvents(
  logPath: string | null,
  options: NameScanOptions = {}
): Promise<readonly NameBearingEvent[]> {
  const report = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // A diagnostic hook must never be the reason a picker comes back empty.
    }
  }

  if (logPath === null || logPath.trim() === '') return []

  const maxBytes =
    options.maxBytes !== undefined && Number.isFinite(options.maxBytes) && options.maxBytes >= 1
      ? Math.floor(options.maxBytes)
      : DEFAULT_SCAN_BYTES
  const detectedAt = options.now?.() ?? Date.now()

  let handle: FileHandle | undefined
  try {
    handle = await fs.open(logPath, 'r')
    const { size } = await handle.stat()
    if (size <= 0) return []

    const length = Math.min(size, maxBytes)
    const start = size - length
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    // Decode only what was actually filled: the tail of an allocUnsafe buffer is
    // uninitialised memory.
    const text = buffer.subarray(0, bytesRead).toString('utf8')

    const lines = text.split('\n')
    // A scan that started mid-file almost certainly started mid-LINE, and that first
    // fragment is also where a split multi-byte UTF-8 sequence would have decoded to
    // U+FFFD. Both problems are the same one byte-slice artefact and both are solved
    // by dropping it - one line out of tens of thousands.
    if (start > 0) lines.shift()

    const found: NameBearingEvent[] = []
    for (const line of lines) {
      // `selfName: ''` - `isSelf` is meaningless here and must not be guessed: the
      // resolved character is what this scan is trying to help the user CHOOSE.
      const parsed = parseLine(line, { detectedAt, backlog: true, selfName: '' })
      if (parsed.type === 'death' || parsed.type === 'level-up') found.push(parsed)
    }
    return found
  } catch (error) {
    // ENOENT (the game has never run), EACCES, a bad path from a hand-edited
    // settings.json - all of them mean "no names to offer", which the UI already
    // handles by telling the user to type one.
    report(error)
    return []
  } finally {
    if (handle !== undefined) {
      // A failing close must not replace the result we are about to return.
      await handle.close().catch(() => undefined)
    }
  }
}
