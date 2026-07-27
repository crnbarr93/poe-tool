/**
 * src/main/upload/upload-queue.ts
 * ==============================
 *
 * The clip -> Streamable pipeline. Listens for clips that have already been FILED,
 * uploads them one at a time, follows each one through Streamable's processing, and
 * reports every step as an {@link UploadOutcome} the config UI can render.
 *
 * NO `electron` IMPORT. The settings reader, the HTTP client, the filesystem and the
 * clock all arrive through the constructor, so the whole pipeline runs under plain
 * node and vitest with no network and no Electron.
 *
 *
 * THE LOCAL FILE IS THE ARTEFACT. THE UPLOAD IS A COURTESY
 * --------------------------------------------------------
 * Everything here is arranged so that an upload can never endanger, delay or replace
 * the clip on disk:
 *
 *  - It subscribes to a source that emits AFTER the move (`ReplayClipper`'s `clip`
 *    channel), never to `death:self`. Nothing in this file runs on the death path.
 *  - It re-checks {@link ClipRecord.moved} anyway. `moved: false` means there is no
 *    local file to upload - remote OBS, or a move that failed - and that is reported
 *    as a `skipped` outcome naming where the clip actually is, never as an attempt.
 *  - It only ever READS the clip file (a `stat` for the size, then the client streams
 *    it). Nothing here deletes, renames or rewrites a clip, on any path, ever.
 *  - Every failure is data. No public method throws or rejects; `handleClip` is called
 *    from inside an emit and a throw there would climb back into the clip pipeline.
 *
 *
 * WHY THE QUEUE IS SERIAL AND BOUNDED
 * -----------------------------------
 * One upload at a time, at most {@link DEFAULT_MAX_PENDING} waiting behind it.
 *
 * Deaths arrive in bursts - the reference Client.txt has 198 deaths on one character,
 * and a bad map is several deaths inside a minute. A clip is tens to hundreds of MB on
 * a domestic upstream, so running them concurrently would saturate the connection the
 * user is streaming on (the one thing this app must never do) and interleave progress
 * reporting into nonsense. So: one at a time.
 *
 * The bound is the other half of the same promise. An unbounded queue on a slow
 * upstream grows forever and every entry in it is a promise the app cannot keep. When
 * the queue is full the OLDEST WAITING clip is dropped, with a visible `skipped`
 * outcome that says where the file is - newer deaths are the ones the user is still
 * interested in, and the dropped clip is still on disk. Nothing is ever dropped
 * silently, and admission never blocks the caller.
 *
 *
 * NOTHING FAILS SILENTLY, INCLUDING "WE CHOSE NOT TO"
 * ---------------------------------------------------
 * Every clip that reaches {@link UploadQueue.handleClip} produces at least one
 * {@link ClipUploadUpdate} on the `upload` channel, and the last one is always terminal
 * (`done`, `skipped`, `failed` or `disabled`). The single exception is a clip that is
 * ALREADY in the queue - a duplicate emit is ignored precisely because its outcome is
 * already on its way. The four unhappy endings are deliberately distinct states because
 * they need different words in front of the user:
 *
 *   disabled  - uploading is switched off. Says WHY nothing happened instead of silence.
 *   skipped   - we deliberately did not upload this one (no local file, too big, no
 *               credentials, dropped from a full queue, or the app quit).
 *   failed    - we tried and could not (network, credentials rejected, a response we
 *               could not parse, processing that never finished).
 *   done      - it is live, and the URL is in the outcome.
 *
 * A `failed` OR `skipped` THAT HAPPENED AFTER A SUCCESSFUL UPLOAD STILL CARRIES THE LINK.
 * Transcoding outlasting the poll cap, and a quit landing mid-poll, are both endings where
 * the video is genuinely on Streamable and only our watching of it stopped. Those outcomes
 * carry `shortcode`/`url` as fields, and the sidecar is written the moment the upload is
 * accepted rather than when it turns ready - so neither the window nor the disk forgets a
 * video that exists. See {@link UploadQueue.#process}.
 *
 *
 * THIS FILE NEVER TOUCHES THE PASSWORD
 * ------------------------------------
 * The Streamable credential is an ACCOUNT email + password (Streamable has no revocable
 * upload token) and this repository is PUBLIC. The queue therefore reads exactly three
 * fields out of the settings - `enabled`, `autoUpload`, `maxFileBytes` - plus
 * `clips.writeSidecar`. It never reads `streamable.password` and never passes one
 * anywhere; the {@link UploadClient} holds the credential and answers a boolean,
 * {@link UploadClient.hasCredentials}, so this file can say "no account configured"
 * without ever having seen one. No message built here can leak a secret, because no
 * secret is in scope.
 *
 *
 * WHERE THE VENDOR ASSUMPTIONS LIVE - AND WHY NOT HERE
 * ----------------------------------------------------
 * Streamable's OFFICIAL API is read-only; its own docs say "video uploading, clipping,
 * or editing is not supported by the Streamable API at this time." Uploading uses an
 * UNDOCUMENTED endpoint. Every assumption about that - the URL, the auth scheme, the
 * multipart field name, the shape of the response, the numeric status codes, the public
 * URL format - lives in the STREAMABLE CLIENT module and nowhere else. That is the one
 * file to fix when the endpoint changes.
 *
 * {@link UploadClient} is declared HERE rather than imported from there for the same
 * reason `ClipperObsClient` is declared in `../obs/replay-clipper.ts`: this file is the
 * consumer, and it must be compilable and testable with a hand-written fake and no HTTP
 * module in the process at all. What crosses the boundary is deliberately vendor-free -
 * a shortcode, a URL, a readiness word and a typed error kind.
 */

import { readFile, stat, writeFile } from 'node:fs/promises'

import type { ClipRecord, ClipUploadUpdate, UploadOutcome } from '../../shared/ipc'
import type { AppSettings } from '../../shared/settings'
import { TypedEmitter } from '../events/typed-emitter'
import type { EventListener } from '../events/typed-emitter'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How many clips may WAIT behind the one being uploaded before the oldest is dropped.
 *
 * The in-flight upload is not counted, so 20 here means "21 clips in the system". Sized
 * for the realistic worst case: a burst of deaths in one bad map, on an upstream slow
 * enough that the first upload is still running. Beyond that the user is better served
 * by an honest "these were dropped" than by a queue that quietly falls an hour behind.
 */
export const DEFAULT_MAX_PENDING = 20

/**
 * Delays before each retry of a TRANSIENT upload failure, in ms. Length + 1 is the
 * attempt count, so this is 4 attempts spread over ~42s.
 *
 * Longer than `ClipLibrary`'s file-lock backoff on purpose: that one outwaits an
 * antivirus scan, this one outwaits a flaky connection or a rate limiter, and there is
 * nothing to be gained by hammering a third party quickly.
 */
export const DEFAULT_UPLOAD_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000]

/** Gap between two `GET /videos/{shortcode}` polls while Streamable transcodes. */
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 5_000

/**
 * Cap on those polls. 60 * 5s = 5 minutes, comfortably longer than a 30-60s replay
 * clip takes to transcode. Hitting the cap is a `failed` outcome that still names the
 * URL, because the video usually does appear eventually - we simply stop watching.
 */
export const DEFAULT_MAX_STATUS_POLLS = 60

/**
 * Upper bound on a server-supplied `Retry-After`. A rate limiter asking us to wait an
 * hour must not park a queue slot for an hour; we give up and say so instead.
 */
export const MAX_RETRY_AFTER_MS = 60_000

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** Wall clock, injected so outcome timestamps and tests do not need real time. */
export type Clock = () => number

/**
 * Abortable delay, injected so the retry/poll schedules are exercised in microseconds.
 *
 * MUST RESOLVE PROMPTLY WHEN `signal` ABORTS, and must not leave a timer behind - a
 * 30s backoff that kept the event loop alive would hold up `before-quit`. It resolves
 * rather than rejects on abort; the caller re-checks the signal afterwards.
 */
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>

/**
 * The slice of the clip pipeline this class subscribes to.
 *
 * Structural on purpose, exactly like `DeathEventSource` in `../obs/replay-clipper.ts`:
 * a `ReplayClipper`, a bare `TypedEmitter` and a hand-written stub all satisfy it.
 * Return types are `unknown` because `TypedEmitter` returns `this` while other emitters
 * return `void` or an unsubscribe function, and this class ignores all three.
 *
 * IT MUST BE A POST-MOVE CHANNEL. `ReplayClipper` emits `clip` only after the library
 * has finished with the file, which is what makes "upload only after the move" true by
 * construction rather than by hope.
 */
export interface ClipEventSource {
  on(channel: 'clip', listener: (record: ClipRecord) => void): unknown
  off(channel: 'clip', listener: (record: ClipRecord) => void): unknown
}

/**
 * The filesystem surface this class needs, as a swappable object. Mirrors
 * `ClipLibraryFs`; all members are plain function properties so a partial override
 * (`{ ...nodeUploadQueueFs, sizeOf: ... }`) is valid.
 *
 * DELIBERATELY READ-MOSTLY. The only write is the sidecar - never the clip.
 */
export interface UploadQueueFs {
  /** Size in bytes. Rejects if the file is missing; that becomes a `failed` outcome. */
  readonly sizeOf: (target: string) => Promise<number>
  /** Contents, or `null` when the file does not exist. Other errors reject. */
  readonly readTextFile: (target: string) => Promise<string | null>
  readonly writeTextFile: (target: string, contents: string) => Promise<void>
}

/** The real implementation, backed by `node:fs`. */
export const nodeUploadQueueFs: UploadQueueFs = {
  sizeOf: async (target) => (await stat(target)).size,
  readTextFile: async (target) => {
    try {
      return await readFile(target, 'utf8')
    } catch (error) {
      // "Not there" is an answer, not a failure: the sidecar is optional and may
      // legitimately never have been written.
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
  },
  writeTextFile: async (target, contents) => {
    await writeFile(target, contents, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// The client contract (see the file header for why it lives here)
// ---------------------------------------------------------------------------

/**
 * Why one upload or status request did not work.
 *
 * SPLIT BY WHETHER RETRYING COULD EVER HELP, because that is the only thing this file
 * does with it - see {@link TRANSIENT_UPLOAD_ERRORS}. Retrying a rejected password or
 * an oversized file is pure noise: it burns the user's upstream, delays every clip
 * behind it, and ends in the same message 40 seconds later.
 *
 * TRANSIENT: `network`, `timeout`, `rate-limited`, `server-error`.
 * PERMANENT: `auth-failed`, `file-too-large`, `file-unreadable`, `bad-response`,
 * `aborted`.
 *
 * `bad-response` is the one that matters for an UNDOCUMENTED endpoint: it means the
 * client got a reply and could not narrow it to something it understood. It is
 * permanent because a shape we cannot parse now is a shape we cannot parse in 30
 * seconds either - the fix is a code change in the client, and the message must be
 * loud enough that the user reports it.
 */
export type UploadErrorKind =
  | 'network'
  | 'timeout'
  | 'rate-limited'
  | 'server-error'
  | 'auth-failed'
  | 'file-too-large'
  | 'file-unreadable'
  | 'bad-response'
  | 'aborted'

/** The kinds that are worth trying again. Everything else fails on the first attempt. */
const TRANSIENT_UPLOAD_ERRORS: ReadonlySet<UploadErrorKind> = new Set<UploadErrorKind>([
  'network',
  'timeout',
  'rate-limited',
  'server-error'
])

/** True when trying `error` again could plausibly succeed. */
export function isTransientUploadError(error: UploadError): boolean {
  return TRANSIENT_UPLOAD_ERRORS.has(error.kind)
}

/** One typed failure from the client. Never carries a credential or a stack trace. */
export interface UploadError {
  readonly kind: UploadErrorKind
  /**
   * One human-readable sentence, safe to render verbatim and safe to log.
   *
   * MUST NOT CONTAIN THE ACCOUNT PASSWORD, or any header/body that might hold it. This
   * file concatenates it into user-facing text without inspecting it.
   */
  readonly message: string
  /**
   * Server-suggested delay before retrying (a `429`'s `Retry-After`), or `null`.
   * Honoured in preference to the backoff schedule when it is longer, clamped to
   * {@link MAX_RETRY_AFTER_MS}.
   */
  readonly retryAfterMs: number | null
}

/** Result union for client operations. Mirrors `ObsResult` in `../obs/obs-client.ts`. */
export type UploadClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UploadError }

/** What a successful upload yields. Both fields are minted by the client. */
export interface UploadedVideo {
  /** Streamable's short id, e.g. `"abc123"`. The only durable handle on the video. */
  readonly shortcode: string
  /**
   * The public URL, e.g. `https://streamable.com/abc123`.
   *
   * BUILT BY THE CLIENT, not here: the URL format is a vendor assumption and every
   * vendor assumption lives in that one module. This file treats it as an opaque string
   * and only checks that it is non-blank.
   */
  readonly url: string
}

/**
 * How far Streamable has got with a video, as reported by the OFFICIAL, documented
 * `GET /videos/{shortcode}`.
 *
 * The numeric status that endpoint actually returns (0 uploading, 1 processing,
 * 2 ready, 3 error) is mapped to these words INSIDE THE CLIENT, so a change to the
 * numbering is a one-file change and this loop keeps reading as English.
 */
export type VideoReadiness = 'uploading' | 'processing' | 'ready' | 'error'

/** One poll of the status endpoint. */
export interface VideoStatus {
  readonly readiness: VideoReadiness
  /** Whatever Streamable said about an `error` readiness, or `null`. Safe to render. */
  readonly message: string | null
}

/** Everything {@link UploadClient.upload} needs about one clip. */
export interface UploadRequest {
  /** Absolute path to the clip in the library. The client streams it; it never rewrites it. */
  readonly filePath: string
  /** Size in bytes, already measured and already checked against the configured limit. */
  readonly sizeBytes: number
  /** Aborted when poe-tool is shutting down. The client must stop promptly. */
  readonly signal: AbortSignal
}

/**
 * The slice of the Streamable client this class uses.
 *
 * Note what is NOT here: anything that hands a password across the boundary, and
 * anything that deletes a clip. The queue physically cannot leak the credential or lose
 * the artefact, which is the strongest available enforcement of both rules.
 *
 * NEITHER METHOD MAY REJECT. Failures come back as an {@link UploadError}. A client
 * that breaks that contract is caught anyway and reported as a `failed` outcome.
 */
export interface UploadClient {
  /**
   * True when a usable account email AND password are currently held.
   *
   * A BOOLEAN, NOT THE CREDENTIAL. This is how the queue explains "no Streamable
   * account is configured" without the secret ever being in its scope.
   */
  readonly hasCredentials: boolean
  /**
   * OPTIONAL: re-read the account credential from wherever the client got it.
   *
   * Called by {@link UploadQueue.reconfigure} after a settings save, so a newly typed
   * password is adopted without anything re-wiring the queue - and, because the client
   * reads it from the same store the settings were just written to, WITHOUT THE
   * PLAINTEXT TRAVELLING THROUGH THIS FILE. That is the point of the hook being here
   * rather than being a `setCredentials(email, password)`.
   *
   * Returns `void`: adopting a value the store already holds is synchronous, there is
   * no I/O to await, and this class would have nowhere to put a rejection. A client
   * with nothing to re-read simply omits it.
   */
  reconfigure?(): void
  /** Uploads one file via the UNOFFICIAL upload endpoint. Never rejects. */
  upload(request: UploadRequest): Promise<UploadClientResult<UploadedVideo>>
  /** Polls the OFFICIAL `GET /videos/{shortcode}`. Never rejects. */
  getVideoStatus(shortcode: string, signal: AbortSignal): Promise<UploadClientResult<VideoStatus>>
}

// ---------------------------------------------------------------------------
// Options + events
// ---------------------------------------------------------------------------

/** Constructor arguments. The three collaborators are required; the rest have defaults. */
export interface UploadQueueOptions {
  /** Where filed clips come from. Subscribed to by the constructor. */
  readonly clips: ClipEventSource
  /** The Streamable client. Holds the credential; this class never sees it. */
  readonly client: UploadClient
  /**
   * Current settings, read fresh on EVERY clip AND again immediately before each
   * upload starts. A user who switches uploading off while ten clips are queued has
   * switched it off for those ten too - see {@link UploadQueue.handleClip}.
   */
  readonly getSettings: () => AppSettings
  /** Swap the filesystem for a test double. Defaults to {@link nodeUploadQueueFs}. */
  readonly fs?: UploadQueueFs
  /** Defaults to `Date.now`. */
  readonly clock?: Clock
  /** Defaults to an abortable `setTimeout`. */
  readonly sleep?: SleepFn
  /** Waiting clips allowed before the oldest is dropped. Defaults to {@link DEFAULT_MAX_PENDING}. */
  readonly maxPending?: number
  /** Retry schedule for transient failures. Defaults to {@link DEFAULT_UPLOAD_RETRY_DELAYS_MS}. */
  readonly retryDelaysMs?: readonly number[]
  /** Defaults to {@link DEFAULT_STATUS_POLL_INTERVAL_MS}. */
  readonly statusPollIntervalMs?: number
  /** Defaults to {@link DEFAULT_MAX_STATUS_POLLS}. */
  readonly maxStatusPolls?: number
  /**
   * Called when a collaborator throws somewhere this class swallowed it, and when a
   * sidecar could not be updated (which has nowhere else to go - see
   * {@link UploadQueue}). Purely diagnostic; a hook that throws is itself ignored.
   */
  readonly onInternalError?: (error: unknown, context: string) => void
}

/**
 * Channels {@link UploadQueue} emits on.
 *
 * One channel, carrying exactly the payload of `IPC_PUSH.CLIP_UPLOAD`, so wiring is a
 * one-liner and the UI updates one row in place:
 *
 * ```ts
 * queue.on('upload', (update) => window.webContents.send(IPC_PUSH.CLIP_UPLOAD, update))
 * ```
 */
export interface UploadQueueEventMap {
  upload: [ClipUploadUpdate]
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** One admitted clip, frozen at admission. */
interface PendingUpload {
  readonly record: ClipRecord
  /** `record.finalPath`, already narrowed to a non-blank string. */
  readonly filePath: string
}

/** Node's `error.code` when there is one. Written against `unknown`, never cast. */
function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error
    return typeof code === 'string' ? code : null
  }
  return null
}

/** A message for any thrown value. TOTAL: never throws, for any input. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    const code = errorCode(error)
    return code === null ? error.message : `${code}: ${error.message}`
  }
  if (typeof error === 'string' && error.trim() !== '') return error.trim()
  return 'unknown error'
}

/** True for plain objects only - rejects `null` and arrays. Mirrors `shared/settings`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Human file size, 1024-based to match how OBS and Windows report sizes (and to match
 * `STREAMABLE_FREE_TIER_MAX_BYTES`, which is 250 * 1024 * 1024).
 *
 * TOTAL: a `NaN` or negative size from a hostile `stat` still produces a sentence.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size'
  if (bytes < 1024) return `${Math.round(bytes)} bytes`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/**
 * `"FyascoWorbinTime"` -> `"the clip of FyascoWorbinTime"`, `""` -> `"the clip"`.
 *
 * Mid-sentence form. Use {@link sentenceStart} at the front of a sentence rather than
 * `.toLowerCase()`/`.toUpperCase()` anywhere near this: the character name is inside
 * the string, and case-mangling a player's name in a message shown back to them is
 * exactly the sort of small wrongness that makes an app feel broken.
 */
function clipPhrase(characterName: string): string {
  const name = characterName.trim()
  return name === '' ? 'the clip' : `the clip of ${name}`
}

/** Capitalises the FIRST character only. Safe for a phrase that embeds a proper noun. */
function sentenceStart(phrase: string): string {
  return phrase === '' ? phrase : `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`
}

/**
 * The abortable delay used when none is injected.
 *
 * Clears the timer on abort and drops the abort listener when the timer wins, so
 * neither a pending backoff nor a long-lived {@link AbortController} accumulates
 * anything. That is what "no leaked timers" means in practice: after `dispose()` the
 * event loop has nothing of ours left in it.
 */
const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })

/**
 * Clamps an injected count to a usable integer >= min.
 *
 * The settings validator cannot help here - these are constructor options, not
 * persisted settings - and a `NaN` or negative `maxPending` must not turn into a queue
 * that drops everything or grows forever.
 */
function normalizeCount(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  return rounded < min ? min : rounded
}

/** Clamps a delay schedule: non-finite or negative entries become 0. */
function normalizeDelays(delays: readonly number[] | undefined): readonly number[] {
  if (delays === undefined) return DEFAULT_UPLOAD_RETRY_DELAYS_MS
  return delays.map((delay) => (Number.isFinite(delay) && delay > 0 ? delay : 0))
}

// ---------------------------------------------------------------------------
// UploadQueue
// ---------------------------------------------------------------------------

/**
 * Uploads filed clips to Streamable, one at a time.
 *
 * ```ts
 * const queue = new UploadQueue({
 *   clips: clipper,                       // ReplayClipper's `clip` channel
 *   client: streamable,
 *   getSettings: () => store.get()
 * })
 * queue.on('upload', (update) => window.webContents.send(IPC_PUSH.CLIP_UPLOAD, update))
 * // after a settings save:
 * queue.reconfigure()
 * // on quit:
 * await queue.dispose()
 * ```
 *
 * It satisfies `UploadPort` in `../ipc-handlers.ts` as-is, so it is handed to
 * `registerIpcHandlers` directly rather than through an adapter.
 *
 * THE CONSTRUCTOR SUBSCRIBES, matching `ReplayClipper`: there is no "and don't forget
 * to call start()" step. {@link stop} detaches and {@link start} re-attaches, both
 * idempotent.
 *
 * A SIDECAR THAT COULD NOT BE UPDATED IS REPORTED THROUGH
 * {@link UploadQueueOptions.onInternalError} AND NOWHERE ELSE. `UploadDone` carries no
 * note field, and a successful upload must not be downgraded to `failed` because a
 * 400-byte JSON file would not write - the video is live and the URL is in the outcome
 * either way. This mirrors `ClipLibrary`'s rule that a missing sidecar never downgrades
 * a successful move.
 */
export class UploadQueue {
  readonly #emitter = new TypedEmitter<UploadQueueEventMap>()
  readonly #clips: ClipEventSource
  readonly #client: UploadClient
  readonly #getSettings: () => AppSettings
  readonly #fs: UploadQueueFs
  readonly #clock: Clock
  readonly #sleep: SleepFn
  readonly #maxPending: number
  readonly #retryDelaysMs: readonly number[]
  readonly #statusPollIntervalMs: number
  readonly #maxStatusPolls: number
  readonly #onInternalError: (error: unknown, context: string) => void

  /** Stable identity, so `off` can actually find it again. */
  readonly #listener: (record: ClipRecord) => void

  /**
   * Aborted by {@link dispose}. Handed to every client call and every sleep, so a quit
   * during a 200 MB upload cancels the request instead of waiting for it.
   */
  readonly #abort = new AbortController()

  /** Clips waiting their turn, oldest first. Bounded by {@link #maxPending}. */
  readonly #pending: PendingUpload[] = []

  /** The clip currently being uploaded, or null. NOT counted against the bound. */
  #inFlight: PendingUpload | null = null

  #draining = false
  /** Tail of the drain loop. Never left in a rejected state. */
  #drain: Promise<void> = Promise.resolve()
  #subscribed = false
  #disposed = false

  constructor(options: UploadQueueOptions) {
    this.#clips = options.clips
    this.#client = options.client
    this.#getSettings = options.getSettings
    this.#fs = options.fs ?? nodeUploadQueueFs
    this.#clock = options.clock ?? Date.now
    this.#sleep = options.sleep ?? defaultSleep
    this.#maxPending = normalizeCount(options.maxPending, DEFAULT_MAX_PENDING, 1)
    this.#retryDelaysMs = normalizeDelays(options.retryDelaysMs)
    this.#statusPollIntervalMs = normalizeCount(
      options.statusPollIntervalMs,
      DEFAULT_STATUS_POLL_INTERVAL_MS,
      0
    )
    this.#maxStatusPolls = normalizeCount(options.maxStatusPolls, DEFAULT_MAX_STATUS_POLLS, 1)
    this.#onInternalError = options.onInternalError ?? ((): void => undefined)
    this.#listener = (record: ClipRecord): void => {
      this.handleClip(record)
    }
    this.start()
  }

  // -------------------------------------------------------------------------
  // Subscription + lifecycle
  // -------------------------------------------------------------------------

  /** Subscribes to the clip source. Called by the constructor; idempotent. */
  start(): this {
    if (this.#disposed || this.#subscribed) return this
    this.#subscribed = true
    this.#clips.on('clip', this.#listener)
    return this
  }

  /** Detaches from the clip source. Work already queued still runs. Idempotent. */
  stop(): this {
    if (!this.#subscribed) return this
    this.#subscribed = false
    this.#clips.off('clip', this.#listener)
    return this
  }

  /**
   * Permanent shutdown: detach, cancel the in-flight upload, drain the queue.
   *
   * ABORT FIRST, THEN DRAIN. The in-flight request is cancelled through
   * {@link AbortSignal} rather than waited out - a 200 MB upload on a domestic
   * connection would otherwise hold `before-quit` open for minutes. Everything still
   * waiting is then walked through the loop and reported as `skipped`, so a quit never
   * swallows an outcome the UI was expecting. The clips themselves are untouched on
   * disk; a cancelled upload costs nothing but the upload.
   *
   * NEVER REJECTS. Idempotent.
   */
  async dispose(): Promise<void> {
    this.stop()
    this.#disposed = true
    this.#abort.abort()
    await this.idle()
    this.#emitter.removeAllListeners()
  }

  /**
   * Adopt whatever moved in the settings. Called after every successful `settings:set`
   * (see `UploadPort` in `../ipc-handlers.ts`), unconditionally, so this compares and
   * mostly does nothing.
   *
   * WHAT NEEDS NO ACTION, AND WHY THAT IS MOST OF IT: `maxFileBytes`, `enabled` and
   * `autoUpload` are re-read on every admission AND again immediately before every
   * upload starts, so a queue that is simply left alone already behaves correctly. The
   * only reason this method exists at all is the two things that are NOT re-read here:
   * the credential, which lives in the client, and the backlog, which is worth telling
   * the user about immediately rather than one slow upload from now.
   *
   * THE IN-FLIGHT UPLOAD IS DELIBERATELY NOT CANCELLED. Its bytes are already on the
   * wire, cancelling wastes what has been sent, and the user changing a size cap did not
   * ask for that. Only shutdown cancels an upload in progress.
   *
   * NEVER THROWS.
   */
  reconfigure(): void {
    if (this.#disposed) return

    // 1. The credential, which this class deliberately cannot see. Nothing is passed;
    //    the client re-reads it from the store that was just written.
    try {
      this.#client.reconfigure?.()
    } catch (error) {
      this.#report(error, 'client-reconfigure')
    }

    // 2. The backlog. If uploading has just been switched off, every waiting clip is
    //    going to report `disabled` when the queue reaches it anyway - saying so NOW is
    //    the same answer, delivered while the user is still looking at the setting they
    //    just changed.
    let settings: AppSettings
    try {
      settings = this.#getSettings()
    } catch (error) {
      this.#report(error, 'get-settings')
      return
    }
    if (settings.streamable.enabled && settings.streamable.autoUpload) return

    for (const entry of this.#pending.splice(0)) {
      this.#emit(entry.record.id, { state: 'disabled' })
    }
  }

  /** True while attached to the clip source. */
  get running(): boolean {
    return this.#subscribed
  }

  /** Clips waiting for their turn. Excludes the one being uploaded. */
  get pendingCount(): number {
    return this.#pending.length
  }

  /** True while an upload is in flight. */
  get uploading(): boolean {
    return this.#inFlight !== null
  }

  /**
   * Resolves once the queue is empty and nothing is in flight.
   *
   * Exists for tests and for a clean shutdown; production code never needs it. Loops
   * because a listener could enqueue more work while we were awaiting the tail.
   *
   * NEVER REJECTS.
   */
  async idle(): Promise<void> {
    for (;;) {
      await this.#drain
      if (!this.#draining && this.#pending.length === 0) return
    }
  }

  /** Subscribes to a channel. Mirrors `TypedEmitter.on`. */
  on<K extends keyof UploadQueueEventMap>(
    channel: K,
    listener: EventListener<UploadQueueEventMap, K>
  ): this {
    this.#emitter.on(channel, listener)
    return this
  }

  /** Removes one registration of `listener`. Mirrors `TypedEmitter.off`. */
  off<K extends keyof UploadQueueEventMap>(
    channel: K,
    listener: EventListener<UploadQueueEventMap, K>
  ): this {
    this.#emitter.off(channel, listener)
    return this
  }

  // -------------------------------------------------------------------------
  // Admission (synchronous, on the clip pipeline's thread of control)
  // -------------------------------------------------------------------------

  /**
   * Decides whether `record` is a candidate for upload and, if so, queues it.
   *
   * Public so `src/main/index.ts` can drive the queue directly (a manual "upload this
   * one" button, a clip source whose shape does not match {@link ClipEventSource}) and
   * so tests can bypass the emitter.
   *
   * NEVER THROWS. It runs inside `TypedEmitter.emit` on the clip pipeline, and
   * `TypedEmitter` propagates listener exceptions to the emitter.
   *
   * ORDER OF THE CHECKS, WHICH IS NOT ARBITRARY:
   *
   *  1. DISABLED BEFORE EVERYTHING. If uploading is switched off, "uploading is off" is
   *     the complete and only honest explanation. Reporting `skipped: there is no local
   *     file` to a user who never asked for uploads would be noise about a decision
   *     they already made - and would hide the master switch behind an unrelated
   *     sentence when they went looking.
   *  2. THEN "IS THERE A FILE". `moved: false` is remote OBS or a failed move; either
   *     way there is nothing here to send, and the reason names where the clip is.
   *  3. THEN CREDENTIALS, because a missing account is about configuration rather than
   *     about this particular clip.
   *  4. ONLY THEN is a queue slot taken.
   *
   * The SIZE check is deliberately NOT here: it needs a `stat`, and admission runs
   * synchronously inside someone else's emit. It happens at the front of {@link #process}
   * instead, where it costs nothing.
   */
  handleClip(record: ClipRecord): void {
    try {
      if (this.#disposed) return

      // 1. Master switches. Read fresh; a throwing reader is fatal to THIS clip,
      //    because we cannot know whether the user even wants uploads.
      let settings: AppSettings
      try {
        settings = this.#getSettings()
      } catch (error) {
        this.#report(error, 'get-settings')
        this.#emit(record.id, {
          state: 'failed',
          message: `poe-tool could not read its settings, so ${clipPhrase(record.characterName)} was not uploaded to Streamable.`
        })
        return
      }
      if (!settings.streamable.enabled || !settings.streamable.autoUpload) {
        this.#emit(record.id, { state: 'disabled' })
        return
      }

      // 2. The local file. THE ONE RULE THIS CLASS EXISTS AROUND: no move, no upload.
      const filePath = record.finalPath === null ? '' : record.finalPath.trim()
      if (!record.moved || filePath === '') {
        this.#emit(record.id, {
          state: 'skipped',
          reason:
            `${sentenceStart(clipPhrase(record.characterName))} was not moved into the clips library, so poe-tool has ` +
            `no local file to upload. ${record.note ?? `The clip is at ${record.originalPath}.`} ` +
            'Upload it by hand if you want it on Streamable.'
        })
        return
      }

      // 3. An account. `hasCredentials` is a boolean, never the credential - see the
      //    file header.
      if (!this.#client.hasCredentials) {
        this.#emit(record.id, {
          state: 'skipped',
          reason:
            'No Streamable account is saved, so the clip was not uploaded. Add your Streamable ' +
            'email and password in Settings, or turn automatic uploads off to stop seeing this.'
        })
        return
      }

      // 4. Ignore a clip that is already in the system. A source that emits the same
      //    record twice must not cost the user two uploads and two Streamable videos;
      //    the outcome for it is already on its way. Bounded by construction - the scan
      //    covers at most `maxPending` + 1 entries.
      if (this.#isQueued(record.id)) return

      const entry: PendingUpload = { record, filePath }
      this.#pending.push(entry)
      this.#emit(record.id, { state: 'pending' })
      this.#evictOverflow()
      this.#kick()
    } catch (error) {
      // Belt and braces: every step above handles its own failures, so reaching here
      // means something genuinely unexpected. Still not allowed to escape.
      this.#report(error, 'handle-clip')
      this.#emit(record.id, {
        state: 'failed',
        message: `poe-tool could not queue ${clipPhrase(record.characterName)} for upload.`
      })
    }
  }

  /** True when this clip is already waiting or already uploading. */
  #isQueued(clipId: string): boolean {
    if (this.#inFlight?.record.id === clipId) return true
    return this.#pending.some((entry) => entry.record.id === clipId)
  }

  /**
   * Drops the OLDEST waiting clips until the queue is inside its bound, reporting each
   * one as a visible `skipped`.
   *
   * OLDEST RATHER THAN NEWEST because the newest death is the one the user is still
   * looking at, and because dropping the newest would make the queue a black hole
   * whenever it filled: every subsequent clip would be discarded while the stale head
   * of the queue crawled through a slow upstream.
   */
  #evictOverflow(): void {
    while (this.#pending.length > this.#maxPending) {
      const dropped = this.#pending.shift()
      if (dropped === undefined) return
      this.#emit(dropped.record.id, {
        state: 'skipped',
        reason:
          `poe-tool uploads one clip at a time and only keeps ${this.#maxPending} waiting, so this ` +
          'one was dropped to make room for newer deaths. The clip itself is safe at ' +
          `${dropped.filePath} - upload it by hand if you want it on Streamable.`
      })
    }
  }

  // -------------------------------------------------------------------------
  // Execution (asynchronous, serialised)
  // -------------------------------------------------------------------------

  /** Starts the drain loop if it is not already running. */
  #kick(): void {
    if (this.#draining) return
    this.#draining = true
    this.#drain = this.#drainLoop()
  }

  /**
   * Pulls clips off the queue one at a time until it is empty.
   *
   * This IS the serialisation: there is exactly one loop, it awaits each upload, and
   * {@link #kick} refuses to start a second one. A burst of deaths therefore produces a
   * burst of `pending` outcomes and one upload.
   *
   * NEVER REJECTS - the loop must survive a link failing, or one bad clip would strand
   * every clip behind it.
   */
  async #drainLoop(): Promise<void> {
    try {
      for (;;) {
        const next = this.#pending.shift()
        if (next === undefined) return
        this.#inFlight = next
        try {
          await this.#process(next)
        } catch (error) {
          // #process is written not to reject; this exists so that if it ever did, the
          // clip still gets a terminal outcome and the queue keeps moving.
          this.#report(error, 'upload-queue')
          this.#emit(next.record.id, {
            state: 'failed',
            message: `poe-tool could not finish uploading ${clipPhrase(next.record.characterName)} to Streamable.`
          })
        } finally {
          this.#inFlight = null
        }
      }
    } finally {
      this.#draining = false
    }
  }

  /**
   * Size-check, upload, follow the transcode, record the URL. One clip, start to
   * finish. NEVER REJECTS: every step converts its failure into an outcome.
   */
  async #process(entry: PendingUpload): Promise<void> {
    const { record, filePath } = entry
    const clipId = record.id

    // 0. Shutdown, or a queue that was already draining when dispose() landed. Reported
    //    rather than dropped: the UI is showing `pending` for this clip and would show
    //    it forever otherwise.
    if (this.#aborted) {
      this.#emitShutdownSkip(entry)
      return
    }

    // 1. Settings, RE-READ. The clip may have been queued minutes ago behind a slow
    //    upload, and a user who has switched uploading off in the meantime has switched
    //    it off for the backlog too. Everything below uses this one snapshot.
    let settings: AppSettings
    try {
      settings = this.#getSettings()
    } catch (error) {
      this.#report(error, 'get-settings')
      this.#emit(clipId, {
        state: 'failed',
        message: `poe-tool could not read its settings, so ${clipPhrase(record.characterName)} was not uploaded to Streamable.`
      })
      return
    }
    if (!settings.streamable.enabled || !settings.streamable.autoUpload) {
      this.#emit(clipId, { state: 'disabled' })
      return
    }
    if (!this.#client.hasCredentials) {
      this.#emit(clipId, {
        state: 'skipped',
        reason:
          'No Streamable account is saved, so the clip was not uploaded. Add your Streamable ' +
          'email and password in Settings, or turn automatic uploads off to stop seeing this.'
      })
      return
    }

    // 2. Size, BEFORE a single byte goes out. Streamable's free plan stops at 250 MB and
    //    a server-side rejection after a five-minute upload is the worst possible way to
    //    learn that.
    let sizeBytes: number
    try {
      sizeBytes = await this.#fs.sizeOf(filePath)
    } catch (error) {
      this.#emit(clipId, {
        state: 'failed',
        message:
          `poe-tool could not read ${filePath} to check its size (${describeError(error)}), so it ` +
          'was not uploaded to Streamable.'
      })
      return
    }
    if (!(sizeBytes > 0)) {
      this.#emit(clipId, {
        state: 'skipped',
        reason:
          `The clip file at ${filePath} is empty, so there was nothing to upload. Check that OBS ` +
          'finished writing the replay before it was moved.'
      })
      return
    }
    // `0` means "no local limit" - see `StreamableSettings.maxFileBytes`.
    const limit = settings.streamable.maxFileBytes
    if (limit > 0 && sizeBytes > limit) {
      this.#emit(clipId, {
        state: 'skipped',
        reason:
          `This clip is ${formatBytes(sizeBytes)} and the upload limit is set to ${formatBytes(limit)}, ` +
          "so it was not uploaded. Streamable's free plan stops at 250 MB - shorten the OBS replay " +
          'buffer or lower its bitrate, or raise the limit in Settings if your plan allows it. The ' +
          `clip is still at ${filePath}.`
      })
      return
    }

    // 3. Upload, retrying ONLY what could plausibly succeed on a second attempt.
    const video = await this.#upload(entry, sizeBytes)
    if (video === null) return

    // 4. Streamable has the file. The video exists at this URL from here on, but will
    //    not play until it has been transcoded.
    const uploadedAt = this.#now()
    this.#emit(clipId, { state: 'processing', shortcode: video.shortcode })

    // 5. DURABILITY THE MOMENT THERE IS SOMETHING DURABLE TO RECORD - which is HERE, not
    //    after `done`. The upload has already succeeded; everything below this line is
    //    poe-tool watching a transcode it does not control. Transcoding routinely outlasts
    //    the poll cap for a clip near the free plan's 250 MB ceiling, and a quit lands
    //    mid-poll all the time. Writing the sidecar only as a reward for reaching `done`
    //    meant every one of those cases threw away the shortcode of a video that is LIVE,
    //    leaving the user to go and find it on streamable.com by hand.
    //
    //    It is written again on `done` with the ready state; the timestamp is captured
    //    once, above, so both records agree on when the upload actually happened.
    if (settings.clips.writeSidecar) {
      await this.#persistUrl(entry, video, 'processing', uploadedAt)
    }

    const ready = await this.#awaitReady(entry, video)
    if (!ready) return

    this.#emit(clipId, { state: 'done', shortcode: video.shortcode, url: video.url })

    if (settings.clips.writeSidecar) {
      await this.#persistUrl(entry, video, 'ready', uploadedAt)
    }
  }

  /**
   * The upload attempt loop. Resolves with the video, or `null` when a terminal outcome
   * has already been emitted.
   */
  async #upload(entry: PendingUpload, sizeBytes: number): Promise<UploadedVideo | null> {
    const clipId = entry.record.id
    const attempts = this.#retryDelaysMs.length + 1

    for (let attempt = 1; ; attempt++) {
      // Emitted per attempt rather than once: `percent` is always null (one `fetch` of a
      // multipart body gives no progress callback), so this transition is the only sign
      // the UI has that a retry is under way.
      this.#emit(clipId, { state: 'uploading', percent: null })

      let result: UploadClientResult<UploadedVideo>
      try {
        result = await this.#client.upload({
          filePath: entry.filePath,
          sizeBytes,
          signal: this.#abort.signal
        })
      } catch (error) {
        // The client's contract says it never rejects. Treat a broken contract as a
        // permanent failure rather than retrying into it.
        this.#report(error, 'streamable-upload')
        this.#emit(clipId, {
          state: 'failed',
          message: `The Streamable upload failed unexpectedly: ${describeError(error)}`
        })
        return null
      }

      if (result.ok) {
        const shortcode = result.value.shortcode.trim()
        const url = result.value.url.trim()
        // Defensive narrowing of an UNDOCUMENTED endpoint's answer: without a shortcode
        // there is nothing to poll and nothing to link to, and without a URL there is
        // nothing to put on a clipboard. Both are reported as failures that name what we
        // did get, so a change at Streamable's end is visible rather than mysterious.
        if (shortcode === '') {
          this.#emit(clipId, {
            state: 'failed',
            message:
              'Streamable accepted the upload but did not return a video id, so poe-tool cannot ' +
              'link to it. The clip is still on disk; this usually means the upload endpoint has ' +
              'changed and poe-tool needs an update.'
          })
          return null
        }
        if (url === '') {
          this.#emit(clipId, {
            state: 'failed',
            message:
              `Streamable accepted the upload as ${shortcode} but did not return a link for it. ` +
              'The clip is still on disk; this usually means the upload endpoint has changed and ' +
              'poe-tool needs an update.'
          })
          return null
        }
        return { shortcode, url }
      }

      // Shutdown wins over any error the client reports on the way out.
      if (this.#aborted) {
        this.#emitShutdownSkip(entry)
        return null
      }

      const { error } = result
      if (!isTransientUploadError(error) || attempt >= attempts) {
        this.#emit(clipId, { state: 'failed', message: this.#failureMessage(error, attempt) })
        return null
      }

      await this.#sleepFor(this.#retryDelay(attempt, error.retryAfterMs))
      if (this.#aborted) {
        this.#emitShutdownSkip(entry)
        return null
      }
    }
  }

  /**
   * Polls the OFFICIAL status endpoint until the video is ready. Resolves `true` on
   * ready; on anything else it emits the terminal outcome itself and resolves `false`.
   */
  async #awaitReady(entry: PendingUpload, video: UploadedVideo): Promise<boolean> {
    const clipId = entry.record.id

    // Every unhappy ending BELOW THIS LINE happens to a clip that is already on
    // Streamable, so all of them carry the real link as data rather than only naming it in
    // prose. The one exception is a transcode Streamable itself failed - see that arm.
    const link = { shortcode: video.shortcode, url: video.url }

    for (let poll = 1; poll <= this.#maxStatusPolls; poll++) {
      // Sleep FIRST: transcoding has not finished in the microsecond since the upload
      // returned, and an immediate poll is a request that can only ever say "processing".
      await this.#sleepFor(this.#statusPollIntervalMs)
      if (this.#aborted) {
        this.#emit(clipId, {
          state: 'skipped',
          ...link,
          reason:
            'poe-tool closed while Streamable was still processing this clip, so it stopped ' +
            `watching. The video should still appear at ${video.url}.`
        })
        return false
      }

      let result: UploadClientResult<VideoStatus>
      try {
        result = await this.#client.getVideoStatus(video.shortcode, this.#abort.signal)
      } catch (error) {
        this.#report(error, 'streamable-status')
        this.#emit(clipId, {
          state: 'failed',
          ...link,
          message:
            `Streamable has the clip (${video.url}) but poe-tool could not check whether it had ` +
            `finished processing: ${describeError(error)}`
        })
        return false
      }

      if (!result.ok) {
        // A transient hiccup while polling is NOT an upload failure - the file is
        // already up there. Keep looking until the cap, then say so.
        if (isTransientUploadError(result.error)) continue
        this.#emit(clipId, {
          state: 'failed',
          ...link,
          message:
            `Streamable has the clip (${video.url}) but poe-tool could not check whether it had ` +
            `finished processing. ${result.error.message}`
        })
        return false
      }

      switch (result.value.readiness) {
        case 'ready':
          return true
        case 'error':
          // DELIBERATELY WITHOUT THE LINK. Streamable took the file and then failed to
          // turn it into a video, so that URL will never play; handing the UI something to
          // render as "here is your clip" would be a promise the page cannot keep. The
          // local file is the answer here, and the message names it.
          this.#emit(clipId, {
            state: 'failed',
            message:
              `Streamable could not process this clip.${result.value.message === null ? '' : ` ${result.value.message}`} ` +
              `The clip is untouched at ${entry.filePath}; try uploading it by hand.`
          })
          return false
        case 'uploading':
        case 'processing':
          continue
      }
    }

    // Not a lost clip and not necessarily a lost video - just the end of our patience. The
    // link goes out as DATA as well as prose: the upload succeeded, and the user should be
    // able to click or copy it rather than pick a URL out of a sentence.
    this.#emit(clipId, {
      state: 'failed',
      ...link,
      message:
        `Streamable was still processing this clip after ${this.#maxStatusPolls} checks, so poe-tool ` +
        `stopped watching. It may still finish on its own - check ${video.url}.`
    })
    return false
  }

  /**
   * Records the Streamable URL in the clip's `<clip>.json` sidecar, so the link
   * survives a restart.
   *
   * CALLED TWICE PER UPLOAD, and that is the design: once the moment Streamable accepts
   * the file (`state: 'processing'`) and again if it finishes transcoding while poe-tool
   * is still watching (`state: 'ready'`). The first call is the one that matters, because
   * it is the only one guaranteed to happen - see the note in {@link #process}. `state` is
   * what stops the record lying either way: a shortcode with no state would claim a
   * playable video for something that may still be transcoding.
   *
   * `uploadedAt` is passed IN rather than read from the clock here, so the second write
   * does not quietly restamp the record with the time the transcode finished. It means
   * one thing - when Streamable took the file - in both.
   *
   * MERGES, NEVER CLOBBERS. The sidecar is written by `ClipLibrary` and holds the zone,
   * character and timing metadata; this reads it back, adds one `streamable` object and
   * writes it out again in the same shape (2-space indent, trailing newline). A sidecar
   * that is missing is written fresh - a link is worth more than tidiness - but one that
   * exists and does NOT parse as a JSON object is LEFT ALONE, because overwriting a file
   * we do not understand could destroy something the user put there.
   *
   * NEVER REJECTS, and never changes the outcome. See the class header.
   */
  async #persistUrl(
    entry: PendingUpload,
    video: UploadedVideo,
    state: 'processing' | 'ready',
    uploadedAt: number
  ): Promise<void> {
    // Same convention `ClipLibrary` writes with. The two must agree; there is no shared
    // constant because the library owns the file and this only annotates it.
    const sidecarPath = `${entry.filePath}.json`
    const streamable = {
      shortcode: video.shortcode,
      url: video.url,
      state,
      uploadedAt,
      uploadedAtIso: toIso(uploadedAt)
    }

    try {
      const existing = await this.#fs.readTextFile(sidecarPath)
      if (existing === null) {
        await this.#fs.writeTextFile(sidecarPath, `${JSON.stringify({ streamable }, null, 2)}\n`)
        return
      }

      // Typed `unknown`, never `any`: a hand-edited or half-written sidecar must not be
      // able to smuggle a shape through.
      let parsed: unknown
      try {
        parsed = JSON.parse(existing)
      } catch (error) {
        this.#report(error, 'sidecar-parse')
        return
      }
      if (!isRecord(parsed)) {
        this.#report(new Error(`${sidecarPath} is not a JSON object`), 'sidecar-parse')
        return
      }

      const merged = { ...parsed, streamable }
      await this.#fs.writeTextFile(sidecarPath, `${JSON.stringify(merged, null, 2)}\n`)
    } catch (error) {
      this.#report(error, 'sidecar-write')
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * The sentence for a terminal upload failure. EXHAUSTIVE over {@link UploadErrorKind},
   * so a new kind is a compile error here rather than a generic message in production.
   *
   * `error.message` comes from the client and is documented as safe to render; nothing
   * in this file has a credential to add to it.
   */
  #failureMessage(error: UploadError, attempts: number): string {
    const tried = attempts > 1 ? ` (tried ${attempts} times)` : ''
    switch (error.kind) {
      case 'network':
        return `Could not reach Streamable${tried}. ${error.message} The clip is untouched on disk.`
      case 'timeout':
        return `The Streamable upload timed out${tried}. ${error.message} The clip is untouched on disk.`
      case 'rate-limited':
        return `Streamable is rate-limiting this account${tried}. ${error.message} Try again later; the clip is untouched on disk.`
      case 'server-error':
        return `Streamable had a server error${tried}. ${error.message} The clip is untouched on disk.`
      case 'auth-failed':
        // NOT retried: a rejected credential is rejected every time. Note the wording -
        // it names the field to fix without quoting anything the user typed.
        return (
          'Streamable rejected the saved account credentials, so the clip was not uploaded. ' +
          'Check the Streamable email and password in Settings - Streamable has no upload token, ' +
          `so it is your account password. ${error.message}`
        )
      case 'file-too-large':
        // NOT retried either: the file will not shrink.
        return `Streamable refused the clip because it is too large. ${error.message} The clip is untouched on disk.`
      case 'file-unreadable':
        return `poe-tool could not read the clip file to upload it. ${error.message}`
      case 'bad-response':
        return (
          `Streamable answered in a way poe-tool did not understand, so the upload was abandoned. ${error.message} ` +
          'The clip is untouched on disk. Streamable\'s upload endpoint is undocumented and may have ' +
          'changed - poe-tool probably needs an update.'
        )
      case 'aborted':
        return 'The upload was cancelled. The clip is untouched on disk.'
    }
  }

  /** The shared "we quit mid-flight" skip. */
  #emitShutdownSkip(entry: PendingUpload): void {
    this.#emit(entry.record.id, {
      state: 'skipped',
      reason:
        'poe-tool closed before this clip could be uploaded, so the upload was cancelled. The ' +
        `clip is safe at ${entry.filePath} - it will not be uploaded automatically next time.`
    })
  }

  // -------------------------------------------------------------------------
  // Small guarded helpers
  // -------------------------------------------------------------------------

  /** True once {@link dispose} has been called. */
  get #aborted(): boolean {
    return this.#abort.signal.aborted
  }

  /**
   * How long to wait before attempt `attempt + 1`.
   *
   * A server-supplied `Retry-After` WINS when it is longer than our own schedule -
   * arguing with a rate limiter just earns another 429 - but is clamped to
   * {@link MAX_RETRY_AFTER_MS} so a hostile or mistaken header cannot park a queue slot
   * indefinitely.
   */
  #retryDelay(attempt: number, retryAfterMs: number | null): number {
    // `?? 0` satisfies noUncheckedIndexedAccess; the index is in range by construction
    // (this is only reached while attempt <= retryDelaysMs.length).
    const scheduled = this.#retryDelaysMs[attempt - 1] ?? 0
    if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      return scheduled
    }
    return Math.min(Math.max(retryAfterMs, scheduled), MAX_RETRY_AFTER_MS)
  }

  /** The injected sleep, made total. A sleep that throws must not strand the queue. */
  async #sleepFor(ms: number): Promise<void> {
    if (ms <= 0) return
    try {
      await this.#sleep(ms, this.#abort.signal)
    } catch (error) {
      this.#report(error, 'sleep')
    }
  }

  /**
   * The injected clock, made total. A clock that throws or returns `NaN` must not be
   * able to poison a timestamp written into a sidecar.
   */
  #now(): number {
    try {
      const now = this.#clock()
      return Number.isFinite(now) ? now : Date.now()
    } catch (error) {
      this.#report(error, 'clock')
      return Date.now()
    }
  }

  /** Publishes one transition. A throwing subscriber must not break the pipeline. */
  #emit(clipId: string, upload: UploadOutcome): void {
    try {
      this.#emitter.emit('upload', { clipId, upload })
    } catch (error) {
      this.#report(error, 'upload-listener')
    }
  }

  /** Diagnostic hand-off. A hook that throws is itself swallowed. */
  #report(error: unknown, context: string): void {
    try {
      this.#onInternalError(error, context)
    } catch {
      // A logger must never be the thing that crashes the main process.
    }
  }
}

/** `Date#toISOString` throws on an out-of-range instant, so this stays defensive. */
function toIso(epochMs: number): string | null {
  const when = new Date(epochMs)
  if (Number.isNaN(when.getTime())) return null
  return when.toISOString()
}
