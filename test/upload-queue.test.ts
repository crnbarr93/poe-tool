/**
 * test/upload-queue.test.ts
 * =========================
 *
 * The clip -> Streamable pipeline, driven through a REAL
 * `TypedEmitter<ReplayClipperEventMap>` rather than a stand-in: `UploadQueue` claims to
 * be wireable straight onto `ReplayClipper`'s `clip` channel, and emitting on that exact
 * emitter is what actually proves it.
 *
 * Both collaborators that touch the outside world are hand-written stubs - no mocking
 * library, per the project constraints - and both are deliberately more than
 * call-counters:
 *
 *  - {@link FakeUploadClient} tracks CONCURRENT entries into `upload`, which is the only
 *    way to observe serialisation. A test that merely checked "all four uploaded" would
 *    pass just as happily with the queue deleted. It also parks on a real macrotask so
 *    an unserialised implementation would genuinely overlap, and it watches the
 *    {@link AbortSignal}, so "shutdown cancels the upload" is observed rather than
 *    assumed.
 *  - {@link FakeUploadFs} is a real in-memory filesystem, so the sidecar assertions read
 *    back the JSON that was actually written instead of counting write calls.
 *
 * The clock AND the sleep are injected, so the 42-second retry backoff and the
 * five-minute status-poll cap are both exercised in microseconds, and no test here is
 * timing-dependent.
 *
 * ONE FIXTURE IS LOAD-BEARING: the settings used everywhere carry a real-looking
 * password, and a test at the bottom asserts that no byte of it ever reaches an emitted
 * outcome. The repository is public and the Streamable credential is an account
 * password; that rule deserves an executable check rather than a comment.
 */

import { describe, expect, it } from 'vitest'

import type {
  ClipRecord,
  ClipUploadUpdate,
  UploadDone,
  UploadFailed,
  UploadOutcome,
  UploadSkipped
} from '../src/shared/ipc'
import {
  DEFAULT_SETTINGS,
  STREAMABLE_FREE_TIER_MAX_BYTES,
  type AppSettings,
  type ClipSettings,
  type StreamableSettings
} from '../src/shared/settings'
import { TypedEmitter } from '../src/main/events/typed-emitter'
// Type-only, so nothing here loads electron at runtime.
import type { UploadPort } from '../src/main/ipc-handlers'
import type { ReplayClipperEventMap } from '../src/main/obs/replay-clipper'
import {
  UploadQueue,
  type SleepFn,
  type UploadClient,
  type UploadClientResult,
  type UploadError,
  type UploadErrorKind,
  type UploadQueueFs,
  type UploadRequest,
  type UploadedVideo,
  type VideoReadiness,
  type VideoStatus
} from '../src/main/upload/upload-queue'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Deliberately distinctive: the last test in this file asserts that this string never
 * appears in anything the queue emits. See the file header.
 */
const ACCOUNT_PASSWORD = 'correct-horse-battery-staple-9137'

const MB = 1024 * 1024

let nextClipId = 0

/** A filed clip, i.e. one that reached the library. Override to break it. */
function clip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  nextClipId += 1
  const id = `clip-${nextClipId}`
  return {
    id,
    savedAt: 1_700_000_000_000,
    originalPath: `C:\\Users\\me\\Videos\\Replay-${nextClipId}.mkv`,
    finalPath: `/library/${id}.mkv`,
    zoneName: 'Karui Shores',
    areaId: '2_11_endgame_town',
    areaLevel: 69,
    characterName: 'FyascoWorbinTime',
    cause: 'slain',
    moved: true,
    note: null,
    upload: { state: 'pending' },
    ...overrides
  }
}

/** A clip the library could not move: the file is still where OBS wrote it. */
function unmovedClip(note: string): ClipRecord {
  return clip({ moved: false, finalPath: null, note })
}

function settings(
  streamable: Partial<StreamableSettings> = {},
  clips: Partial<ClipSettings> = {}
): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    clips: { ...DEFAULT_SETTINGS.clips, libraryDir: '/library', ...clips },
    streamable: {
      ...DEFAULT_SETTINGS.streamable,
      enabled: true,
      email: 'exile@example.com',
      password: ACCOUNT_PASSWORD,
      autoUpload: true,
      ...streamable
    }
  }
}

function uploadError(kind: UploadErrorKind, retryAfterMs: number | null = null): UploadError {
  return { kind, message: `simulated ${kind}.`, retryAfterMs }
}

function failWith(kind: UploadErrorKind, retryAfterMs: number | null = null): UploadClientResult<never> {
  return { ok: false, error: uploadError(kind, retryAfterMs) }
}

/** A macrotask boundary that also resolves early on abort - see {@link FakeUploadClient}. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(true)
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer)
      resolve(true)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Narrowing helpers - so an assertion on `.reason` is a compile-time fact
// ---------------------------------------------------------------------------

function asSkipped(outcome: UploadOutcome): UploadSkipped {
  if (outcome.state !== 'skipped') throw new Error(`expected skipped, got ${outcome.state}`)
  return outcome
}

function asFailed(outcome: UploadOutcome): UploadFailed {
  if (outcome.state !== 'failed') throw new Error(`expected failed, got ${outcome.state}`)
  return outcome
}

function asDone(outcome: UploadOutcome): UploadDone {
  if (outcome.state !== 'done') throw new Error(`expected done, got ${outcome.state}`)
  return outcome
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class FakeUploadClient implements UploadClient {
  hasCredentials = true

  /** How many times the queue asked the client to re-read its credential. */
  reconfigureCalls = 0
  throwOnReconfigure: Error | null = null

  reconfigure(): void {
    this.reconfigureCalls += 1
    if (this.throwOnReconfigure !== null) throw this.throwOnReconfigure
  }

  /** Paths handed to `upload`, in order. The serialisation evidence. */
  readonly uploadPaths: string[] = []
  /** Sizes handed alongside them, to prove the size really was measured first. */
  readonly uploadSizes: number[] = []

  /** Live count of concurrent `upload` bodies, and its high-water mark. */
  active = 0
  maxActive = 0
  /** Held across a real macrotask, so overlapping work would genuinely overlap. */
  uploadDelayMs = 0

  /** Scripted results, consumed in order; exhausting the script falls back to success. */
  readonly uploadScript: UploadClientResult<UploadedVideo>[] = []
  /** Simulates the client breaking its "never rejects" contract. */
  throwOnUpload: Error | null = null

  readonly statusCalls: string[] = []
  readonly statusScript: UploadClientResult<VideoStatus>[] = []
  defaultReadiness: VideoReadiness = 'ready'
  throwOnStatus: Error | null = null

  /** True once a call was still parked when the abort signal fired. */
  sawAbort = false

  async upload(request: UploadRequest): Promise<UploadClientResult<UploadedVideo>> {
    this.uploadPaths.push(request.filePath)
    this.uploadSizes.push(request.sizeBytes)
    const index = this.uploadPaths.length
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      if (await pause(this.uploadDelayMs, request.signal)) {
        this.sawAbort = true
        return failWith('aborted')
      }
      if (this.throwOnUpload !== null) throw this.throwOnUpload
      return (
        this.uploadScript.shift() ?? {
          ok: true,
          value: { shortcode: `code${index}`, url: `https://streamable.com/code${index}` }
        }
      )
    } finally {
      this.active -= 1
    }
  }

  async getVideoStatus(
    shortcode: string,
    signal: AbortSignal
  ): Promise<UploadClientResult<VideoStatus>> {
    this.statusCalls.push(shortcode)
    await Promise.resolve()
    if (signal.aborted) {
      this.sawAbort = true
      return failWith('aborted')
    }
    if (this.throwOnStatus !== null) throw this.throwOnStatus
    return (
      this.statusScript.shift() ?? {
        ok: true,
        value: { readiness: this.defaultReadiness, message: null }
      }
    )
  }
}

class FakeUploadFs implements UploadQueueFs {
  /** path -> contents. Doubles as the sidecar assertions' source of truth. */
  readonly files = new Map<string, string>()
  /** path -> size. Missing entries use {@link defaultSize}. */
  readonly sizes = new Map<string, number>()
  defaultSize = 8 * MB

  sizeError: Error | null = null
  writeError: Error | null = null

  readonly writes: string[] = []

  async sizeOf(target: string): Promise<number> {
    await Promise.resolve()
    if (this.sizeError !== null) throw this.sizeError
    return this.sizes.get(target) ?? this.defaultSize
  }

  async readTextFile(target: string): Promise<string | null> {
    await Promise.resolve()
    return this.files.get(target) ?? null
  }

  async writeTextFile(target: string, contents: string): Promise<void> {
    await Promise.resolve()
    if (this.writeError !== null) throw this.writeError
    this.writes.push(target)
    this.files.set(target, contents)
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly settings?: AppSettings
  readonly maxPending?: number
  readonly retryDelaysMs?: readonly number[]
  readonly statusPollIntervalMs?: number
  readonly maxStatusPolls?: number
}

interface Harness {
  readonly source: TypedEmitter<ReplayClipperEventMap>
  readonly client: FakeUploadClient
  readonly fs: FakeUploadFs
  readonly queue: UploadQueue
  readonly updates: ClipUploadUpdate[]
  readonly errors: { readonly error: unknown; readonly context: string }[]
  /** Every ms value passed to the injected sleep, in order. */
  readonly sleeps: number[]
  /** The injected clock's current reading. It advances by each simulated sleep. */
  readonly now: () => number
  /** The states reported for one clip, in order. */
  readonly states: (clipId: string) => string[]
  /** The last outcome reported for one clip. Throws if there was none. */
  readonly last: (clipId: string) => UploadOutcome
  readonly setSettings: (next: AppSettings) => void
  /** Emits on the real emitter WITHOUT waiting - for building bursts. */
  readonly emit: (record: ClipRecord) => void
  /** Emits and waits for the queue to go quiet. */
  readonly upload: (record: ClipRecord) => Promise<void>
}

function harness(options: HarnessOptions = {}): Harness {
  const source = new TypedEmitter<ReplayClipperEventMap>()
  const client = new FakeUploadClient()
  const fs = new FakeUploadFs()
  const updates: ClipUploadUpdate[] = []
  const errors: { error: unknown; context: string }[] = []
  const sleeps: number[] = []

  let now = 1_700_000_000_000
  let current = options.settings ?? settings()

  // Resolves immediately but still advances the injected clock, so a backoff schedule
  // and a poll cap are both fully exercised without a single real millisecond.
  const sleep: SleepFn = async (ms, signal) => {
    sleeps.push(ms)
    if (signal.aborted) return
    now += ms
    await Promise.resolve()
  }

  const queue = new UploadQueue({
    clips: source,
    client,
    fs,
    getSettings: () => current,
    clock: () => now,
    sleep,
    onInternalError: (error, context) => errors.push({ error, context }),
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
    ...(options.statusPollIntervalMs === undefined
      ? {}
      : { statusPollIntervalMs: options.statusPollIntervalMs }),
    ...(options.maxStatusPolls === undefined ? {} : { maxStatusPolls: options.maxStatusPolls })
  })
  queue.on('upload', (update) => updates.push(update))

  const forClip = (clipId: string): ClipUploadUpdate[] =>
    updates.filter((update) => update.clipId === clipId)

  return {
    source,
    client,
    fs,
    queue,
    updates,
    errors,
    sleeps,
    now: () => now,
    states: (clipId) => forClip(clipId).map((update) => update.upload.state),
    last: (clipId) => {
      const update = forClip(clipId).at(-1)
      if (update === undefined) throw new Error(`no outcome was emitted for ${clipId}`)
      return update.upload
    },
    setSettings: (next) => {
      current = next
    },
    emit: (record) => {
      source.emit('clip', record)
    },
    upload: async (record) => {
      source.emit('clip', record)
      await queue.idle()
    }
  }
}

// ---------------------------------------------------------------------------
// The local file comes first
// ---------------------------------------------------------------------------

describe('UploadQueue - the clip on disk comes first', () => {
  it('uploads a clip that was successfully moved into the library', async () => {
    const h = harness()
    const record = clip()

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([record.finalPath])
    expect(h.states(record.id)).toEqual(['pending', 'uploading', 'processing', 'done'])
    expect(asDone(h.last(record.id)).url).toBe('https://streamable.com/code1')
    expect(asDone(h.last(record.id)).shortcode).toBe('code1')
  })

  it('never uploads a clip whose move failed, and says where the file is', async () => {
    const h = harness()
    const record = unmovedClip(
      'Could not move the clip into /library: EBUSY: resource busy. The original file is untouched at C:\\Videos\\Replay.mkv.'
    )

    await h.upload(record)

    // The whole point: no local file, so no attempt - not even a size check.
    expect(h.client.uploadPaths).toEqual([])
    expect(h.states(record.id)).toEqual(['skipped'])
    const reason = asSkipped(h.last(record.id)).reason
    expect(reason).toContain('no local file to upload')
    expect(reason).toContain('EBUSY')
  })

  it('skips a clip that OBS wrote on another machine', async () => {
    const h = harness()
    const record = unmovedClip(
      "OBS is running on another machine, so the clip was saved to that machine's disk."
    )

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    expect(asSkipped(h.last(record.id)).reason).toContain('another machine')
  })

  it('treats a moved record with no final path as having no file, rather than uploading ""', async () => {
    // Cannot happen through ClipLibrary, which is exactly why it is checked: a record
    // arriving from anywhere else must not turn into `upload({ filePath: '' })`.
    const h = harness()
    const record = clip({ moved: true, finalPath: '   ' })

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    expect(h.states(record.id)).toEqual(['skipped'])
  })
})

// ---------------------------------------------------------------------------
// Master switches
// ---------------------------------------------------------------------------

describe('UploadQueue - the master switches', () => {
  it('emits disabled - not silence - when Streamable uploading is switched off', async () => {
    const h = harness({ settings: settings({ enabled: false }) })
    const record = clip()

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    expect(h.states(record.id)).toEqual(['disabled'])
  })

  it('emits disabled when the account is configured but auto-upload is off', async () => {
    const h = harness({ settings: settings({ autoUpload: false }) })
    const record = clip()

    await h.upload(record)

    expect(h.states(record.id)).toEqual(['disabled'])
  })

  it('reports disabled ahead of "no local file", because the switch explains everything', async () => {
    const h = harness({ settings: settings({ enabled: false }) })
    const record = unmovedClip('the move failed')

    await h.upload(record)

    expect(h.states(record.id)).toEqual(['disabled'])
  })

  it('honours uploading being switched off while a clip is already queued', async () => {
    const h = harness()
    const first = clip()
    const queued = clip()
    h.client.uploadDelayMs = 5

    h.emit(first) // takes the in-flight slot
    h.emit(queued) // admitted while uploading is still enabled
    h.setSettings(settings({ enabled: false })) // ...and switched off while it waits
    await h.queue.idle()

    expect(h.client.uploadPaths).toEqual([first.finalPath])
    expect(h.states(queued.id)).toEqual(['pending', 'disabled'])
  })

  it('skips with an actionable reason when no Streamable account is saved', async () => {
    const h = harness()
    h.client.hasCredentials = false
    const record = clip()

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    expect(asSkipped(h.last(record.id)).reason).toContain('Settings')
  })
})

// ---------------------------------------------------------------------------
// Serialisation and the bound
// ---------------------------------------------------------------------------

describe('UploadQueue - serialisation and the bound', () => {
  it('uploads a burst one at a time, in order', async () => {
    const h = harness()
    h.client.uploadDelayMs = 5
    const records = [clip(), clip(), clip(), clip(), clip()]

    for (const record of records) h.emit(record)
    await h.queue.idle()

    // The assertion that matters: never two uploads inside `upload` at once.
    expect(h.client.maxActive).toBe(1)
    expect(h.client.uploadPaths).toEqual(records.map((record) => record.finalPath))
    for (const record of records) {
      expect(h.states(record.id)).toEqual(['pending', 'uploading', 'processing', 'done'])
    }
  })

  it('drops the OLDEST waiting clip when the queue is full, visibly', async () => {
    const h = harness({ maxPending: 2 })
    h.client.uploadDelayMs = 5
    const inFlight = clip()
    const dropped = clip()
    const kept1 = clip()
    const kept2 = clip()

    h.emit(inFlight) // starts uploading immediately, so it does not occupy a slot
    h.emit(dropped) // waiting: 1
    h.emit(kept1) // waiting: 2
    h.emit(kept2) // waiting: 3 -> over the bound, oldest goes
    await h.queue.idle()

    expect(h.queue.pendingCount).toBe(0)
    // Dropped visibly, with the file's location, never silently.
    expect(h.states(dropped.id)).toEqual(['pending', 'skipped'])
    const reason = asSkipped(h.last(dropped.id)).reason
    expect(reason).toContain('dropped')
    expect(reason).toContain(dropped.finalPath ?? 'MISSING')
    // ...and the newer clips still went up.
    expect(h.client.uploadPaths).toEqual([inFlight.finalPath, kept1.finalPath, kept2.finalPath])
    expect(h.states(kept2.id).at(-1)).toBe('done')
  })

  it('keeps admission non-blocking and bounded under a 30-clip burst', async () => {
    // The reference log has 198 deaths on one character; bursts are real, and the queue
    // must neither grow without bound nor lose a clip without saying so.
    const h = harness({ maxPending: 5 })
    h.client.uploadDelayMs = 1
    const records = Array.from({ length: 30 }, () => clip())

    for (const record of records) {
      h.emit(record)
      expect(h.queue.pendingCount).toBeLessThanOrEqual(5)
    }
    await h.queue.idle()

    const terminal = records.map((record) => h.states(record.id).at(-1))
    // Every single clip reached a terminal state - none vanished.
    expect(terminal.every((state) => state === 'done' || state === 'skipped')).toBe(true)
    expect(terminal.filter((state) => state === 'done')).toHaveLength(h.client.uploadPaths.length)
    expect(h.client.maxActive).toBe(1)
  })

  it('ignores a clip that is already queued or in flight', async () => {
    const h = harness()
    h.client.uploadDelayMs = 5
    const record = clip()

    h.emit(record)
    h.emit(record) // a duplicate emit must not cost the user two Streamable videos
    await h.queue.idle()

    expect(h.client.uploadPaths).toEqual([record.finalPath])
    expect(h.states(record.id)).toEqual(['pending', 'uploading', 'processing', 'done'])
  })
})

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

describe('UploadQueue - the size check', () => {
  it('skips an oversized clip before sending a byte, naming the size and the limit', async () => {
    const h = harness()
    const record = clip()
    h.fs.sizes.set(record.finalPath ?? '', 300 * MB)

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    const reason = asSkipped(h.last(record.id)).reason
    expect(reason).toContain('300.0 MB')
    expect(reason).toContain('250.0 MB')
    expect(reason).toContain(record.finalPath ?? 'MISSING')
  })

  it('uploads a clip that is exactly at the limit', async () => {
    const h = harness()
    const record = clip()
    h.fs.sizes.set(record.finalPath ?? '', STREAMABLE_FREE_TIER_MAX_BYTES)

    await h.upload(record)

    expect(h.client.uploadSizes).toEqual([STREAMABLE_FREE_TIER_MAX_BYTES])
    expect(h.states(record.id).at(-1)).toBe('done')
  })

  it('treats maxFileBytes 0 as "no local limit" and lets Streamable decide', async () => {
    const h = harness({ settings: settings({ maxFileBytes: 0 }) })
    const record = clip()
    h.fs.sizes.set(record.finalPath ?? '', 4 * 1024 * MB)

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([record.finalPath])
  })

  it('fails - not skips - when the clip file cannot be measured', async () => {
    const h = harness()
    const record = clip()
    h.fs.sizeError = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    const message = asFailed(h.last(record.id)).message
    expect(message).toContain('ENOENT')
    expect(message).toContain(record.finalPath ?? 'MISSING')
  })

  it('skips an empty clip file rather than uploading zero bytes', async () => {
    const h = harness()
    const record = clip()
    h.fs.sizes.set(record.finalPath ?? '', 0)

    await h.upload(record)

    expect(h.client.uploadPaths).toEqual([])
    expect(asSkipped(h.last(record.id)).reason).toContain('empty')
  })
})

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

describe('UploadQueue - retrying only what can succeed', () => {
  it('retries a transient network failure and succeeds on the second attempt', async () => {
    const h = harness({ retryDelaysMs: [10, 20] })
    const record = clip()
    h.client.uploadScript.push(failWith('network'))

    await h.upload(record)

    expect(h.client.uploadPaths).toHaveLength(2)
    expect(h.sleeps).toContain(10)
    expect(h.states(record.id)).toEqual([
      'pending',
      'uploading',
      'uploading', // the retry is visible; `percent` is always null, so this is the only sign
      'processing',
      'done'
    ])
    expect(asDone(h.last(record.id)).url).toBe('https://streamable.com/code2')
  })

  it('gives up after the schedule is exhausted, and says how many times it tried', async () => {
    const h = harness({ retryDelaysMs: [10, 20] })
    const record = clip()
    h.client.uploadScript.push(failWith('timeout'), failWith('timeout'), failWith('timeout'))

    await h.upload(record)

    expect(h.client.uploadPaths).toHaveLength(3)
    expect(h.sleeps).toEqual([10, 20])
    expect(asFailed(h.last(record.id)).message).toContain('tried 3 times')
  })

  it('never retries a rejected credential, and points at the setting to fix', async () => {
    const h = harness({ retryDelaysMs: [10, 20] })
    const record = clip()
    h.client.uploadScript.push(failWith('auth-failed'))

    await h.upload(record)

    // One attempt. Retrying a wrong password just delays the same message.
    expect(h.client.uploadPaths).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    const message = asFailed(h.last(record.id)).message
    expect(message).toContain('Settings')
    expect(message).not.toContain('tried')
  })

  it('never retries a file Streamable called too large', async () => {
    const h = harness({ retryDelaysMs: [10, 20] })
    const record = clip()
    h.client.uploadScript.push(failWith('file-too-large'))

    await h.upload(record)

    expect(h.client.uploadPaths).toHaveLength(1)
    expect(asFailed(h.last(record.id)).message).toContain('too large')
  })

  it('never retries a response it could not parse, and blames the undocumented endpoint', async () => {
    const h = harness({ retryDelaysMs: [10, 20] })
    const record = clip()
    h.client.uploadScript.push(failWith('bad-response'))

    await h.upload(record)

    expect(h.client.uploadPaths).toHaveLength(1)
    expect(asFailed(h.last(record.id)).message).toContain('undocumented')
  })

  it('waits at least as long as a rate limiter asked, capped', async () => {
    const h = harness({ retryDelaysMs: [10, 20] })
    const record = clip()
    h.client.uploadScript.push(failWith('rate-limited', 5_000), failWith('rate-limited', 9_000_000))

    await h.upload(record)

    // The server's 5s wins over our 10ms; its 2.5 HOURS is clamped to a minute.
    // Only the first two sleeps are the backoff - the rest are status polls.
    expect(h.sleeps.slice(0, 2)).toEqual([5_000, 60_000])
    expect(h.states(record.id).at(-1)).toBe('done')
  })

  it('fails cleanly when the client breaks its "never rejects" contract', async () => {
    const h = harness({ retryDelaysMs: [10] })
    const record = clip()
    h.client.throwOnUpload = new Error('fetch exploded')

    await h.upload(record)

    // A broken contract is permanent, not something to retry into.
    expect(h.client.uploadPaths).toHaveLength(1)
    expect(asFailed(h.last(record.id)).message).toContain('fetch exploded')
    expect(h.errors.map((entry) => entry.context)).toContain('streamable-upload')
  })

  it('rejects a success that carries no shortcode', async () => {
    const h = harness()
    const record = clip()
    h.client.uploadScript.push({ ok: true, value: { shortcode: '  ', url: 'https://x/y' } })

    await h.upload(record)

    expect(h.client.statusCalls).toEqual([])
    expect(asFailed(h.last(record.id)).message).toContain('did not return a video id')
  })
})

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

describe('UploadQueue - following the transcode', () => {
  it('polls the official status endpoint until the video is ready', async () => {
    const h = harness({ statusPollIntervalMs: 100 })
    const record = clip()
    h.client.statusScript.push(
      { ok: true, value: { readiness: 'uploading', message: null } },
      { ok: true, value: { readiness: 'processing', message: null } },
      { ok: true, value: { readiness: 'ready', message: null } }
    )

    await h.upload(record)

    expect(h.client.statusCalls).toEqual(['code1', 'code1', 'code1'])
    expect(h.sleeps).toEqual([100, 100, 100])
    expect(h.states(record.id)).toEqual(['pending', 'uploading', 'processing', 'done'])
  })

  it('keeps polling through a transient status failure', async () => {
    const h = harness({ statusPollIntervalMs: 10 })
    const record = clip()
    h.client.statusScript.push(failWith('network'), {
      ok: true,
      value: { readiness: 'ready', message: null }
    })

    await h.upload(record)

    expect(h.client.statusCalls).toHaveLength(2)
    expect(h.states(record.id).at(-1)).toBe('done')
  })

  it('fails when Streamable says it could not process the video', async () => {
    const h = harness({ statusPollIntervalMs: 10 })
    const record = clip()
    h.client.statusScript.push({
      ok: true,
      value: { readiness: 'error', message: 'Unsupported codec.' }
    })

    await h.upload(record)

    const message = asFailed(h.last(record.id)).message
    expect(message).toContain('Unsupported codec.')
    expect(message).toContain(record.finalPath ?? 'MISSING')
  })

  it('stops watching after the poll cap, and still hands over the URL', async () => {
    const h = harness({ statusPollIntervalMs: 10, maxStatusPolls: 3 })
    const record = clip()
    h.client.defaultReadiness = 'processing'

    await h.upload(record)

    expect(h.client.statusCalls).toHaveLength(3)
    const message = asFailed(h.last(record.id)).message
    expect(message).toContain('https://streamable.com/code1')
    expect(h.states(record.id)).toEqual(['pending', 'uploading', 'processing', 'failed'])
  })

  it('does not let a status poll block the next clip in the queue', async () => {
    const h = harness({ statusPollIntervalMs: 10, maxStatusPolls: 2 })
    const first = clip()
    const second = clip()
    h.client.defaultReadiness = 'processing'

    h.emit(first)
    h.emit(second)
    await h.queue.idle()

    expect(h.client.uploadPaths).toEqual([first.finalPath, second.finalPath])
    expect(h.client.maxActive).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

describe('UploadQueue - persisting the link', () => {
  it('merges the Streamable URL into the existing sidecar', async () => {
    const h = harness()
    const record = clip()
    // Captured BEFORE the upload: `uploadedAt` means "when Streamable took the file", so
    // it must be the clock reading from before the status polls advanced it, not after.
    const acceptedAt = h.now()
    const sidecarPath = `${record.finalPath ?? ''}.json`
    h.fs.files.set(
      sidecarPath,
      `${JSON.stringify({ savedAt: record.savedAt, zoneName: 'Karui Shores' }, null, 2)}\n`
    )

    await h.upload(record)

    // The existing fields survive verbatim - this file belongs to ClipLibrary, and the
    // queue only annotates it.
    const written: unknown = JSON.parse(h.fs.files.get(sidecarPath) ?? '{}')
    expect(written).toEqual({
      savedAt: record.savedAt,
      zoneName: 'Karui Shores',
      streamable: {
        shortcode: 'code1',
        url: 'https://streamable.com/code1',
        // The record says which of the two things it is. A shortcode with no state would
        // claim a playable video for one that may still be transcoding.
        state: 'ready',
        uploadedAt: acceptedAt,
        uploadedAtIso: new Date(acceptedAt).toISOString()
      }
    })
    expect(h.now()).toBeGreaterThan(acceptedAt)
  })

  it('writes a fresh sidecar when there is none, rather than losing the link', async () => {
    const h = harness()
    const record = clip()
    const acceptedAt = h.now()

    await h.upload(record)

    const written: unknown = JSON.parse(h.fs.files.get(`${record.finalPath ?? ''}.json`) ?? '{}')
    expect(written).toEqual({
      streamable: {
        shortcode: 'code1',
        url: 'https://streamable.com/code1',
        state: 'ready',
        uploadedAt: acceptedAt,
        uploadedAtIso: new Date(acceptedAt).toISOString()
      }
    })
  })

  it('writes nothing when sidecars are switched off', async () => {
    const h = harness({ settings: settings({}, { writeSidecar: false }) })
    const record = clip()

    await h.upload(record)

    expect(h.fs.writes).toEqual([])
    expect(h.states(record.id).at(-1)).toBe('done')
  })

  it('leaves a sidecar it cannot parse completely alone', async () => {
    const h = harness()
    const record = clip()
    const sidecarPath = `${record.finalPath ?? ''}.json`
    h.fs.files.set(sidecarPath, 'this is not json, and may be something the user put here')

    await h.upload(record)

    expect(h.fs.files.get(sidecarPath)).toBe(
      'this is not json, and may be something the user put here'
    )
    expect(h.errors.map((entry) => entry.context)).toContain('sidecar-parse')
    // ...and the upload is still a success.
    expect(h.states(record.id).at(-1)).toBe('done')
  })

  it('never downgrades a successful upload because the sidecar would not write', async () => {
    const h = harness()
    const record = clip()
    h.fs.writeError = Object.assign(new Error('permission denied'), { code: 'EACCES' })

    await h.upload(record)

    expect(h.states(record.id)).toEqual(['pending', 'uploading', 'processing', 'done'])
    expect(h.errors.map((entry) => entry.context)).toContain('sidecar-write')
  })
})

// ---------------------------------------------------------------------------
// A successful upload is never forgotten
// ---------------------------------------------------------------------------

/**
 * THE REGRESSION THESE PIN, in one sentence: the upload succeeding and poe-tool reaching
 * `done` are two different events, and everything durable used to hang off the second one.
 *
 * A 250 MB clip - the free plan's own ceiling, which this feature is built around - can sit
 * in Streamable's transcode queue for longer than the default five-minute poll cap, and a
 * quit lands mid-poll routinely. Both used to end with NO `streamable` key in the sidecar
 * and no shortcode anywhere in the payload, for a video that was live at a URL nobody had
 * written down. The only artefact the whole feature produced was a sentence in a ring
 * buffer that a restart cleared.
 */
describe('UploadQueue - a video that exists is never lost', () => {
  it('writes the sidecar as soon as Streamable accepts the file, before any polling', async () => {
    const h = harness({ statusPollIntervalMs: 10, maxStatusPolls: 3 })
    const record = clip()
    const sidecarPath = `${record.finalPath ?? ''}.json`
    // The library's own metadata is already there and must survive both writes.
    h.fs.files.set(sidecarPath, `${JSON.stringify({ zoneName: 'Karui Shores' }, null, 2)}\n`)
    // Streamable never finishes: the poll cap is what ends this upload.
    h.client.defaultReadiness = 'processing'

    await h.upload(record)

    const written: unknown = JSON.parse(h.fs.files.get(sidecarPath) ?? '{}')
    expect(written).toEqual({
      zoneName: 'Karui Shores',
      streamable: {
        shortcode: 'code1',
        url: 'https://streamable.com/code1',
        // Not `ready`, because it genuinely is not - but recorded all the same.
        state: 'processing',
        uploadedAt: expect.any(Number),
        uploadedAtIso: expect.any(String)
      }
    })
  })

  it('hands the renderer a real link when the transcode outlasts the poll cap', async () => {
    const h = harness({ statusPollIntervalMs: 10, maxStatusPolls: 3 })
    const record = clip()
    h.client.defaultReadiness = 'processing'

    await h.upload(record)

    const failed = asFailed(h.last(record.id))
    // Prose AND data. The sentence has to read correctly on its own, but a paragraph is
    // not something the UI can hang a "copy link" button on.
    expect(failed.message).toContain('https://streamable.com/code1')
    expect(failed.shortcode).toBe('code1')
    expect(failed.url).toBe('https://streamable.com/code1')
  })

  it('hands over the link when the app quits while Streamable is still processing', async () => {
    const h = harness({ statusPollIntervalMs: 30_000 })
    const record = clip()
    h.client.defaultReadiness = 'processing'
    // Quit at the exact moment the queue announces `processing`, i.e. after Streamable has
    // taken the file and before the first status poll - which is where a real Cmd-Q or a
    // Windows shutdown lands during any transcode longer than a few seconds.
    h.queue.on('upload', (update) => {
      if (update.clipId === record.id && update.upload.state === 'processing') {
        void h.queue.dispose()
      }
    })

    await h.upload(record)

    const skipped = asSkipped(h.last(record.id))
    expect(skipped.reason).toContain('https://streamable.com/code1')
    expect(skipped.url).toBe('https://streamable.com/code1')
    expect(skipped.shortcode).toBe('code1')
    // The one that actually matters after a quit: the ring buffer holding that outcome is
    // in memory and the app is closing. The sidecar is what is still there tomorrow.
    const written: unknown = JSON.parse(h.fs.files.get(`${record.finalPath ?? ''}.json`) ?? '{}')
    expect(written).toEqual({
      streamable: {
        shortcode: 'code1',
        url: 'https://streamable.com/code1',
        state: 'processing',
        uploadedAt: expect.any(Number),
        uploadedAtIso: expect.any(String)
      }
    })
  })

  it('keeps the sidecar record when the status endpoint fails permanently', async () => {
    const h = harness({ statusPollIntervalMs: 10 })
    const record = clip()
    h.client.statusScript.push(failWith('bad-response'))

    await h.upload(record)

    const failed = asFailed(h.last(record.id))
    expect(failed.url).toBe('https://streamable.com/code1')
    const written: unknown = JSON.parse(h.fs.files.get(`${record.finalPath ?? ''}.json`) ?? '{}')
    expect(written).toEqual({
      streamable: {
        shortcode: 'code1',
        url: 'https://streamable.com/code1',
        state: 'processing',
        uploadedAt: expect.any(Number),
        uploadedAtIso: expect.any(String)
      }
    })
  })

  it('offers no link when Streamable itself says the video will never play', async () => {
    // The one deliberate omission. The upload worked, but the transcode failed, so that
    // URL is not a video - rendering it as one would be a promise the page cannot keep.
    const h = harness({ statusPollIntervalMs: 10 })
    const record = clip()
    h.client.statusScript.push({
      ok: true,
      value: { readiness: 'error', message: 'Unsupported codec.' }
    })

    await h.upload(record)

    const failed = asFailed(h.last(record.id))
    expect(failed.url).toBeUndefined()
    expect(failed.shortcode).toBeUndefined()
    // ...and the local file is what the user is pointed at instead.
    expect(failed.message).toContain(record.finalPath ?? 'MISSING')
  })

  it('carries no link on a failure that happened before anything was uploaded', async () => {
    const h = harness()
    const record = clip()
    h.client.uploadScript.push(failWith('auth-failed'))

    await h.upload(record)

    const failed = asFailed(h.last(record.id))
    expect(failed.url).toBeUndefined()
    expect(failed.shortcode).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe('UploadQueue - shutdown', () => {
  it('aborts the in-flight upload instead of waiting it out', async () => {
    const h = harness()
    const record = clip()
    // Far longer than the test could tolerate: if dispose() waited for it rather than
    // aborting it, this test would time out instead of failing.
    h.client.uploadDelayMs = 30_000

    h.emit(record)
    await h.queue.dispose()

    expect(h.client.sawAbort).toBe(true)
    expect(h.states(record.id)).toEqual(['pending', 'uploading', 'skipped'])
    const reason = asSkipped(h.last(record.id)).reason
    expect(reason).toContain('closed')
    expect(reason).toContain(record.finalPath ?? 'MISSING')
  })

  it('reports every still-waiting clip rather than dropping it silently', async () => {
    const h = harness()
    h.client.uploadDelayMs = 30_000
    const first = clip()
    const second = clip()
    const third = clip()

    h.emit(first)
    h.emit(second)
    h.emit(third)
    await h.queue.dispose()

    expect(h.queue.pendingCount).toBe(0)
    expect(h.queue.uploading).toBe(false)
    for (const record of [first, second, third]) {
      expect(h.states(record.id).at(-1)).toBe('skipped')
    }
    // Only the in-flight one was ever attempted.
    expect(h.client.uploadPaths).toEqual([first.finalPath])
  })

  it('stops listening, and ignores clips that arrive after disposal', async () => {
    const h = harness()
    await h.queue.dispose()

    expect(h.queue.running).toBe(false)
    h.emit(clip())
    await h.queue.idle()

    expect(h.client.uploadPaths).toEqual([])
  })

  it('is idempotent and never rejects', async () => {
    const h = harness()
    await h.upload(clip())

    await expect(h.queue.dispose()).resolves.toBeUndefined()
    await expect(h.queue.dispose()).resolves.toBeUndefined()
  })

  it('stops the abortable backoff instead of sitting out the delay', async () => {
    const h = harness({ retryDelaysMs: [30_000] })
    const record = clip()
    h.client.uploadScript.push(failWith('network'))

    h.emit(record)
    await h.queue.idle() // the retry sleep is the injected one, so this is instant
    await h.queue.dispose()

    // The retry happened (the fake sleep does not really wait), and the clip finished.
    expect(h.client.uploadPaths).toHaveLength(2)
    expect(h.states(record.id).at(-1)).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// reconfigure (the `UploadPort` the IPC layer wires this class in through)
// ---------------------------------------------------------------------------

describe('UploadQueue - reconfigure', () => {
  it('asks the client to re-read its credential, and passes it nothing', async () => {
    const h = harness()

    h.queue.reconfigure()

    expect(h.client.reconfigureCalls).toBe(1)
    // The signature is the proof: there is no argument for a password to travel in.
    expect(h.client.reconfigure.length).toBe(0)
    await h.upload(clip())
    expect(h.states(h.updates[0]?.clipId ?? '').at(-1)).toBe('done')
  })

  it('releases the backlog at once when uploading is switched off', async () => {
    const h = harness()
    h.client.uploadDelayMs = 5
    const inFlight = clip()
    const waiting1 = clip()
    const waiting2 = clip()

    h.emit(inFlight)
    h.emit(waiting1)
    h.emit(waiting2)
    h.setSettings(settings({ enabled: false }))
    h.queue.reconfigure()

    // Reported immediately, while the user is still looking at the setting they changed.
    expect(h.states(waiting1.id)).toEqual(['pending', 'disabled'])
    expect(h.states(waiting2.id)).toEqual(['pending', 'disabled'])
    expect(h.queue.pendingCount).toBe(0)

    await h.queue.idle()
    // ...and the upload that was already on the wire was NOT cancelled.
    expect(h.client.uploadPaths).toEqual([inFlight.finalPath])
    expect(h.states(inFlight.id).at(-1)).toBe('done')
  })

  it('leaves a backlog alone while uploading is still on', async () => {
    const h = harness()
    h.client.uploadDelayMs = 5
    const inFlight = clip()
    const waiting = clip()

    h.emit(inFlight)
    h.emit(waiting)
    h.queue.reconfigure()

    expect(h.queue.pendingCount).toBe(1)
    await h.queue.idle()
    expect(h.states(waiting.id).at(-1)).toBe('done')
  })

  it('satisfies the UploadPort the IPC layer wires it in through', () => {
    // A COMPILE-TIME PIN as much as a test: `src/main/index.ts` hands this class to
    // `registerIpcHandlers` as `deps.uploads`, and the assignment below is what makes a
    // drift in either shape a build failure rather than a runtime surprise.
    const h = harness()
    const port: UploadPort = h.queue

    expect(typeof port.reconfigure).toBe('function')
    expect(typeof port.on).toBe('function')
    expect(typeof port.off).toBe('function')
  })

  it('never throws, whatever the client or the settings reader does', () => {
    const h = harness()
    h.client.throwOnReconfigure = new Error('client exploded')
    h.setSettings(settings({ enabled: false }))

    expect(() => h.queue.reconfigure()).not.toThrow()
    expect(h.errors.map((entry) => entry.context)).toContain('client-reconfigure')
  })
})

// ---------------------------------------------------------------------------
// Robustness of the emit path
// ---------------------------------------------------------------------------

describe('UploadQueue - listener and collaborator robustness', () => {
  it('does not let a throwing listener break the pipeline', async () => {
    const h = harness()
    h.queue.on('upload', () => {
      throw new Error('listener exploded')
    })

    await h.upload(clip())
    const second = clip()
    await h.upload(second)

    expect(h.client.uploadPaths).toHaveLength(2)
    expect(h.states(second.id).at(-1)).toBe('done')
  })

  it('never throws out of the clip emit, whatever the settings reader does', async () => {
    const source = new TypedEmitter<ReplayClipperEventMap>()
    const client = new FakeUploadClient()
    const queue = new UploadQueue({
      clips: source,
      client,
      fs: new FakeUploadFs(),
      getSettings: () => {
        throw new Error('settings.json is on fire')
      }
    })
    const updates: ClipUploadUpdate[] = []
    queue.on('upload', (update) => updates.push(update))

    expect(() => source.emit('clip', clip())).not.toThrow()
    await queue.idle()

    expect(updates.map((update) => update.upload.state)).toEqual(['failed'])
    expect(client.uploadPaths).toEqual([])
    await queue.dispose()
  })

  it('survives a status client that breaks its contract', async () => {
    const h = harness({ statusPollIntervalMs: 10 })
    const record = clip()
    h.client.throwOnStatus = new Error('status exploded')

    await h.upload(record)

    expect(asFailed(h.last(record.id)).message).toContain('status exploded')
    expect(h.errors.map((entry) => entry.context)).toContain('streamable-status')
  })

  it('keeps working after one clip fails', async () => {
    const h = harness()
    const bad = clip()
    const good = clip()
    h.client.uploadScript.push(failWith('auth-failed'))

    await h.upload(bad)
    await h.upload(good)

    expect(h.states(bad.id).at(-1)).toBe('failed')
    expect(h.states(good.id).at(-1)).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// The password invariant
// ---------------------------------------------------------------------------

describe('UploadQueue - the account password', () => {
  it('never appears in anything the queue emits, on any path', async () => {
    // The repository is public and this credential is the Streamable ACCOUNT password;
    // the queue is not supposed to read it at all. This walks every terminal state and
    // checks the whole emitted stream, so a future message built from `settings` would
    // fail here rather than in a screenshot.
    const h = harness()

    h.client.uploadScript.push(failWith('auth-failed'))
    await h.upload(clip())

    const oversized = clip()
    h.fs.sizes.set(oversized.finalPath ?? '', 900 * MB)
    await h.upload(oversized)

    await h.upload(unmovedClip('the move failed'))

    h.client.hasCredentials = false
    await h.upload(clip())

    h.client.hasCredentials = true
    await h.upload(clip())

    expect(h.updates.length).toBeGreaterThan(5)
    expect(JSON.stringify(h.updates)).not.toContain(ACCOUNT_PASSWORD)
    expect(JSON.stringify(h.updates)).not.toContain('exile@example.com')
  })
})
