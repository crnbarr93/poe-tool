/**
 * src/main/log/log-reader.ts
 * ==========================
 *
 * The lowest layer of the log pipeline: a byte-offset cursor over Client.txt that
 * hands back only the COMPLETE lines that appeared since the previous call.
 *
 * It knows nothing about PoE. It does not parse, it does not emit, it never
 * throws. `log-watcher.ts` owns the polling timer and turns these results into
 * `WatcherStatus` values; `parse-line.ts` turns the strings into events.
 *
 * RULES FOR THIS FILE:
 *  - No `electron`. `node:fs` / `node:string_decoder` only, so it runs under plain
 *    node, under vitest, and under the `tail:debug` CJS build.
 *  - No `any`, no `@ts-ignore`. Caught errors are `unknown` and narrowed.
 *  - NEVER THROWS from a public method. Every failure comes back as a
 *    {@link LogReadResult} with a non-`ok` {@link LogReadStatus}. The tail loop
 *    runs every ~500ms forever; an exception escaping into it would take the main
 *    process down.
 *
 *
 * WHY OPEN/CLOSE ON EVERY TICK
 * ----------------------------
 * `readDelta()` calls `fs.promises.open(path, 'r')`, `fstat`s the handle, reads the
 * delta, and closes - all within the one call. That looks wasteful next to holding
 * one long-lived handle, and it is deliberate:
 *
 *  1. NO CONTENTION WITH THE GAME. PoE keeps Client.txt open for writing for the
 *     whole session. Node opens with `FILE_SHARE_READ | FILE_SHARE_WRITE |
 *     FILE_SHARE_DELETE` on Windows, so a read-only handle never blocks the game's
 *     writes and never makes the file undeletable. A short-lived handle shrinks
 *     that window to nothing.
 *  2. NO STALE HANDLES. If the file is replaced (fresh install, log rotated by a
 *     tool, GGG truncating an oversized log) a long-lived handle keeps pointing at
 *     the ORPHANED inode and silently reads nothing forever, with no error to
 *     notice. Re-opening by path every tick means the very next read lands on the
 *     current file and the rotation check below fires.
 *  3. The cost is one open + one fstat + one close per poll interval. Irrelevant
 *     next to the 500ms we spend idle.
 *
 *
 * ROTATION / TRUNCATION DETECTION
 * -------------------------------
 * The question is only ever "are the bytes before my offset still the bytes I
 * already read?", and there are two ways to answer it:
 *
 *  - `stat.size < offset` - the file got SHORTER. Truncation in place. Cheap and
 *    unambiguous, but blind to a replacement that is the same size or bigger.
 *  - A CONTENT FINGERPRINT - the last {@link FINGERPRINT_BYTES} bytes we consumed
 *    are remembered and positionally re-read at the top of every tick. If they
 *    changed, the prefix was rewritten under us and our offset points into the
 *    middle of a file we have never seen. This is the signal that carries the
 *    load, because it is the only one that catches the two cases that actually
 *    lose data:
 *      * truncate-and-regrow PAST the old offset between two polls (`size` is not
 *        smaller and the inode - hence the birth time - never changed), and
 *      * delete + recreate inside the NTFS file-tunneling window (~15s), where
 *        Windows deliberately gives the NEW file the OLD file's creation time.
 *
 * `stat.birthtimeMs` is kept ONLY as a fallback for the one moment no fingerprint
 * exists: a {@link seekToEnd} whose sample read failed. It is deliberately not an
 * independent OR-ed signal any more, because libuv falls back to `st_ctim` for
 * `birthtim` on filesystems with no real creation time - and `ctime` changes on
 * every append, which would report a rotation on EVERY tick and re-read the whole
 * file forever. A stale birth time with a matching fingerprint is harmless (the
 * bytes we consumed are provably still there); a changed fingerprint is not.
 *
 * DELIBERATELY NOT `stat.ino`. On Windows, `fs.stat` synthesises `ino` (it is 0 or
 * a truncated/unstable value depending on the filesystem and how the handle was
 * opened) so an inode comparison is either always-equal (never detects rotation)
 * or randomly-unequal (constant false rotations, replaying the log on every tick).
 *
 * On rotation the offset resets to 0, the carry buffer, the fingerprint and the
 * UTF-8 decoder are discarded (their contents belong to a file that no longer
 * exists), and the new file is read from the start IN THE SAME CALL.
 *
 *
 * `rotated` IS A ONE-SHOT SIGNAL, `backlog` IS THE DRAIN FLAG
 * ----------------------------------------------------------
 * These two are NOT the same thing and conflating them silently defeats every
 * `backlog` guard downstream. A single read is capped at
 * {@link LogReaderOptions.maxBytesPerRead}, so a replacement file bigger than the
 * cap takes many calls to drain - and the capped first chunk very often ends
 * mid-line, i.e. the `rotated: true` result can carry ZERO lines while all the
 * replayed content arrives on later calls.
 *
 *  - `rotated` is true on exactly the ONE call that noticed the reset, so the
 *    watcher can emit its `rotated` status once.
 *  - `backlog` is true for EVERY call whose bytes predate us, until the offset has
 *    caught up with the size observed at the moment we noticed. That is what the
 *    watcher must stamp onto the events, and what suppresses clips.
 *
 * `backlog` is also true for the first read of a file we could not open when we
 * attached ({@link seekToEnd} reporting `file-missing`, then the file appearing
 * with content already in it - a locked/late-mounted drive, a restored install)
 * and for a replay after {@link seekToStart}. In both cases the bytes were on disk
 * before we could look at them, which is exactly what `backlog` means.
 *
 *
 * TWO KINDS OF PARTIAL DATA, TWO BUFFERS
 * --------------------------------------
 * A delta read is cut at an arbitrary BYTE offset, so it can split things in half
 * at two different levels, and both have to survive across calls:
 *
 *  - A multi-byte UTF-8 sequence split mid-sequence (PoE logs item and player
 *    names with non-ASCII characters). Handled by a persistent
 *    {@link StringDecoder}: it retains the incomplete tail bytes internally and
 *    emits the character once the continuation bytes arrive in a later `write()`.
 *    Decoding each chunk with `buffer.toString('utf8')` instead would permanently
 *    corrupt the boundary character into U+FFFD.
 *  - A LINE split mid-line, because the game flushed half of it (or we hit the
 *    read cap). Handled by {@link #carry}: any text after the final `\n` is held
 *    back and prepended to the next chunk. A partial line is NEVER emitted - the
 *    parser would see a truncated envelope and, worse, half a line could be
 *    emitted and then the whole line emitted again next tick.
 */

import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Outcome of one {@link LogReader.readDelta} / {@link LogReader.seekToEnd} call.
 *
 *  - `ok` - the file was opened and read. Says nothing about whether there was
 *    any new data; a quiet tick is `ok` with zero lines.
 *  - `file-missing` - nothing exists at this path right now. EXPECTED, not an
 *    error: the game is not running, or the user has not launched it since a
 *    fresh install. The watcher keeps polling and recovers on its own.
 *  - `read-error` - anything else: permissions, an unreadable path, a device
 *    error. The watcher backs off and retries.
 */
export type LogReadStatus = 'ok' | 'file-missing' | 'read-error'

/**
 * What every {@link LogReader} operation returns. Total: there is no throwing
 * path and no `null` return.
 */
export interface LogReadResult {
  /**
   * Complete lines decoded during this call, in file order, WITHOUT their
   * trailing `\n` or `\r\n`. Empty on a quiet tick, on any failure, and when the
   * only new bytes were a partial line.
   *
   * A mutable array by design - it is freshly allocated per call and nobody else
   * holds a reference, so the consumer is free to sort/splice it.
   */
  readonly lines: string[]
  /**
   * True on the SINGLE call that noticed the file was truncated or replaced and
   * reset the offset to 0. A one-shot status signal for the watcher's `rotated`
   * `WatcherStatus`, NOT a "these lines are old" flag - use {@link backlog} for
   * that. A capped first chunk routinely ends mid-line, so this can be true on a
   * result carrying no lines at all while the replayed content arrives later.
   */
  readonly rotated: boolean
  /**
   * True when the `lines` in this result came from bytes that were already on disk
   * before we could read them: a post-rotation re-read (for as many calls as the
   * drain takes, not just the first), a file that appeared with content after we
   * reported it missing, or a deliberate {@link LogReader.seekToStart} replay.
   *
   * THIS is what the watcher must pass to `parseLine` as `backlog`, and therefore
   * what stops the replay clipper saving an OBS clip for a death that happened
   * hours ago.
   */
  readonly backlog: boolean
  /** Bytes consumed from the file by this call. `0` on failure and on quiet ticks. */
  readonly bytesRead: number
  /** See {@link LogReadStatus}. */
  readonly status: LogReadStatus
  /**
   * Human-readable failure reason, present only when `status !== 'ok'`. This is
   * `error.message`, which for `node:fs` errors already embeds the code and the
   * path (e.g. `EACCES: permission denied, open 'C:\...\Client.txt'`), so it is
   * safe to surface straight into the UI.
   */
  readonly error?: string
  /**
   * Node's `error.code` (`ENOENT`, `EACCES`, `EBUSY`, ...) when the platform
   * supplied one. Present only when `status !== 'ok'`.
   *
   * Beyond the shape the task pins down, purely so `log-watcher.ts` can populate
   * `WatcherReadErrorStatus.code` - that field exists in the frozen event
   * contract and would otherwise be permanently `null`, because this class is the
   * only place the original `Error` object is ever seen. Optional and additive:
   * consumers typed against the smaller shape are unaffected.
   */
  readonly code?: string
}

/** Constructor knobs. All optional; the defaults are what production uses. */
export interface LogReaderOptions {
  /**
   * Hard ceiling on the bytes pulled out of the file by a SINGLE
   * {@link LogReader.readDelta} call. Defaults to
   * {@link DEFAULT_MAX_BYTES_PER_READ}.
   *
   * WHY A CAP EXISTS. Normal tailing moves a few hundred bytes per tick, so this
   * never engages. It exists for the two cases where the delta is the whole file:
   * the `tail:debug` replay mode starting at offset 0, and a rotation where the
   * replacement file is large. A real Client.txt is routinely 100MB+, and reading
   * it into one Buffer would spike main-process memory for as long as the GC
   * takes to notice.
   *
   * When the cap engages the offset simply stops mid-file and the remainder is
   * picked up by the following call - the carry buffer means a line split by the
   * cap is still emitted exactly once. The caller needs no special handling; a
   * polling watcher just drains the backlog over several ticks.
   *
   * Values below 1 or non-finite values fall back to the default.
   */
  readonly maxBytesPerRead?: number
}

/** 8 MiB. See {@link LogReaderOptions.maxBytesPerRead}. */
export const DEFAULT_MAX_BYTES_PER_READ = 8 * 1024 * 1024

/**
 * How many already-consumed bytes are remembered as the rotation fingerprint.
 *
 * 64 is comfortably longer than any repeated prefix a Client.txt line can have
 * (the envelope alone is ~40 bytes and includes a monotonic millisecond counter),
 * so two different files agreeing on all 64 bytes at the same offset is not a
 * realistic outcome. Small enough that re-reading it costs nothing next to the
 * `open` + `fstat` the tick already does.
 */
export const FINGERPRINT_BYTES = 64

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Incremental, read-only cursor over a single log file.
 *
 * ```ts
 * const reader = new LogReader(settings.log.path)
 * await reader.seekToEnd()          // startup: ignore everything already written
 * setInterval(async () => {
 *   const { lines, rotated, status } = await reader.readDelta()
 *   ...
 * }, settings.log.pollIntervalMs)
 * ```
 *
 * Start-at-zero (the `tail:debug` replay mode) is simply the default state: skip
 * the `seekToEnd()` call, or use {@link seekToStart} to rewind an existing reader.
 *
 * LIFECYCLE / STATE. The instance owns the byte offset, the content fingerprint,
 * the remembered birth time, the backlog-drain marker, the UTF-8 decoder and the
 * partial-line carry. All of it describes ONE file at ONE path, so the path is
 * fixed at construction: when
 * the user points the app at a different Client.txt, build a new reader rather
 * than mutating this one, and the stale carry cannot leak across files.
 *
 * CONCURRENCY. Every public operation runs through an internal serial queue, so
 * overlapping calls (a slow disk plus a naive `setInterval` watcher) execute
 * strictly one after another. Without that, two in-flight reads would both stat
 * the same size, both read from the same offset, and every line would be emitted
 * twice - which downstream means two death events and two clips. Note the queue
 * makes overlapping calls SAFE, not free: a watcher should still schedule its next
 * tick after the previous result resolves rather than on a fixed interval.
 */
export class LogReader {
  /** Absolute path to the log file. Fixed for the life of the instance. */
  readonly #path: string

  /** See {@link LogReaderOptions.maxBytesPerRead}. Already validated. */
  readonly #maxBytesPerRead: number

  /**
   * Bytes consumed so far. The next read starts here. Reset to 0 on rotation and
   * by {@link seekToStart}; jumped to the file size by {@link seekToEnd}.
   */
  #offset = 0

  /**
   * `stat.birthtimeMs` from the last successful stat, or `null` when we have not
   * stat'd successfully yet. `null` means "adopt whatever the next stat reports"
   * - the first observation must never count as a rotation.
   *
   * Consulted ONLY when {@link #fingerprint} is null; see the file header.
   */
  #birthtimeMs: number | null = null

  /**
   * Copy of the last {@link FINGERPRINT_BYTES} bytes consumed, i.e. the bytes
   * ending exactly at {@link #offset}. Re-read from the file on every tick to prove
   * the prefix under us has not been rewritten. Null when nothing has been consumed
   * (or when a `seekToEnd` could not sample it).
   */
  #fingerprint: Buffer | null = null

  /**
   * File size observed at the moment we noticed we were holding pre-existing bytes
   * (a rotation, or a file that appeared after being missing). Every read is
   * reported with `backlog: true` until {@link #offset} reaches it; null means "we
   * are live".
   *
   * A whole read is flagged when it STARTS inside the drain, so the one chunk that
   * straddles the boundary is flagged too. That errs towards suppressing a clip for
   * a live death rather than saving one for an ancient death, which is the only
   * acceptable direction for this trade.
   */
  #backlogUntil: number | null = null

  /**
   * True when the NEXT successful read starts from bytes that were already on disk:
   * before the first read of a brand-new reader, after {@link seekToStart}, and
   * after a `seekToEnd` that could not open the file. Cleared by a successful
   * `seekToEnd` (which is what "ignore everything already written" means) and by
   * the read that acts on it.
   */
  #backlogPending = true

  /**
   * Carries incomplete multi-byte UTF-8 sequences across chunk boundaries.
   * Replaced (not reused) on rotation so bytes from the old file cannot bleed
   * into the first character of the new one.
   */
  #decoder = new StringDecoder('utf8')

  /** Text after the last `\n` of the previous chunk. Prepended to the next one. */
  #carry = ''

  /**
   * Tail of the serial operation queue. Always settles fulfilled - the internal
   * implementations catch everything, and the queue swallows anyway so one
   * failure can never wedge every later call.
   */
  #queue: Promise<void> = Promise.resolve()

  constructor(path: string, options?: LogReaderOptions) {
    this.#path = path
    const max = options?.maxBytesPerRead
    this.#maxBytesPerRead =
      max !== undefined && Number.isFinite(max) && max >= 1
        ? Math.floor(max)
        : DEFAULT_MAX_BYTES_PER_READ
  }

  /** The file this reader was constructed for. */
  get path(): string {
    return this.#path
  }

  /**
   * Bytes consumed so far - i.e. where the next read will start. Feeds
   * `WatcherTailingStatus.offset`. Reflects only COMPLETED operations; reading it
   * while a `readDelta()` is in flight gives the pre-call value.
   */
  get offset(): number {
    return this.#offset
  }

  /**
   * Reads everything written since the previous call and returns the complete
   * lines it contained.
   *
   * Never throws and never rejects. Sequence per call: open read-only, fstat,
   * check for rotation, read `min(size - offset, maxBytesPerRead)` bytes from the
   * offset, close, decode, split.
   */
  readDelta(): Promise<LogReadResult> {
    return this.#enqueue(() => this.#readDeltaOnce())
  }

  /**
   * Moves the offset to the current end of the file WITHOUT reading anything, and
   * drops any half-decoded state.
   *
   * This is the startup default: Client.txt holds hours or days of history, and
   * replaying it would fire a burst of stale events (and, if any consumer forgot
   * its `backlog` guard, a burst of stale clips). Skipping it also means the first
   * live tick has a tiny delta instead of a 100MB one.
   *
   * Returns the same {@link LogReadResult} shape as {@link readDelta} for a single
   * uniform result type; `lines` is always empty and `bytesRead` always 0 because
   * nothing is consumed. A `file-missing` result is normal (the game has not run
   * yet) and leaves the offset at 0, so when the file does appear it is read from
   * its start - with `backlog: true`, because content that was already in a file we
   * could not open predates us however recently the file itself was created.
   */
  seekToEnd(): Promise<LogReadResult> {
    return this.#enqueue(() => this.#seekToEndOnce())
  }

  /**
   * Rewinds to offset 0 and discards all decode state, so the next
   * {@link readDelta} replays the file from the beginning. Used by the debug CLI's
   * replay mode; also the honest way to re-sync after the caller decides its
   * offset is untrustworthy.
   *
   * Synchronous and infallible - it touches no filesystem. The remembered birth
   * time is cleared too, so the next stat is adopted rather than being reported as
   * a spurious rotation.
   *
   * NOT queued: it is a plain field assignment. Calling it while a `readDelta()`
   * is in flight means that read still finishes against its own offset and its
   * result then overwrites this rewind - so rewind between calls, not during one.
   */
  seekToStart(): void {
    this.#offset = 0
    this.#birthtimeMs = null
    this.#fingerprint = null
    this.#backlogUntil = null
    // Everything a rewind re-reads existed before we rewound, by definition.
    this.#backlogPending = true
    this.#resetDecodeState()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Runs `task` after every previously queued operation has settled. */
  #enqueue(task: () => Promise<LogReadResult>): Promise<LogReadResult> {
    const next = this.#queue.then(task)
    // Swallow on the QUEUE only; `next` itself is what the caller gets back.
    this.#queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** {@link readDelta} minus the queueing. */
  async #readDeltaOnce(): Promise<LogReadResult> {
    let handle: FileHandle | undefined
    try {
      handle = await fs.open(this.#path, 'r')
      const stat = await handle.stat()

      const rotated = await this.#detectRotation(handle, stat.size, stat.birthtimeMs)
      if (rotated) {
        this.#offset = 0
        this.#fingerprint = null
        this.#resetDecodeState()
        this.#startBacklogDrain(stat.size)
      } else if (this.#backlogPending) {
        // Bytes that were on disk before we could open the file are by definition
        // pre-existing, however new the file itself is.
        this.#startBacklogDrain(stat.size)
      }
      this.#backlogPending = false

      const available = stat.size - this.#offset
      if (available <= 0) {
        // Provably caught up: there is nothing left that predates us.
        this.#backlogUntil = null
        return { lines: [], rotated, backlog: false, bytesRead: 0, status: 'ok' }
      }

      // Sampled BEFORE the read, so the chunk that straddles the end of the drain
      // is still reported as backlog.
      const backlog = this.#backlogUntil !== null

      const length = Math.min(available, this.#maxBytesPerRead)
      const buffer = Buffer.allocUnsafe(length)
      // Positional read: does not depend on (or move) the handle's own cursor.
      const { bytesRead } = await handle.read(buffer, 0, length, this.#offset)
      // Decode only what was actually filled - the tail of an allocUnsafe buffer
      // is uninitialised memory.
      const chunk = buffer.subarray(0, bytesRead)
      this.#offset += bytesRead
      this.#rememberFingerprint(chunk)
      if (this.#backlogUntil !== null && this.#offset >= this.#backlogUntil) {
        this.#backlogUntil = null
      }

      const lines = this.#consume(chunk)
      return { lines, rotated, backlog, bytesRead, status: 'ok' }
    } catch (error) {
      const failure = toFailure(error)
      if (failure.status === 'file-missing') {
        // Whatever turns up at this path later was written while we could not see
        // it, so its existing content must be drained as backlog.
        this.#backlogPending = true
      }
      return failure
    } finally {
      if (handle !== undefined) {
        // A failing close must not mask the real result, and must not throw out
        // of the `finally` and replace it either.
        await handle.close().catch(() => undefined)
      }
    }
  }

  /** {@link seekToEnd} minus the queueing. */
  async #seekToEndOnce(): Promise<LogReadResult> {
    let handle: FileHandle | undefined
    try {
      handle = await fs.open(this.#path, 'r')
      const stat = await handle.stat()
      this.#offset = stat.size
      this.#birthtimeMs = stat.birthtimeMs
      this.#resetDecodeState()
      // Everything already in the file has been skipped, so nothing pre-existing is
      // outstanding: the next bytes to arrive are genuinely live.
      this.#backlogUntil = null
      this.#backlogPending = false
      this.#fingerprint = await this.#sampleFingerprint(handle, stat.size)
      return { lines: [], rotated: false, backlog: false, bytesRead: 0, status: 'ok' }
    } catch (error) {
      const failure = toFailure(error)
      if (failure.status === 'file-missing') {
        // The file we were told to skip past does not exist yet. Whatever appears
        // here later was written without us watching - drain it as backlog.
        this.#backlogPending = true
      }
      return failure
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined)
      }
    }
  }

  /** Marks the bytes up to `size` as pre-existing, unless there are none. */
  #startBacklogDrain(size: number): void {
    this.#backlogUntil = size > this.#offset ? size : null
  }

  /**
   * Decides whether the file under us is no longer the file we were reading, and
   * remembers the new birth time either way.
   *
   * See the file header for why the CONTENT fingerprint is the primary signal and
   * `birthtimeMs` only a fallback.
   */
  async #detectRotation(handle: FileHandle, size: number, birthtimeMs: number): Promise<boolean> {
    const previousBirthtimeMs = this.#birthtimeMs
    this.#birthtimeMs = birthtimeMs

    // Nothing consumed yet: there are no "bytes I already read" to invalidate, so
    // rotation is not a meaningful question and must never be answered `true`.
    if (this.#offset === 0) return false

    // The file got shorter than our cursor. Unambiguous, and cheaper than a read.
    if (size < this.#offset) return true

    const fingerprint = this.#fingerprint
    if (fingerprint === null) {
      // No content check available (a `seekToEnd` whose sample read came up empty).
      // First successful stat never counts as a rotation.
      return previousBirthtimeMs !== null && birthtimeMs !== previousBirthtimeMs
    }

    const start = this.#offset - fingerprint.length
    if (start < 0) return true
    const probe = Buffer.allocUnsafe(fingerprint.length)
    const { bytesRead } = await handle.read(probe, 0, fingerprint.length, start)
    // A short read means the file shrank between the stat and now: also a rotation.
    return bytesRead !== fingerprint.length || !probe.subarray(0, bytesRead).equals(fingerprint)
  }

  /**
   * Reads back the last {@link FINGERPRINT_BYTES} bytes of a file we are about to
   * start tailing from its end, so the very first tick already has a content check.
   *
   * Returns null for an empty file or a short/failed read; the birth-time fallback
   * covers that case.
   */
  async #sampleFingerprint(handle: FileHandle, size: number): Promise<Buffer | null> {
    const length = Math.min(size, FINGERPRINT_BYTES)
    if (length <= 0) return null
    try {
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, size - length)
      return bytesRead === length ? buffer : null
    } catch {
      // Sampling is an optimisation, never a reason to fail a seek.
      return null
    }
  }

  /**
   * Records the last {@link FINGERPRINT_BYTES} bytes ending at the new offset.
   *
   * A chunk shorter than the fingerprint is APPENDED to the previous one rather
   * than replacing it, because the fingerprint must always end exactly at the
   * offset - a partial-line tick that consumed 12 bytes must not shrink the check
   * to those 12 bytes.
   *
   * Always copies: `chunk` is a view into an `allocUnsafe` buffer, and retaining a
   * subarray of it would pin the whole (up to 8 MiB) allocation.
   */
  #rememberFingerprint(chunk: Buffer): void {
    if (chunk.length === 0) return
    const previous = this.#fingerprint ?? EMPTY_BUFFER
    const combined = chunk.length >= FINGERPRINT_BYTES ? chunk : Buffer.concat([previous, chunk])
    const start = Math.max(0, combined.length - FINGERPRINT_BYTES)
    this.#fingerprint = Buffer.from(combined.subarray(start))
  }

  /**
   * Decodes a chunk and splits off the complete lines, holding the trailing
   * fragment back for next time.
   *
   * Blank lines are passed through as `''` rather than filtered: this layer is a
   * faithful transport and the parser already classifies anything it does not
   * recognise as an `UnmatchedLine`. Dropping them here would be a silent,
   * invisible edit to the byte stream.
   */
  #consume(chunk: Buffer): string[] {
    const text = this.#carry + this.#decoder.write(chunk)
    const parts = text.split('\n')
    // `split` always yields at least one element; the last one is whatever
    // followed the final newline - `''` when the chunk ended cleanly.
    this.#carry = parts.pop() ?? ''
    return parts.map(stripTrailingCarriageReturn)
  }

  /**
   * Drops the partial-line carry and the decoder's retained bytes. Both describe
   * a position in a file we are no longer reading.
   */
  #resetDecodeState(): void {
    this.#carry = ''
    // A fresh instance rather than `end()`: `end()` would flush the retained
    // bytes as replacement characters, and we want them GONE, not mangled.
    this.#decoder = new StringDecoder('utf8')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turns a caught `unknown` into a failure result.
 *
 * `ENOENT` (nothing at the path) and `ENOTDIR` (a PARENT component is a file, so
 * the path cannot exist either - happens with a hand-edited settings.json) are
 * both classified `file-missing`: recoverable, keep polling, do not alarm the
 * user. Everything else is `read-error`.
 */
function toFailure(error: unknown): LogReadResult {
  const code = errorCodeOf(error)
  const status: LogReadStatus = code === 'ENOENT' || code === 'ENOTDIR' ? 'file-missing' : 'read-error'
  const message = errorMessageOf(error)
  // Built in two branches because `exactOptionalPropertyTypes` forbids assigning
  // an explicit `undefined` to an optional property.
  return code === null
    ? { lines: [], rotated: false, backlog: false, bytesRead: 0, status, error: message }
    : { lines: [], rotated: false, backlog: false, bytesRead: 0, status, error: message, code }
}

/** Shared zero-length buffer for the fingerprint concat. Never mutated. */
const EMPTY_BUFFER = Buffer.alloc(0)

/** Extracts a `node:fs` style `error.code`, or `null` if the value has none. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code
    if (typeof code === 'string') return code
  }
  return null
}

/** Best-effort message for any thrown value, including non-`Error` throws. */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Removes the `\r` of a `\r\n` pair after splitting on `\n`.
 *
 * Client.txt is written by a Windows process and uses CRLF, but the file is also
 * read on macOS during development and from fixtures that may have been normalised
 * to LF - so we split on `\n` and strip an optional `\r` instead of splitting on a
 * fixed terminator. Only ONE `\r` is removed: a line whose text genuinely ends in
 * a carriage return keeps the rest.
 */
function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
