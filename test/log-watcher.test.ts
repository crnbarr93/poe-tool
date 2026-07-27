/**
 * test/log-watcher.test.ts
 * ========================
 *
 * The watcher is a TIMER over a FILE, so both halves are exercised for real and
 * only the clock is faked:
 *
 *  - REAL temp files (`fs.mkdtemp`), appended/truncated/replaced exactly the way
 *    PoE and the OS do it. A mocked `fs` would agree with whatever wrong model of
 *    rotation this file encoded.
 *  - FAKE timers, so a 500ms poll costs no wall time and "five quiet ticks" is an
 *    exact statement rather than a sleep-and-hope.
 *
 * WHY `toFake` IS SPELLED OUT
 * ---------------------------
 * `vi.useFakeTimers()` fakes `setImmediate` too, and this suite needs ONE real
 * macrotask primitive: a tick is `open -> fstat -> read -> close`, and those
 * complete in the libuv poll phase. Draining microtasks (`await Promise.resolve()`)
 * never lets the poll phase run, so the test would assert on a tick that has not
 * happened yet. Leaving `setImmediate` real gives {@link settle} a way to yield a
 * whole event-loop turn. `Date` IS faked, so `status.since` is deterministic and
 * the status-dedupe assertions mean what they say.
 *
 * WHY `settle()` COUNTS IN-FLIGHT READS INSTEAD OF SPINNING N TIMES
 * ----------------------------------------------------------------
 * "Yield 25 event-loop turns and hope the tick finished" is a RACE, and it fails
 * roughly one run in five: `setImmediate` spins through the check phase without
 * waiting for anything, so 25 turns can elapse in microseconds while the
 * threadpool is still opening the file. The test then asserts on a tick that has
 * not landed and reports a bug that does not exist.
 *
 * So every reader the watcher builds is wrapped in a {@link TrackingReader} that
 * counts async operations in flight, and {@link settle} waits for that count to
 * reach zero and stay there. That is an exact signal - the watcher publishes
 * synchronously in the continuation of `readDelta`, so once no read is
 * outstanding, everything the tick was going to do has been done. The real-time
 * deadline only exists to fail loudly instead of hanging.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  DeathEvent,
  PoeEvent,
  PoeEventMap,
  UnmatchedLine,
  WatcherStatus
} from '../src/shared/events'
import { validateSettings, type AppSettings } from '../src/shared/settings'
import { TypedEmitter } from '../src/main/events/typed-emitter'
import { LogReader, type LogReadResult } from '../src/main/log/log-reader'
import { LogWatcher, type LogReaderLike, type LogWatcherOptions } from '../src/main/log/log-watcher'

// ---------------------------------------------------------------------------
// Fixtures - verbatim real Client.txt lines
// ---------------------------------------------------------------------------

const SELF_NAME = 'FyascoWorbinTime'

const SLAIN =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
const PARTY_SLAIN =
  '2026/07/26 19:26:33 1018412999 cffb0658 [INFO Client 50396] : GrumpyTotemDad has been slain.'
const ENTERED =
  '2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'
const GENERATING =
  '2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1'
/** Player chat that mimics a death line. No `": "` marker => must never become an event. */
const SPOOF =
  '2026/07/26 19:26:40 1018421337 cffb0658 [INFO Client 50396] TrollMcSpoof: FyascoWorbinTime has been slain.'

const POLL = 500

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir = ''
let logPath = ''
let bus: TypedEmitter<PoeEventMap>
let watcher: LogWatcher | null = null

let events: PoeEvent[] = []
let statuses: WatcherStatus[] = []
let unmatched: UnmatchedLine[] = []
let selfDeaths: DeathEvent[] = []
let deaths: DeathEvent[] = []
let errors: unknown[] = []

let settings: AppSettings

beforeEach(async () => {
  vi.useFakeTimers({
    // setImmediate deliberately left REAL - see the file header.
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })

  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-tool-log-watcher-'))
  logPath = path.join(dir, 'Client.txt')
  // Pre-existing history. Nothing here may ever reach the bus: the app seeks to
  // the end on start.
  await fs.writeFile(logPath, `${GENERATING}\n${ENTERED}\n`)

  inFlight = 0
  bus = new TypedEmitter<PoeEventMap>()
  events = []
  statuses = []
  unmatched = []
  selfDeaths = []
  deaths = []
  errors = []
  bus.on('event', (event) => events.push(event))
  bus.on('watcher-status', (status) => statuses.push(status))
  bus.on('unmatched', (line) => unmatched.push(line))
  bus.on('death', (death) => deaths.push(death))
  bus.on('death:self', (death) => selfDeaths.push(death))

  settings = makeSettings({ logPath })
})

afterEach(async () => {
  watcher?.stop()
  watcher = null
  vi.useRealTimers()
  await fs.rm(dir, { recursive: true, force: true })
})

function makeSettings(over: {
  logPath?: string | null
  pollIntervalMs?: number
  name?: string
}): AppSettings {
  return validateSettings({
    log: {
      path: over.logPath === undefined ? logPath : over.logPath,
      pollIntervalMs: over.pollIntervalMs ?? POLL
    },
    character: { name: over.name ?? SELF_NAME }
  })
}

/**
 * Builds the watcher under test with the shared bus + a live settings snapshot.
 *
 * Whatever reader the test asks for is wrapped in a {@link TrackingReader}, so
 * {@link settle} can tell when a tick has actually finished. See the file header.
 */
function createWatcher(overrides?: Partial<LogWatcherOptions>): LogWatcher {
  const makeInner = overrides?.createReader ?? ((target: string) => new LogReader(target))
  const options: LogWatcherOptions = {
    bus,
    getSettings: () => settings,
    onError: (error) => errors.push(error),
    ...overrides,
    createReader: (target) => new TrackingReader(makeInner(target))
  }
  watcher = new LogWatcher(options)
  return watcher
}

/** Async reader operations the watcher currently has outstanding. */
let inFlight = 0

function track<T>(promise: Promise<T>): Promise<T> {
  inFlight++
  return promise.finally(() => {
    inFlight--
  })
}

/** One full event-loop turn (timers -> poll -> check), and a full microtask drain. */
function turn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * Waits until the watcher has no read outstanding and has finished reacting to the
 * last one.
 *
 * The three extra turns after the count hits zero cover the microtasks that run
 * after a read resolves: the tracking `finally`, the watcher's own continuation
 * (which is what publishes events and statuses), and the `finally` that releases
 * the overlap guard. The loop then re-checks, so a tick that chains a restart -
 * `readDelta` followed by a fresh `seekToEnd` - is waited out too.
 *
 * NOT usable while a {@link GatedReader} is deliberately parked; use {@link spin}
 * there.
 */
async function settle(): Promise<void> {
  const deadline = performance.now() + 5000
  for (;;) {
    await turn()
    if (inFlight === 0) {
      await turn()
      await turn()
      await turn()
      if (inFlight === 0) return
    }
    if (performance.now() > deadline) {
      throw new Error(`watcher never settled: ${inFlight} read(s) still in flight`)
    }
  }
}

/**
 * A few bare event-loop turns, for the cases where a read is parked ON PURPOSE and
 * quiescence will never arrive. Everything asserted after a `spin` is either set
 * synchronously (a call counter) or provably cannot have happened (the read that
 * would produce it is blocked).
 */
async function spin(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await turn()
}

/** Fires `count` poll beats and lets each one's I/O finish. */
async function poll(count = 1, intervalMs = POLL): Promise<void> {
  for (let i = 0; i < count; i++) {
    vi.advanceTimersByTime(intervalMs)
    await settle()
  }
}

/**
 * Burns real wall-clock time without touching the (faked) timers.
 *
 * `setTimeout` is faked, so the usual sleep would hang forever. `performance.now`
 * is NOT in `toFake`, so it still measures reality, and `setImmediate` is the real
 * yield. Needed only where the assertion depends on the FILESYSTEM's clock -
 * `birthtime` on a recreated file - which no amount of fake-clock advancing moves.
 */
async function realDelay(ms: number): Promise<void> {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) await turn()
}

async function append(text: string, target = logPath): Promise<void> {
  await fs.appendFile(target, text)
}

function types(list: readonly PoeEvent[]): string[] {
  return list.map((event) => event.type)
}

function statesOf(list: readonly WatcherStatus[]): string[] {
  return list.map((status) => status.state)
}

// ---------------------------------------------------------------------------
// Test doubles for the reader
// ---------------------------------------------------------------------------

/**
 * Wraps any reader and reports how many of its async operations are outstanding.
 * The signal {@link settle} waits on; see the file header for why a spin count is
 * not good enough.
 */
class TrackingReader implements LogReaderLike {
  readonly #inner: LogReaderLike

  constructor(inner: LogReaderLike) {
    this.#inner = inner
  }

  get path(): string {
    return this.#inner.path
  }

  get offset(): number {
    return this.#inner.offset
  }

  seekToStart(): void {
    this.#inner.seekToStart()
  }

  seekToEnd(): Promise<LogReadResult> {
    return track(this.#inner.seekToEnd())
  }

  readDelta(): Promise<LogReadResult> {
    return track(this.#inner.readDelta())
  }
}

/**
 * A real {@link LogReader} whose `readDelta` parks until the test releases it.
 *
 * The only way to make a tick outlast the poll interval deterministically, which
 * is the whole point of the overlap-guard test. Everything else about it is real,
 * so the released read still returns genuine bytes from the temp file.
 */
class GatedReader implements LogReaderLike {
  readonly #inner: LogReader
  readonly #gates: Array<() => void> = []

  /** How many times `readDelta` was ENTERED - the double-read counter. */
  calls = 0
  /** Peak simultaneous `readDelta` bodies. Must stay 1. */
  maxConcurrent = 0
  #concurrent = 0

  constructor(target: string) {
    this.#inner = new LogReader(target)
  }

  get path(): string {
    return this.#inner.path
  }

  get offset(): number {
    return this.#inner.offset
  }

  seekToStart(): void {
    this.#inner.seekToStart()
  }

  seekToEnd(): Promise<LogReadResult> {
    return this.#inner.seekToEnd()
  }

  async readDelta(): Promise<LogReadResult> {
    this.calls++
    this.#concurrent++
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#concurrent)
    try {
      await new Promise<void>((resolve) => {
        this.#gates.push(resolve)
      })
      return await this.#inner.readDelta()
    } finally {
      this.#concurrent--
    }
  }

  /** Lets every parked read proceed. */
  release(): void {
    for (const gate of this.#gates.splice(0)) gate()
  }
}

/** Returns the same canned result forever. Used for failures the OS will not stage for us. */
class ConstantReader implements LogReaderLike {
  readonly path: string
  readonly offset = 0
  calls = 0
  readonly #result: LogReadResult

  constructor(target: string, result: LogReadResult) {
    this.path = target
    this.#result = result
  }

  seekToStart(): void {
    // Nothing to rewind.
  }

  async seekToEnd(): Promise<LogReadResult> {
    return this.#result
  }

  async readDelta(): Promise<LogReadResult> {
    this.calls++
    return this.#result
  }
}

// ---------------------------------------------------------------------------
// Tailing
// ---------------------------------------------------------------------------

describe('LogWatcher tailing', () => {
  it('skips pre-existing history and publishes lines appended afterwards', async () => {
    const w = createWatcher()
    await w.start()

    // The two lines already in the file must NOT have been replayed.
    expect(events).toEqual([])
    expect(w.status.state).toBe('tailing')

    await append(`${SLAIN}\n`)
    await poll()

    expect(types(events)).toEqual(['death'])
    const death = events[0]
    expect(death?.type).toBe('death')
    if (death?.type !== 'death') throw new Error('expected a death event')
    expect(death.characterName).toBe(SELF_NAME)
    expect(death.isSelf).toBe(true)
    // Live bytes, not a replay: nothing here may be suppressed by a clipper.
    expect(death.backlog).toBe(false)
    expect(death.meta.isSystemMessage).toBe(true)
  })

  it('publishes multiple lines from one tick in file order, exactly once each', async () => {
    const w = createWatcher()
    await w.start()

    await append(`${GENERATING}\n${ENTERED}\n${SLAIN}\n`)
    await poll()

    expect(types(events)).toEqual(['area-generated', 'zone-entered', 'death'])

    // A second beat with nothing new must not re-emit any of them.
    await poll(3)
    expect(events).toHaveLength(3)
  })

  it('fans out to the per-type channels, and to death:self only for the local character', async () => {
    const w = createWatcher()
    await w.start()

    await append(`${SLAIN}\n${PARTY_SLAIN}\n`)
    await poll()

    expect(deaths.map((d) => d.characterName)).toEqual([SELF_NAME, 'GrumpyTotemDad'])
    // A party member dying must never reach the channel the clipper listens on.
    expect(selfDeaths.map((d) => d.characterName)).toEqual([SELF_NAME])
  })

  it('holds a half-written line back until its newline arrives', async () => {
    const w = createWatcher()
    await w.start()

    await append(SLAIN.slice(0, 40))
    await poll()
    expect(events).toEqual([])

    await append(`${SLAIN.slice(40)}\n`)
    await poll()
    expect(types(events)).toEqual(['death'])
  })

  it('routes chat that mimics a system message to unmatched, never to an event', async () => {
    const w = createWatcher()
    await w.start()

    await append(`${SPOOF}\n`)
    await poll()

    expect(events).toEqual([])
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0]?.meta?.isSystemMessage).toBe(false)
    expect(selfDeaths).toEqual([])
  })

  it('picks up a changed character name without restarting the tail', async () => {
    const w = createWatcher()
    await w.start()

    settings = makeSettings({ name: 'GrumpyTotemDad' })
    await append(`${PARTY_SLAIN}\n`)
    await poll()

    expect(selfDeaths).toHaveLength(1)
    // Same attach: a restart would have reset linesRead to 0.
    const status = w.status
    expect(status.state).toBe('tailing')
    if (status.state !== 'tailing') throw new Error('expected tailing')
    expect(status.linesRead).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Status emission
// ---------------------------------------------------------------------------

describe('LogWatcher status', () => {
  it('emits tailing once on start and stays silent while nothing changes', async () => {
    const w = createWatcher()
    await w.start()

    expect(statesOf(statuses)).toEqual(['tailing'])

    await poll(6)
    expect(statuses).toHaveLength(1)

    // A line arrives: offset/linesRead genuinely moved, so exactly one new status.
    await append(`${SLAIN}\n`)
    await poll()
    expect(statuses).toHaveLength(2)
    expect(statuses[1]?.state).toBe('tailing')

    // ...and then quiet again.
    await poll(4)
    expect(statuses).toHaveLength(2)
    expect(w.status.state).toBe('tailing')
  })

  it('keeps `since` pinned to when the state was entered, not to the last tick', async () => {
    const w = createWatcher()
    await w.start()
    const first = statuses[0]
    if (first?.state !== 'tailing') throw new Error('expected tailing')

    await poll(4)
    await append(`${SLAIN}\n`)
    await poll()

    const latest = w.status
    if (latest.state !== 'tailing') throw new Error('expected tailing')
    expect(latest.since).toBe(first.since)
    expect(latest.offset).toBeGreaterThan(first.offset)
    expect(latest.lastLineAt).not.toBeNull()
  })

  it('reports a missing file exactly once and recovers on its own when it appears', async () => {
    const later = path.join(dir, 'Later.txt')
    settings = makeSettings({ logPath: later })

    const w = createWatcher()
    await w.start()

    expect(statesOf(statuses)).toEqual(['file-missing'])
    expect(w.status.state).toBe('file-missing')

    // Ten quiet retries: still exactly one status, and no CPU-burning loop.
    await poll(10)
    expect(statuses).toHaveLength(1)
    expect(events).toEqual([])

    // The game launches.
    await append(`${SLAIN}\n`, later)
    await poll()

    expect(w.status.state).toBe('tailing')
    expect(statesOf(statuses)).toEqual(['file-missing', 'tailing'])
    expect(types(events)).toEqual(['death'])
    // Content that was in the file the first time we could open it was written
    // while we were unable to look, so it is BACKLOG - we cannot tell one line
    // written a second ago from a hundred megabytes written last week. See the
    // dedicated regression test below for why that distinction matters.
    expect(events[0]?.backlog).toBe(true)

    // ...and the tail is live from there on.
    await append(`${ENTERED}\n`, later)
    await poll()
    expect(types(events)).toEqual(['death', 'zone-entered'])
    expect(events[1]?.backlog).toBe(false)
  })

  it('marks a whole log that appears after being missing as backlog, not as live deaths', async () => {
    // REGRESSION: the app is in Windows startup and launches before the drive
    // holding the PoE install is mounted, so every open returns ENOENT. The volume
    // unlocks seconds later and a Client.txt with weeks of history appears at the
    // same path. Publishing that as live fires the replay clipper for every death
    // in it - `ReplayClipper` only suppresses on `death.backlog`.
    const later = path.join(dir, 'Later.txt')
    settings = makeSettings({ logPath: later })

    const w = createWatcher()
    await w.start()
    expect(w.status.state).toBe('file-missing')

    const history = `${GENERATING}\n${ENTERED}\n${SLAIN}\n${SLAIN}\n${SLAIN}\n`
    await fs.writeFile(later, history)
    await poll()

    expect(selfDeaths).toHaveLength(3)
    expect(selfDeaths.every((death) => death.backlog)).toBe(true)
    expect(events.every((event) => event.backlog)).toBe(true)
  })

  it('reports a read error once, keeps polling, and never throws', async () => {
    const failure: LogReadResult = {
      lines: [],
      rotated: false,
      backlog: false,
      bytesRead: 0,
      status: 'read-error',
      error: "EACCES: permission denied, open 'Client.txt'",
      code: 'EACCES'
    }
    const readers: ConstantReader[] = []

    const w = createWatcher({
      createReader: (target) => {
        const reader = new ConstantReader(target, failure)
        readers.push(reader)
        return reader
      }
    })
    await w.start()
    await poll(5)

    const reader = readers.at(-1)
    if (reader === undefined) throw new Error('no reader was created')

    expect(statesOf(statuses)).toEqual(['read-error'])
    expect(reader.calls).toBe(5) // still polling, just not shouting about it
    const status = w.status
    if (status.state !== 'read-error') throw new Error('expected read-error')
    expect(status.code).toBe('EACCES')
    expect(status.message).toContain('EACCES')
  })

  it('sits idle without touching the filesystem when no path is configured', async () => {
    settings = makeSettings({ logPath: null })
    const readers: string[] = []

    const w = createWatcher({
      createReader: (target) => {
        readers.push(target)
        return new LogReader(target)
      }
    })
    await w.start()

    expect(statesOf(statuses)).toEqual(['idle'])
    expect(w.status.state).toBe('idle')

    await poll(5)
    expect(readers).toEqual([]) // no reader was ever built
    expect(statuses).toHaveLength(1)
  })

  it('survives a listener that throws and keeps tailing', async () => {
    bus.on('event', () => {
      throw new Error('listener exploded')
    })

    const w = createWatcher()
    await w.start()

    await append(`${SLAIN}\n`)
    await poll()
    await append(`${ENTERED}\n`)
    await poll()

    // The throw was reported, not propagated, and the loop kept going.
    expect(errors).toHaveLength(2)
    expect(types(events)).toEqual(['death', 'zone-entered'])
    expect(w.status.state).toBe('tailing')
  })
})

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('LogWatcher rotation', () => {
  it('reports rotated once, marks the re-read lines backlog, and keeps tailing', async () => {
    const w = createWatcher()
    await w.start()

    await append(`${ENTERED}\n`)
    await poll()
    expect(types(events)).toEqual(['zone-entered'])

    const before = w.status
    if (before.state !== 'tailing') throw new Error('expected tailing')

    // PoE truncates Client.txt in place when it grows too large: same file, size
    // goes backwards.
    await fs.writeFile(logPath, `${SLAIN}\n`)
    await poll()

    const rotated = statuses.filter((status) => status.state === 'rotated')
    expect(rotated).toHaveLength(1)
    const first = rotated[0]
    if (first?.state !== 'rotated') throw new Error('expected rotated')
    expect(first.previousOffset).toBe(before.offset)
    expect(first.offset).toBe(0)

    // The replacement file's content predates us, so it must be suppressible.
    const replayed = events[1]
    expect(replayed?.type).toBe('death')
    expect(replayed?.backlog).toBe(true)

    // Rotation is transient: we are tailing again immediately, and quiet.
    expect(w.status.state).toBe('tailing')
    const tailStatuses = statuses.length
    await poll(3)
    expect(statuses).toHaveLength(tailStatuses)

    // And the tail continues seamlessly on the NEW file.
    await append(`${ENTERED}\n`)
    await poll()
    expect(types(events)).toEqual(['zone-entered', 'death', 'zone-entered'])
    expect(events[2]?.backlog).toBe(false)
  })

  it('handles a file that was deleted and recreated larger than the old offset', async () => {
    const w = createWatcher()
    await w.start()

    await append(`${SLAIN}\n`)
    await poll()
    expect(events).toHaveLength(1)

    // Delete + recreate: a different file at the same path, and one that is NOT
    // shorter than our old offset - so the size check cannot see this. The content
    // fingerprint can: the bytes we already consumed are no longer at our offset.
    // (The real delay is retained so the file's birth time also genuinely moves,
    // proving the detection does not depend on which signal fires first.)
    await fs.rm(logPath)
    await realDelay(25)
    await fs.writeFile(logPath, `${ENTERED}\n${SLAIN}\n${GENERATING}\n${ENTERED}\n`)
    await poll()

    const rotated = statuses.filter((status) => status.state === 'rotated')
    expect(rotated).toHaveLength(1)
    const only = rotated[0]
    if (only?.state !== 'rotated') throw new Error('expected rotated')
    // The size check provably cannot be what fired: the replacement is longer.
    expect(only.previousOffset).toBeLessThan(
      (await fs.stat(logPath)).size
    )

    expect(types(events)).toEqual([
      'death',
      'zone-entered',
      'death',
      'area-generated',
      'zone-entered'
    ])
    expect(events.slice(1).every((event) => event.backlog)).toBe(true)
    expect(w.status.state).toBe('tailing')
  })

  it('marks EVERY chunk of a multi-read rotation drain as backlog, not just the first', async () => {
    // REGRESSION: `rotated` is a one-shot signal - it is true only on the read that
    // noticed the reset - and a single read is capped, so a replacement file bigger
    // than the cap drains over many reads. Stamping events with `rotated` published
    // all but the first chunk as LIVE, and `ReplayClipper` only suppresses on
    // `death.backlog`, so hours-old deaths each saved a real OBS clip. Worse: the
    // capped first chunk usually ends mid-line, so the one `rotated: true` result
    // often carries no lines at all.
    const oneLine = Buffer.byteLength(`${SLAIN}\n`, 'utf8')
    const w = createWatcher({
      // Small enough that the drain provably needs several reads.
      createReader: (target) => new LogReader(target, { maxBytesPerRead: oneLine - 10 })
    })
    await w.start()

    // Two beats: the cap is narrower than one line, so the first read stops
    // mid-line and the carry buffer completes it on the next.
    await append(`${ENTERED}\n`)
    await poll(2)
    expect(types(events)).toEqual(['zone-entered'])

    // PoE truncates Client.txt in place when it grows too large.
    await fs.writeFile(logPath, `${SLAIN}\n`.repeat(5))
    await poll(12)

    expect(statuses.filter((status) => status.state === 'rotated')).toHaveLength(1)
    expect(deaths).toHaveLength(5)
    expect(deaths.map((death) => death.backlog)).toEqual([true, true, true, true, true])
    expect(selfDeaths.every((death) => death.backlog)).toBe(true)

    // Once the drain has caught up the tail is live again.
    await append(`${SLAIN}\n`)
    await poll(2)
    expect(deaths).toHaveLength(6)
    expect(deaths.at(-1)?.backlog).toBe(false)
  })

  it('keeps tailing without a phantom rotation when a replacement file has the same prefix', async () => {
    // A file recreated with byte-identical content up to our offset is NOT a
    // rotation in any way that matters: every byte we consumed is still exactly
    // where we consumed it, so continuing from the offset loses and duplicates
    // nothing. Re-reading it would republish lines the app has already seen.
    const w = createWatcher()
    await w.start()

    await append(`${SLAIN}\n`)
    await poll()
    expect(events).toHaveLength(1)

    const carriedOver = await fs.readFile(logPath)
    await fs.rm(logPath)
    await realDelay(25)
    await fs.writeFile(logPath, Buffer.concat([carriedOver, Buffer.from(`${ENTERED}\n`)]))
    await poll()

    expect(statuses.filter((status) => status.state === 'rotated')).toEqual([])
    expect(types(events)).toEqual(['death', 'zone-entered'])
  })
})

// ---------------------------------------------------------------------------
// Overlap guard
// ---------------------------------------------------------------------------

describe('LogWatcher overlap guard', () => {
  it('skips beats while a tick is in flight instead of stacking reads', async () => {
    const readers: GatedReader[] = []
    const w = createWatcher({
      createReader: (target) => {
        const reader = new GatedReader(target)
        readers.push(reader)
        return reader
      }
    })
    await w.start()

    const reader = readers.at(-1)
    if (reader === undefined) throw new Error('no reader was created')

    await append(`${GENERATING}\n${ENTERED}\n${SLAIN}\n`)

    // Beat 1 enters readDelta and parks there.
    vi.advanceTimersByTime(POLL)
    await spin()
    expect(reader.calls).toBe(1)

    // Beats 2 and 3 fire while beat 1 is still running: both must be dropped.
    vi.advanceTimersByTime(POLL)
    vi.advanceTimersByTime(POLL)
    await spin()
    expect(reader.calls).toBe(1)
    expect(reader.maxConcurrent).toBe(1)
    expect(events).toEqual([])

    // Let it finish: the delta is read exactly once, so every line appears once.
    reader.release()
    await settle()
    expect(types(events)).toEqual(['area-generated', 'zone-entered', 'death'])

    // The loop is healthy afterwards - the guard released.
    vi.advanceTimersByTime(POLL)
    await spin()
    expect(reader.calls).toBe(2)
    reader.release()
    await settle()
    expect(events).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('LogWatcher.stop', () => {
  it('is idempotent, leaves no timers, and publishes nothing afterwards', async () => {
    const w = createWatcher()
    await w.start()
    expect(vi.getTimerCount()).toBe(1)

    w.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(w.status.state).toBe('idle')
    expect(w.running).toBe(false)
    const afterFirstStop = statuses.length
    expect(statuses.at(-1)?.state).toBe('idle')

    // Two more stops: no timers resurrected, no duplicate idle statuses.
    w.stop()
    w.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(statuses).toHaveLength(afterFirstStop)

    // The clock keeps running; the watcher does not.
    await append(`${SLAIN}\n`)
    await poll(5)
    expect(events).toEqual([])
    expect(statuses).toHaveLength(afterFirstStop)
  })

  it('is safe to call before start, and start works again after stop', async () => {
    const w = createWatcher()
    w.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(statuses).toEqual([]) // nothing was ever running, so nothing to report

    await w.start()
    await append(`${SLAIN}\n`)
    await poll()
    expect(types(events)).toEqual(['death'])

    w.stop()
    expect(vi.getTimerCount()).toBe(0)

    await w.start()
    await append(`${ENTERED}\n`)
    await poll()
    expect(types(events)).toEqual(['death', 'zone-entered'])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('discards a read that was already in flight when stop landed', async () => {
    const readers: GatedReader[] = []
    const w = createWatcher({
      createReader: (target) => {
        const reader = new GatedReader(target)
        readers.push(reader)
        return reader
      }
    })
    await w.start()

    const reader = readers.at(-1)
    if (reader === undefined) throw new Error('no reader was created')

    await append(`${SLAIN}\n`)
    vi.advanceTimersByTime(POLL)
    await spin()
    expect(reader.calls).toBe(1)

    w.stop()
    reader.release()
    await settle()

    // The bytes were consumed by the reader, but nothing reached the bus after stop.
    expect(events).toEqual([])
    expect(statuses.at(-1)?.state).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Live reconfiguration
// ---------------------------------------------------------------------------

describe('LogWatcher reconfiguration', () => {
  it('restarts on a path change and does not replay the new file either', async () => {
    const w = createWatcher()
    await w.start()

    const other = path.join(dir, 'Other.txt')
    await fs.writeFile(other, `${SLAIN}\n${SLAIN}\n`) // history on the NEW file
    settings = makeSettings({ logPath: other })

    // The tick notices on its own - no reconfigure() call needed.
    await poll()
    expect(events).toEqual([])
    expect(w.path).toBe(other)

    await append(`${ENTERED}\n`, other)
    await poll()
    expect(types(events)).toEqual(['zone-entered'])

    // The old file is no longer watched.
    await append(`${SLAIN}\n`)
    await poll()
    expect(types(events)).toEqual(['zone-entered'])
  })

  it('applies a new poll interval', async () => {
    const w = createWatcher()
    await w.start()

    settings = makeSettings({ pollIntervalMs: 2000 })
    await poll() // this beat detects the change and rearms at 2000ms

    await append(`${SLAIN}\n`)

    // The old 500ms cadence is gone.
    await poll(3, 500)
    expect(events).toEqual([])

    await poll(1, 500) // 4 x 500 = the new interval
    expect(types(events)).toEqual(['death'])
    expect(w.status.state).toBe('tailing')
  })

  it('reconfigure() restarts on a path change and is a no-op otherwise', async () => {
    const w = createWatcher()
    await w.start()

    await append(`${SLAIN}\n`)
    await poll()
    const before = w.status
    if (before.state !== 'tailing') throw new Error('expected tailing')
    expect(before.linesRead).toBe(1)

    // An unrelated settings change must not tear down a healthy tail.
    settings = makeSettings({ name: 'SomeoneElse' })
    await w.reconfigure()
    const after = w.status
    if (after.state !== 'tailing') throw new Error('expected tailing')
    expect(after.linesRead).toBe(1)
    expect(after.since).toBe(before.since)

    // A path change does restart it.
    const other = path.join(dir, 'Other.txt')
    await fs.writeFile(other, `${ENTERED}\n`)
    settings = makeSettings({ logPath: other, name: 'SomeoneElse' })
    await w.reconfigure()

    expect(w.path).toBe(other)
    const restarted = w.status
    if (restarted.state !== 'tailing') throw new Error('expected tailing')
    expect(restarted.linesRead).toBe(0)
    expect(events).toHaveLength(1) // still only the original death
  })

  it('reconfigure() does nothing while stopped', async () => {
    const w = createWatcher()
    settings = makeSettings({ logPath: path.join(dir, 'Other.txt') })

    await w.reconfigure()

    expect(vi.getTimerCount()).toBe(0)
    expect(statuses).toEqual([])
    expect(w.running).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// replay() - the debug CLI path
// ---------------------------------------------------------------------------

describe('LogWatcher.replay', () => {
  it('reads from offset 0 and marks everything backlog', async () => {
    await fs.writeFile(logPath, `${GENERATING}\n${ENTERED}\n${SLAIN}\n${SPOOF}\n`)

    const w = createWatcher()
    const result = await w.replay(logPath)

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.linesRead).toBe(4)
    expect(result.eventsPublished).toBe(3)

    expect(types(events)).toEqual(['area-generated', 'zone-entered', 'death'])
    // EVERY event must be suppressible: a debug replay may not fire a single clip.
    expect(events.every((event) => event.backlog)).toBe(true)
    expect(selfDeaths.every((death) => death.backlog)).toBe(true)
    expect(unmatched).toHaveLength(1)
  })

  it('emits no watcher-status and does not start polling', async () => {
    const w = createWatcher()
    await w.replay(logPath)

    expect(statuses).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(w.running).toBe(false)
    expect(w.status.state).toBe('idle')
  })

  it('reports a missing file as data rather than throwing', async () => {
    const w = createWatcher()
    const result = await w.replay(path.join(dir, 'nope', 'Client.txt'))

    expect(result.status).toBe('file-missing')
    expect(result.linesRead).toBe(0)
    expect(result.error).toBeTypeOf('string')
    expect(events).toEqual([])
  })

  it('leaves a running tail untouched', async () => {
    const w = createWatcher()
    await w.start()
    const attached = w.status
    if (attached.state !== 'tailing') throw new Error('expected tailing')

    await w.replay(logPath)
    // Replay published the file's history as backlog...
    expect(events.every((event) => event.backlog)).toBe(true)
    const replayed = events.length

    // ...without disturbing the live cursor, which still only sees new bytes.
    await append(`${SLAIN}\n`)
    await poll()
    expect(events).toHaveLength(replayed + 1)
    expect(events.at(-1)?.backlog).toBe(false)
    const live = w.status
    if (live.state !== 'tailing') throw new Error('expected tailing')
    expect(live.since).toBe(attached.since)
    expect(live.linesRead).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Custom publisher
// ---------------------------------------------------------------------------

describe('LogWatcher publish override', () => {
  it('routes every parse result through the injected publisher instead of fanning out', async () => {
    const published: string[] = []
    const w = createWatcher({
      publish: (result) => published.push(result.type)
    })
    await w.start()

    await append(`${SLAIN}\n${SPOOF}\n`)
    await poll()

    expect(published).toEqual(['death', 'unmatched'])
    // The bus saw only status changes - fan-out was delegated entirely.
    expect(events).toEqual([])
    expect(deaths).toEqual([])
    expect(statuses.length).toBeGreaterThan(0)
  })

  it('contains a throwing publisher', async () => {
    const w = createWatcher({
      publish: () => {
        throw new Error('publisher exploded')
      }
    })
    await w.start()

    await append(`${SLAIN}\n`)
    await poll()

    expect(errors).toHaveLength(1)
    expect(w.status.state).toBe('tailing')
  })
})
