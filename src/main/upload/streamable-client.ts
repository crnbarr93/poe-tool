/**
 * src/main/upload/streamable-client.ts
 * ====================================
 *
 * THE ONLY MODULE IN poe-tool THAT KNOWS ANYTHING ABOUT STREAMABLE'S HTTP SURFACE.
 *
 * Every URL, every header, every field name, every status number and every assumption
 * about what Streamable answers with lives in this file. Nothing else in `src/**` may
 * mention `streamable.com`. When Streamable changes something, THIS IS THE ONE FILE TO
 * REPAIR - that is the entire reason it exists as a separate module.
 *
 * NO `electron` IMPORT. Credentials arrive as plain arguments; the settings store owns
 * where they came from and how they are encrypted at rest.
 *
 *
 * ============================================================================
 * READ THIS BEFORE "FIXING" ANYTHING HERE: POST /upload IS UNDOCUMENTED
 * ============================================================================
 *
 * Streamable's OFFICIAL, PUBLISHED API IS READ-ONLY. Their own documentation says, in
 * so many words:
 *
 *     "video uploading, clipping, or editing is not supported by the Streamable API
 *      at this time"
 *
 * and lists exactly two endpoints:
 *
 *     GET https://api.streamable.com/oembed.json{?url}
 *     GET https://api.streamable.com/videos/{shortcode}
 *
 * The upload path this file uses:
 *
 *     POST https://api.streamable.com/upload
 *     Authorization: Basic base64(email + ":" + password)
 *     multipart/form-data, the video under the "file" field
 *     answers with a JSON body containing at least a "shortcode"
 *
 * is NOT in those docs. It is an UNOFFICIAL, UNDOCUMENTED endpoint that third-party
 * wrappers have relied on for years, and it can change or vanish with no notice, no
 * deprecation window and no changelog. There is also NO REVOCABLE API TOKEN: the only
 * credential Streamable accepts here is the user's ACCOUNT EMAIL AND PASSWORD.
 *
 * THE USER WAS TOLD ALL OF THIS AND CHOSE TO PROCEED. Automatic upload of death clips
 * is off by default (`settings.streamable.enabled`), and the risk was accepted
 * knowingly. So the job here is not to avoid the unofficial endpoint - it is to make
 * its eventual breakage CHEAP AND OBVIOUS:
 *
 *   - Everything Streamable-specific is in this file, so the repair is local.
 *   - EVERY response is treated as `unknown` and narrowed with explicit runtime checks.
 *     Nothing is cast, nothing is `any`. A vendor change surfaces as a clean
 *     `unexpected-response` error carrying a snippet of what actually came back.
 *   - EVERY failure keeps that snippet, including the four statuses with a pinned meaning
 *     (401, 403, 413, 429). Those are exactly the ones a bot wall or a proxy is most
 *     likely to arrive as, so they are the last place that can afford to discard the
 *     evidence - see {@link describeHttpFailure}.
 *   - No method here throws. Failures are returned as data ({@link StreamableResult}),
 *     because the caller is an event-bus listener on the death path where a rejection
 *     would become an unhandled rejection in the main process.
 *
 * WARNING TO THE NEXT READER: do NOT "correct" this file by trusting the vendor docs.
 * If you read Streamable's API documentation, find no `/upload`, and conclude that this
 * code is wrong - you have rediscovered the sentence quoted above. The docs are
 * accurate AND the endpoint works; those two facts have coexisted for years. Deleting
 * the upload path because it is undocumented would remove the feature, not fix a bug.
 * Equally, do not "modernise" the auth to a bearer token: there is no token to use.
 *
 *
 * WHAT IS OFFICIAL HERE, AND WHY THE SPLIT MATTERS
 * ------------------------------------------------
 * {@link StreamableClient.awaitReady} polls `GET /videos/{shortcode}`, which IS in the
 * official docs and IS stable. Status is numeric there: 0 uploading, 1 processing,
 * 2 ready, 3 error. So the risky half of this file is exactly one request - the POST -
 * and the half that tells the user whether their clip is watchable is documented.
 * Keep it that way: if you need more information about a video, get it from the
 * documented endpoint.
 *
 *
 * FREE-PLAN LIMITS (checked before a byte is sent, where checkable)
 * -----------------------------------------------------------------
 *  - 250 MB per video -> {@link STREAMABLE_FREE_TIER_MAX_BYTES}, enforced locally so an
 *    oversized clip fails in a millisecond with a sentence the user can act on rather
 *    than after a ten-minute upload that the server then rejects.
 *  - 10 minutes per video - not checkable from a file, and a replay-buffer clip is
 *    30-60s, so it is not checked. It would surface as an upload failure.
 *  - 90-day retention - Streamable's business, not ours.
 *
 *
 * THE PASSWORD MUST NOT ESCAPE THIS FILE
 * ---------------------------------------
 * This repository is PUBLIC and the credential is a real account password. It is put
 * into exactly one place - an `Authorization: Basic` header - and every string this
 * module returns is run through {@link scrubSecrets} first, INCLUDING snippets of
 * response bodies (a hostile or merely careless error page can echo a request back).
 * There is no logging in this file at all, on purpose.
 */

import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { STREAMABLE_FREE_TIER_MAX_BYTES } from '../../shared/settings'

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * THE UNOFFICIAL ONE. See the file header before touching this.
 *
 * Not assembled from a base URL at call time: an endpoint this fragile should be one
 * greppable literal, so that "where does poe-tool upload to?" has a single answer.
 */
export const STREAMABLE_UPLOAD_URL = 'https://api.streamable.com/upload'

/**
 * The OFFICIAL, DOCUMENTED status endpoint. `${this}/${shortcode}` is a video.
 * Stable, and the only thing {@link StreamableClient.awaitReady} depends on.
 */
export const STREAMABLE_VIDEO_API_BASE = 'https://api.streamable.com/videos'

/** Where a human watches the video. `${this}/${shortcode}`. */
export const STREAMABLE_VIDEO_PAGE_BASE = 'https://streamable.com'

/**
 * Streamable's numeric video status, from the official docs for
 * `GET /videos/{shortcode}`.
 *
 * Numeric rather than a string enum because that is what the API sends. Anything
 * outside 0-3 is treated as "not a status we understand" - see {@link parseVideoStatus}.
 */
export const STREAMABLE_STATUS = Object.freeze({
  UPLOADING: 0,
  PROCESSING: 1,
  READY: 2,
  ERROR: 3
})

/**
 * Characters a shortcode may contain.
 *
 * Enforced on BOTH directions - the one we are handed and the one Streamable returns -
 * because a shortcode goes straight into a URL path. A value containing `../` or a
 * query separator would turn a status poll into a request for something else entirely,
 * and the response is undocumented enough already without adding "we asked the wrong
 * question" to the list of possibilities.
 */
const SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// ---------------------------------------------------------------------------
// Timing defaults
// ---------------------------------------------------------------------------

/**
 * Backstop on a single upload. Generous because a 250 MB clip on a domestic upstream
 * link genuinely takes tens of minutes; this exists so a wedged socket cannot leave an
 * upload pending for the life of the process, not to police slow connections.
 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 30 * 60_000

/** Cap on one small request (a status poll, a credential check). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Total time {@link StreamableClient.awaitReady} will wait for `status === 2`. */
export const DEFAULT_MAX_WAIT_MS = 5 * 60_000

/** First gap between status polls. Subsequent gaps back off - see {@link pollDelayMs}. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000

/** Ceiling on the poll gap, so a long transcode still gets checked twice a minute. */
export const DEFAULT_POLL_MAX_DELAY_MS = 10_000

/** Growth factor of the poll gap. */
const POLL_BACKOFF_FACTOR = 1.5

/**
 * Gap before poll number `attempt` (1-based), capped exponential.
 *
 * Backing off matters because a 10-minute transcode polled every 2s is 300 requests to
 * a third party for one clip, which is how an app earns a rate limit.
 *
 * PURE and TOTAL: never throws, always returns a finite integer in
 * `[0, maxDelayMs]`, for any input including `NaN`, `Infinity` and negatives.
 */
export function pollDelayMs(
  attempt: number,
  baseMs: number = DEFAULT_POLL_INTERVAL_MS,
  maxDelayMs: number = DEFAULT_POLL_MAX_DELAY_MS
): number {
  const max = Number.isFinite(maxDelayMs) ? Math.max(0, maxDelayMs) : DEFAULT_POLL_MAX_DELAY_MS
  const base = Number.isFinite(baseMs) ? Math.max(0, baseMs) : DEFAULT_POLL_INTERVAL_MS
  if (!Number.isFinite(attempt) || attempt <= 1) return Math.round(Math.min(base, max))
  const raw = base * POLL_BACKOFF_FACTOR ** (Math.floor(attempt) - 1)
  if (!Number.isFinite(raw)) return Math.round(max)
  return Math.round(Math.min(raw, max))
}

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

/** How much of a response body is quoted back in an error. Enough to identify it. */
const BODY_SNIPPET_MAX = 200

/**
 * Replaces every occurrence of every secret with `***`.
 *
 * Applied to EVERY string this module returns, including response-body snippets. That
 * is not paranoia about our own code - it is about theirs: an error page, a proxy, or a
 * captive portal can echo a request (headers and all) back in its body, and that body
 * ends up in an error message which ends up in an IPC payload in a renderer in a public
 * repository's screenshots.
 *
 * PURE and TOTAL: never throws. Empty secrets are ignored (otherwise every string would
 * become `***`). Uses `split`/`join` rather than a RegExp so a password containing
 * regex metacharacters is matched literally.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret === '') continue
    if (!out.includes(secret)) continue
    out = out.split(secret).join('***')
  }
  return out
}

/**
 * A short, single-line, secret-free excerpt of a response body, for an error message.
 *
 * Whitespace is collapsed because the most common unexpected body is an HTML error page
 * whose raw newlines would otherwise be pasted into a UI label.
 *
 * PURE and TOTAL: never throws.
 */
export function bodySnippet(body: string, secrets: readonly string[]): string {
  const collapsed = scrubSecrets(body, secrets).replace(/\s+/g, ' ').trim()
  if (collapsed.length <= BODY_SNIPPET_MAX) return collapsed
  return `${collapsed.slice(0, BODY_SNIPPET_MAX)}...`
}

/**
 * The `Authorization` header value for Streamable's HTTP Basic auth.
 *
 * `base64(email + ":" + password)`, UTF-8 encoded before base64 - RFC 7617 leaves the
 * charset up to the server, and UTF-8 is what every modern stack assumes. A password
 * containing a colon is fine (only the FIRST colon separates the two fields); an EMAIL
 * containing one is not, but an email cannot contain a colon.
 *
 * PURE and TOTAL: never throws.
 *
 * THE RETURN VALUE CONTAINS THE PASSWORD IN A TRIVIALLY REVERSIBLE ENCODING. It goes
 * into a request header and nowhere else - never into a message, a log or an IPC
 * payload. {@link scrubSecrets} is also given this string so that an echoed request
 * cannot leak it back out.
 */
export function buildAuthorizationHeader(email: string, password: string): string {
  return `Basic ${encodeBasicCredential(email, password)}`
}

/** The base64 half of {@link buildAuthorizationHeader}, without the `Basic ` prefix. */
function encodeBasicCredential(email: string, password: string): string {
  return Buffer.from(`${email}:${password}`, 'utf8').toString('base64')
}

/**
 * Every string that must never survive into a message: the password itself, its base64
 * credential, and the whole header value.
 *
 * All three, because an echoed request can leak any of them: a proxy quotes the header
 * line verbatim, a JSON error quotes just the token, and a naive server quotes the
 * decoded password. Built in ONE place so no call site can forget one of the forms.
 *
 * PURE and TOTAL: never throws.
 */
export function credentialSecrets(email: string, password: string): readonly string[] {
  if (password === '') return []
  const token = encodeBasicCredential(email, password)
  return [password, token, `Basic ${token}`]
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Streamable rejected the account email and password (HTTP 401/403), or none were
 * configured, in which case `status` is null because nothing was ever sent.
 *
 * READ {@link bodySnippet} BEFORE BELIEVING THE NAME OF THIS ERROR. 401 and 403 are also
 * exactly what a bot wall, a WAF, a captive portal or a corporate proxy answers, and on an
 * UNDOCUMENTED endpoint that is at least as likely as a wrong password. The status mapping
 * stays as it is - it is the pinned contract, and "your credentials did not get you in" is
 * still the honest summary - but the evidence travels with it now instead of being thrown
 * away, and {@link message} says so out loud when the body does not even look like a
 * rejection Streamable would write.
 */
export interface StreamableAuthFailedError {
  readonly kind: 'auth-failed'
  readonly message: string
  /** HTTP status that produced this, or null when we never made the request. */
  readonly status: number | null
  /**
   * Short, whitespace-collapsed, secret-scrubbed excerpt of the response body, or `''`
   * when there was no body (or no request).
   *
   * THE WHOLE DIAGNOSTIC VALUE OF A 403 IS IN HERE. Without it, a Cloudflare block page
   * and a genuinely wrong password produce the same sentence, and the user re-types a
   * password that was never the problem with nothing to report to anyone.
   */
  readonly bodySnippet: string
}

/**
 * The clip is bigger than the configured limit (default: the free plan's 250 MB).
 *
 * Normally decided LOCALLY, before a single byte is sent. Also produced by HTTP 413,
 * in which case `limitBytes` is null - the server did not tell us its limit.
 */
export interface StreamableFileTooLargeError {
  readonly kind: 'file-too-large'
  readonly message: string
  readonly sizeBytes: number
  readonly limitBytes: number | null
  /**
   * Excerpt of the 413's body, or `''` when the refusal was decided locally and nothing
   * was ever sent. Same reasoning as {@link StreamableAuthFailedError.bodySnippet}: 413 is
   * a plausible thing for an intermediary to say too.
   */
  readonly bodySnippet: string
}

/**
 * The clip could not be read from THIS machine's disk. Streamable was never contacted.
 *
 * NOT ONE OF THE NETWORK FAILURE KINDS, DELIBERATELY. The clip having been deleted,
 * moved, or left on a remote OBS host is a local problem with a local fix, and telling
 * that user to "check your connection" (which is what folding it into `network` would
 * do) sends them to debug the wrong thing entirely.
 */
export interface StreamableFileUnreadableError {
  readonly kind: 'file-unreadable'
  readonly message: string
  readonly filePath: string
}

/** The request never completed: DNS, TCP, TLS, a dropped connection, no internet. */
export interface StreamableNetworkError {
  readonly kind: 'network'
  readonly message: string
}

/** HTTP 429. Streamable is throttling us. */
export interface StreamableRateLimitedError {
  readonly kind: 'rate-limited'
  readonly message: string
  /** From `Retry-After`, in ms, when it was an integer number of seconds. Else null. */
  readonly retryAfterMs: number | null
  /**
   * Excerpt of the body. Kept for the same reason as on the other pinned statuses: a 429
   * from a CDN in front of Streamable and a 429 from Streamable itself want different
   * responses from whoever is reading the report.
   */
  readonly bodySnippet: string
}

/**
 * STREAMABLE ANSWERED WITH SOMETHING WE DO NOT RECOGNISE.
 *
 * The single most important error in this file: it is what a breaking change to the
 * unofficial endpoint looks like from the outside. Not a `TypeError` deep in the app,
 * not `undefined` propagating into a URL - a specific, visible failure that names the
 * file to go and fix.
 */
export interface StreamableUnexpectedResponseError {
  readonly kind: 'unexpected-response'
  readonly message: string
  /** HTTP status, or null when the failure was in parsing rather than in the status. */
  readonly status: number | null
  /** Short, whitespace-collapsed, secret-scrubbed excerpt of what came back. */
  readonly bodySnippet: string
}

/**
 * Streamable took the video and its own transcode failed (`status === 3`). Terminal:
 * re-uploading the same file is the only remedy, and it is the user's call.
 */
export interface StreamableProcessingFailedError {
  readonly kind: 'processing-failed'
  readonly message: string
  readonly shortcode: string
}

/** We gave up waiting - for the request itself, or for processing to finish. */
export interface StreamableTimeoutError {
  readonly kind: 'timeout'
  readonly message: string
  readonly waitedMs: number
  /**
   * Set when the video EXISTS but was still processing when we stopped watching.
   * The upload was not lost - only our patience was - so a caller can still show the
   * link. Null when there is no video to point at.
   */
  readonly shortcode: string | null
}

/** The caller's `AbortSignal` fired: the app is quitting, or the user cancelled. */
export interface StreamableAbortedError {
  readonly kind: 'aborted'
  readonly message: string
}

/**
 * Everything a {@link StreamableClient} operation can fail with. Switch on `kind`.
 *
 * `message` is ALWAYS human-readable, always safe to render verbatim, and NEVER
 * contains the password or its base64 encoding - see {@link scrubSecrets}.
 */
export type StreamableError =
  | StreamableAuthFailedError
  | StreamableFileTooLargeError
  | StreamableFileUnreadableError
  | StreamableNetworkError
  | StreamableRateLimitedError
  | StreamableUnexpectedResponseError
  | StreamableProcessingFailedError
  | StreamableTimeoutError
  | StreamableAbortedError

/** Discriminant of {@link StreamableError}. */
export type StreamableErrorKind = StreamableError['kind']

/**
 * Result union for every operation here.
 *
 * A result rather than a rejection, for the same reason `ObsResult` is one: uploading
 * happens on the death path, inside an event-bus listener, where a rejection becomes an
 * unhandled rejection in the main process.
 */
export type StreamableResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StreamableError }

// ---------------------------------------------------------------------------
// Injected HTTP
// ---------------------------------------------------------------------------

/**
 * The part of a `Response` this module reads.
 *
 * Structural, and deliberately tiny, for two reasons: the real global `Response`
 * satisfies it unchanged, and the test suite can build one in four lines and stay
 * OFFLINE. A test that needed a real HTTP server to prove "an HTML error page does not
 * crash the uploader" would not get written.
 *
 * NOTE THE ABSENCE OF `json()`. Undici types it as `Promise<any>`, and this project
 * forbids `any`; more importantly, parsing has to be OUR failure to handle, not a
 * rejection from someone else's parser. So: `text()`, then `JSON.parse` into `unknown`.
 */
export interface StreamableHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** The request shape {@link FetchLike} receives. */
export interface StreamableHttpRequest {
  readonly method: 'GET' | 'POST'
  /** Always includes `Authorization`; never logged. */
  readonly headers: Readonly<Record<string, string>>
  /** The multipart body, or null for a GET. */
  readonly body: FormData | null
  /** Always present. Fires on caller abort AND on this module's own timeout. */
  readonly signal: AbortSignal
}

/**
 * The HTTP transport. Defaults to the platform `fetch`; injected by tests.
 *
 * A TEST SEAM, NOT A PRODUCTION KNOB. There is no proxy support hiding behind it - if
 * that is ever needed it belongs in the default implementation, not in every caller.
 */
export type FetchLike = (url: string, request: StreamableHttpRequest) => Promise<StreamableHttpResponse>

/** Electron 43 ships Node 20+, so `fetch`, `FormData` and `Blob` are all global. */
const platformFetch: FetchLike = async (url, request) => {
  // Two call shapes rather than one object with `body: undefined`, because the project
  // compiles with `exactOptionalPropertyTypes` and a GET with a null body is a
  // different request from a POST with an empty one.
  if (request.body === null) {
    return fetch(url, { method: request.method, headers: { ...request.headers }, signal: request.signal })
  }
  return fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    signal: request.signal
  })
}

// ---------------------------------------------------------------------------
// Injected file access
// ---------------------------------------------------------------------------

/** A clip, opened and ready to become a multipart part. */
export interface UploadSource {
  /** Base name reported to Streamable as the part's filename, e.g. `death.mkv`. */
  readonly fileName: string
  /** Size in bytes, from `stat` - i.e. known BEFORE any of it is read. */
  readonly sizeBytes: number
  /**
   * The file's bytes.
   *
   * LAZY BY DEFAULT: {@link nodeOpenFile} uses `fs.openAsBlob`, which reads on demand
   * as the request body is serialised. A 250 MB clip must never be buffered into the
   * main process's heap - that is a quarter-gigabyte spike in the same process that is
   * tailing the log and holding the OBS socket.
   */
  readonly blob: Blob
}

/** Opens a clip for upload. Rejects if the file cannot be read. */
export type OpenFileFn = (filePath: string) => Promise<UploadSource>

/**
 * Content types for the containers OBS actually writes.
 *
 * Falls back to `application/octet-stream` rather than guessing `video/mp4`: the
 * filename extension is what Streamable keys off, and claiming a container the file is
 * not is worse than declining to say.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.mp4', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.flv', 'video/x-flv'],
  ['.ts', 'video/mp2t'],
  ['.m4v', 'video/x-m4v'],
  ['.avi', 'video/x-msvideo']
])

/** The real implementation, backed by `node:fs`. */
export const nodeOpenFile: OpenFileFn = async (filePath) => {
  const stats = await stat(filePath)
  if (!stats.isFile()) throw new Error('not a regular file')
  const type = CONTENT_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream'
  const blob = await openAsBlob(filePath, { type })
  return { fileName: basename(filePath), sizeBytes: stats.size, blob }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * How far an upload has got.
 *
 * READ {@link StreamableClient.upload}'S NOTE ON PROGRESS BEFORE USING THIS. In short:
 * `percent` is `null` for the whole upload, on purpose, because the platform gives no
 * per-chunk callback for a `FormData` body and a fabricated percentage is worse than an
 * honest indeterminate bar. `totalBytes` IS known and is worth showing.
 */
export interface UploadProgress {
  /** The clip's size in bytes. Always known - it came from `stat`. */
  readonly totalBytes: number
  /** Bytes confirmed sent, or null when unknown (which is always, today). */
  readonly bytesSent: number | null
  /** Whole percent 0-100, or null for "indeterminate". Today: always null. */
  readonly percent: number | null
}

/** Progress callback. A listener that throws is swallowed; it cannot fail an upload. */
export type ProgressListener = (progress: UploadProgress) => void

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Arguments to {@link StreamableClient.upload}. */
export interface UploadOptions {
  /** Absolute path to the clip ON THIS MACHINE. A remote-OBS path will not open. */
  readonly filePath: string
  /** Streamable account email (the HTTP Basic username). */
  readonly email: string
  /** Streamable account password (the HTTP Basic password). Never leaves this module. */
  readonly password: string
  /**
   * Refuse locally above this many bytes. Defaults to
   * {@link STREAMABLE_FREE_TIER_MAX_BYTES}; `0` disables the check and lets Streamable
   * be the one to refuse. Mirrors `settings.streamable.maxFileBytes`.
   */
  readonly maxBytes?: number | undefined
  /** Cancels an upload in flight - e.g. the app is quitting. */
  readonly signal?: AbortSignal | undefined
  /** See {@link UploadProgress}. Called once, when the bytes start moving. */
  readonly onProgress?: ProgressListener | undefined
  /** Backstop on this one upload. Defaults to the client's `uploadTimeoutMs`. */
  readonly timeoutMs?: number | undefined
}

/**
 * A clip Streamable has accepted.
 *
 * ACCEPTED IS NOT WATCHABLE. The video exists at {@link url} from this moment but will
 * not play until transcoding finishes - see {@link StreamableClient.awaitReady}.
 */
export interface UploadedVideo {
  /** Streamable's short id. The only durable handle on the video. */
  readonly shortcode: string
  /** `https://streamable.com/{shortcode}`. Built here so nothing else assembles URLs. */
  readonly url: string
  /**
   * The numeric status carried by the upload response, when it carried one.
   *
   * Null is NORMAL and not a problem: the upload response is the undocumented half of
   * this file and its shape is not promised. Ask the documented endpoint instead.
   */
  readonly status: number | null
  /** Size of the file we sent, from `stat`. */
  readonly sizeBytes: number
}

/** Result of {@link StreamableClient.upload}. */
export type UploadResult = StreamableResult<UploadedVideo>

/** A video Streamable has finished processing. */
export interface ReadyVideo {
  readonly shortcode: string
  /** `https://streamable.com/{shortcode}`. */
  readonly url: string
}

/** Arguments to {@link StreamableClient.awaitReady}. */
export interface AwaitReadyOptions {
  /**
   * Credentials for the poll.
   *
   * OPTIONAL BUT USUALLY NEEDED. `GET /videos/{shortcode}` is public for a PUBLIC
   * video, but a freshly uploaded one may be private to the account, in which case an
   * unauthenticated poll gets a 404 forever and the clip looks like it vanished. Pass
   * the same credentials the upload used.
   */
  readonly email?: string | undefined
  readonly password?: string | undefined
  readonly signal?: AbortSignal | undefined
  /** Total time to wait before giving up. Defaults to {@link DEFAULT_MAX_WAIT_MS}. */
  readonly maxWaitMs?: number | undefined
  /** First gap between polls; later gaps back off. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number | undefined
  /** Ceiling on the gap. Defaults to {@link DEFAULT_POLL_MAX_DELAY_MS}. */
  readonly pollMaxDelayMs?: number | undefined
  /** Cap on each individual poll request. Defaults to the client's `requestTimeoutMs`. */
  readonly requestTimeoutMs?: number | undefined
  /** Called with each numeric status observed, for a live "processing" readout. */
  readonly onStatus?: ((status: number) => void) | undefined
}

/** Arguments to {@link StreamableClient.testCredentials}. */
export interface TestCredentialsOptions {
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

/** Constructor extras. All optional; the defaults are the production behaviour. */
export interface StreamableClientOptions {
  /** HTTP transport. Defaults to the platform `fetch`. A TEST SEAM. */
  readonly fetch?: FetchLike | undefined
  /** File access. Defaults to {@link nodeOpenFile}. A TEST SEAM. */
  readonly openFile?: OpenFileFn | undefined
  /** Backstop on one upload. Defaults to {@link DEFAULT_UPLOAD_TIMEOUT_MS}. */
  readonly uploadTimeoutMs?: number | undefined
  /** Cap on one small request. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number | undefined
  /**
   * Called when a caller-supplied callback throws somewhere this class swallowed it.
   * Purely diagnostic - the default is a no-op, and a hook that throws is ignored.
   * It is handed the thrown value; it MUST NOT log it anywhere public.
   */
  readonly onInternalError?: ((error: unknown, context: string) => void) | undefined
}

/** `https://streamable.com/{shortcode}`. PURE and TOTAL. */
export function videoPageUrl(shortcode: string): string {
  return `${STREAMABLE_VIDEO_PAGE_BASE}/${shortcode}`
}

// ---------------------------------------------------------------------------
// Defensive parsing (pure)
// ---------------------------------------------------------------------------

/** True for plain objects only - rejects `null` and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `JSON.parse` that returns `unknown` and never throws.
 *
 * `undefined` means "that was not JSON", which is the single most likely thing to come
 * back the day the unofficial endpoint changes: an HTML error page, a captive-portal
 * login, a proxy's "access denied".
 *
 * PURE and TOTAL.
 */
export function parseJsonSafely(text: string): unknown {
  try {
    // `unknown`, never `any`: everything downstream narrows explicitly.
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

/** A string field off an unknown value, or null. PURE and TOTAL. */
function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null
  const value: unknown = source[key]
  return typeof value === 'string' ? value : null
}

/** A finite number field off an unknown value, or null. PURE and TOTAL. */
function readNumber(source: unknown, key: string): number | null {
  if (!isRecord(source)) return null
  const value: unknown = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The `shortcode` off an upload response, or null if it is not there / not usable.
 *
 * THE ONE FIELD THE WHOLE FEATURE DEPENDS ON. It is checked against
 * {@link SHORTCODE_PATTERN} rather than merely `typeof === 'string'`, because it is
 * concatenated into two URLs and shown to the user; a `null` here becomes a clean
 * `unexpected-response`, which is exactly the signal we want when the vendor changes
 * the field name.
 *
 * PURE and TOTAL: never throws, for any input including null and primitives.
 */
export function parseShortcode(body: unknown): string | null {
  const shortcode = readString(body, 'shortcode')
  if (shortcode === null) return null
  const trimmed = shortcode.trim()
  return SHORTCODE_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * The numeric `status` off a `GET /videos/{shortcode}` response, or null.
 *
 * Restricted to the four documented values. A fifth value is not "probably fine" - it
 * is an API we no longer understand, and pretending otherwise would mean polling
 * forever on a status that never becomes 2.
 *
 * PURE and TOTAL.
 */
export function parseVideoStatus(body: unknown): number | null {
  const status = readNumber(body, 'status')
  if (status === null) return null
  if (!Number.isInteger(status)) return null
  if (status < STREAMABLE_STATUS.UPLOADING || status > STREAMABLE_STATUS.ERROR) return null
  return status
}

/**
 * A human-usable explanation Streamable put in the body, if any.
 *
 * Both `message` and `error` turn up in the wild. Purely additive - it improves an
 * error message and is never load-bearing. PURE and TOTAL.
 */
function parseServerMessage(body: unknown, secrets: readonly string[]): string {
  const raw = readString(body, 'message') ?? readString(body, 'error')
  if (raw === null) return ''
  return bodySnippet(raw, secrets)
}

/**
 * `Retry-After` in ms, when it is an integer number of seconds.
 *
 * The HTTP-date form is deliberately not parsed: it needs clock agreement with the
 * server to mean anything, and the value is only ever used to word a sentence.
 *
 * PURE and TOTAL.
 */
function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const seconds = Number(trimmed)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds, 86_400) * 1000
}

// ---------------------------------------------------------------------------
// Thrown-value inspection (pure)
// ---------------------------------------------------------------------------

/** A message for any thrown value, including a `cause` chain. PURE and TOTAL. */
function describeThrown(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (typeof error !== 'object' || error === null) return ''

  const message: unknown = (error as { message?: unknown }).message
  const head = typeof message === 'string' ? message.trim() : ''

  // `fetch` reports essentially everything as "fetch failed" and puts the real reason
  // (ECONNREFUSED, ENOTFOUND, a TLS failure) on `cause`. Without this, every network
  // error in the app would read identically.
  const cause: unknown = (error as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null) {
    const causeMessage: unknown = (cause as { message?: unknown }).message
    if (typeof causeMessage === 'string' && causeMessage.trim() !== '' && causeMessage.trim() !== head) {
      return head === '' ? causeMessage.trim() : `${head}: ${causeMessage.trim()}`
    }
  }
  return head
}

/**
 * True for the `AbortError` that `fetch` rejects with when its signal fires.
 *
 * DUCK-TYPED on `name` rather than `instanceof DOMException`: the class identity does
 * not survive every bundling arrangement Electron can produce, and duck-typing lets
 * tests reject with a plain `Error` instead of manufacturing a DOMException.
 *
 * PURE and TOTAL.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name: unknown = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

// ---------------------------------------------------------------------------
// Abort + timeout plumbing
// ---------------------------------------------------------------------------

/** One request's cancellation scope: the caller's signal OR our own timeout. */
interface Attempt {
  /** Hand this to {@link FetchLike}. */
  readonly signal: AbortSignal
  /** True when OUR timer fired, rather than the caller cancelling. */
  readonly timedOut: () => boolean
  /** Clears the timer and detaches the forwarding listener. Idempotent. */
  readonly dispose: () => void
}

/**
 * Combines the caller's `AbortSignal` with a local timeout into one signal.
 *
 * Written by hand rather than with `AbortSignal.any` + `AbortSignal.timeout` so that
 * "the caller cancelled" and "we ran out of patience" stay TELLABLE APART - they need
 * different words in front of the user, and a merged signal loses that. The forwarding
 * listener is removed on dispose; without that, one long-lived shutdown signal would
 * accumulate a listener per upload for the life of the process.
 */
function startAttempt(external: AbortSignal | undefined, timeoutMs: number): Attempt {
  const controller = new AbortController()
  let timedOut = false

  const onExternalAbort = (): void => {
    controller.abort()
  }

  if (external !== undefined) {
    if (external.aborted) {
      controller.abort()
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  // DELIBERATELY NOT `unref`ed, unlike the background timers in `obs-client.ts`. This
  // one is the only thing that can settle a promise the caller is awaiting: unref it
  // and a plain-node host with nothing else pending would exit mid-request, leaving
  // that promise hanging forever. `dispose()` clears it the moment the request
  // finishes, so it is only ever alive while a request genuinely is - and a shutdown
  // cancels it through `signal`, which is what the signal is for.
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : null

  let disposed = false
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (timer !== null) clearTimeout(timer)
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort)
    }
  }
}

/**
 * Waits `ms`, or resolves early when `signal` fires. Resolves `true` if it was cut
 * short by the abort. NEVER REJECTS - a cancelled sleep is an ordinary outcome.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(true)
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(false)

  return new Promise<boolean>((resolve) => {
    const finish = (aborted: boolean): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(aborted)
    }
    const onAbort = (): void => {
      finish(true)
    }
    // Not `unref`ed, for the same reason as the timer in `startAttempt`: the caller is
    // awaiting this, so it has to be able to keep the loop alive.
    const timer = setTimeout(() => {
      finish(false)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Error constructors (pure)
// ---------------------------------------------------------------------------

function abortedError(message: string): StreamableAbortedError {
  return { kind: 'aborted', message }
}

/**
 * Maps a NON-2xx HTTP status onto a {@link StreamableError}.
 *
 * The mapping the task's contract pins down:
 *  - 401/403 -> `auth-failed`. Streamable answers 401 for a bad password on the upload
 *    endpoint; 403 is folded in because a disabled or unverified account is the same
 *    problem from the user's chair - "your credentials did not get you in".
 *  - 413 -> `file-too-large`. The server's own limit, which it does not tell us.
 *  - 429 -> `rate-limited`, with `Retry-After` if it is usable.
 *  - anything else -> `unexpected-response`, carrying the status and a scrubbed
 *    snippet, because a 500 and a 404 are both "the endpoint did not behave" and the
 *    snippet is what tells whoever repairs this file which it was.
 *
 * EVERY ARM CARRIES THE SNIPPET, not just the last one. That asymmetry used to be a real
 * hole: this file's stated job is to make breakage CHEAP AND OBVIOUS, and the four pinned
 * statuses are precisely the ones an interstitial (a bot wall, a WAF, a proxy, a CDN's
 * rate limiter) is most likely to arrive as. Dropping the body on those four meant the
 * most likely SHAPE of a breakage was the one shape that produced no evidence at all.
 *
 * AND A 401/403 WHOSE BODY IS NOT JSON SAYS SO. Streamable rejects a login with a JSON
 * body; a block page is HTML. When the body did not parse as JSON but was not empty, the
 * message stops asserting that the password is wrong, offers the block-page reading as
 * well, and appends {@link REPAIR_HINT} - because sending a user to change a credential
 * that works is worse than admitting we are not sure.
 *
 * PURE and TOTAL: never throws.
 */
function describeHttpFailure(params: {
  readonly status: number
  readonly retryAfterMs: number | null
  readonly snippet: string
  readonly serverMessage: string
  /**
   * Whether the body parsed as JSON at all. False for an HTML block page, a captive
   * portal, a proxy's plain-text refusal - and also for an EMPTY body, which is why the
   * 401/403 wording below additionally requires a non-empty snippet before it starts
   * doubting itself.
   */
  readonly bodyIsJson: boolean
  /** What we were trying to do, as a verb phrase: "upload the clip". */
  readonly what: string
  /** Known local size, for a 413. Null when we were not sending a file. */
  readonly sizeBytes: number | null
}): StreamableError {
  const detail = params.serverMessage === '' ? '' : ` Streamable said: ${params.serverMessage}`
  // Appended to the pinned-status arms only when the body carried something worth
  // quoting; `detail` already quotes it when the body was JSON with a message in it.
  const evidence =
    detail !== '' || params.snippet === '' ? '' : ` Response began: ${params.snippet}`

  if (params.status === 401 || params.status === 403) {
    const looksLikeAPage = !params.bodyIsJson && params.snippet !== ''
    return {
      kind: 'auth-failed',
      status: params.status,
      bodySnippet: params.snippet,
      message: looksLikeAPage
        ? `Streamable answered HTTP ${params.status} with a page rather than a JSON rejection, ` +
          'so this may be a block page (a bot wall, a proxy, a firewall) rather than a wrong ' +
          'password. Check the Streamable email and password in Settings anyway - it is your ' +
          'Streamable ACCOUNT password, there is no separate API key - and if they are right, ' +
          `this is the other thing. ${REPAIR_HINT}${evidence}`
        : `Streamable rejected the account email and password (HTTP ${params.status}). ` +
          'Check them in Settings, and remember it is your Streamable ACCOUNT password - ' +
          'Streamable has no separate API key.' +
          detail +
          evidence
    }
  }

  if (params.status === 413) {
    return {
      kind: 'file-too-large',
      sizeBytes: params.sizeBytes ?? 0,
      limitBytes: null,
      bodySnippet: params.snippet,
      message:
        'Streamable refused the clip as too large (HTTP 413). Its free plan stops at ' +
        `${formatMegabytes(STREAMABLE_FREE_TIER_MAX_BYTES)}, and a longer replay buffer makes bigger files.` +
        detail +
        evidence
    }
  }

  if (params.status === 429) {
    const wait =
      params.retryAfterMs === null
        ? 'Wait a few minutes before trying again.'
        : `Streamable asked us to wait ${Math.round(params.retryAfterMs / 1000)}s before trying again.`
    return {
      kind: 'rate-limited',
      retryAfterMs: params.retryAfterMs,
      bodySnippet: params.snippet,
      message: `Streamable is rate limiting poe-tool (HTTP 429). ${wait}${detail}${evidence}`
    }
  }

  // A 4xx that is not one of the three above means Streamable understood the request
  // and refused it - which, on an UNDOCUMENTED endpoint, most often means the contract
  // moved. Point at the file to repair. A 5xx gets no such hint: that is Streamable
  // having a bad day, and sending someone to read our source would waste their time.
  const hint = params.status >= 400 && params.status < 500 ? ` ${REPAIR_HINT}` : ''

  return {
    kind: 'unexpected-response',
    status: params.status,
    bodySnippet: params.snippet,
    message:
      `Streamable answered HTTP ${params.status} when poe-tool tried to ${params.what}.${hint}` +
      (detail === '' ? (params.snippet === '' ? '' : ` Response began: ${params.snippet}`) : detail)
  }
}

/** The message every "we no longer understand this API" failure ends with. */
const REPAIR_HINT =
  "poe-tool's upload endpoint is unofficial and may have changed; " +
  'see src/main/upload/streamable-client.ts.'

function unexpectedResponse(params: {
  readonly status: number | null
  readonly snippet: string
  readonly what: string
}): StreamableUnexpectedResponseError {
  return {
    kind: 'unexpected-response',
    status: params.status,
    bodySnippet: params.snippet,
    message:
      `Unexpected response from Streamable while trying to ${params.what}. ${REPAIR_HINT}` +
      (params.snippet === '' ? '' : ` Response began: ${params.snippet}`)
  }
}

/** `"250 MB"`. 1024-based, matching how OBS and Windows report sizes. PURE and TOTAL. */
function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 100 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`
}

// ---------------------------------------------------------------------------
// StreamableClient
// ---------------------------------------------------------------------------

/**
 * poe-tool's whole conversation with Streamable.
 *
 * ```ts
 * const streamable = new StreamableClient()
 *
 * const uploaded = await streamable.upload({
 *   filePath: clip.finalPath,
 *   email: settings.streamable.email,
 *   password: settings.streamable.password,
 *   maxBytes: settings.streamable.maxFileBytes,
 *   signal: shutdown.signal
 * })
 * if (!uploaded.ok) return { state: 'failed', message: uploaded.error.message }
 *
 * // The link is usable now; it just will not play yet.
 * publish({ state: 'processing', shortcode: uploaded.value.shortcode })
 *
 * const ready = await streamable.awaitReady(uploaded.value.shortcode, {
 *   email: settings.streamable.email,
 *   password: settings.streamable.password,
 *   signal: shutdown.signal
 * })
 * publish(ready.ok ? { state: 'done', ...ready.value } : { state: 'failed', message: ready.error.message })
 * ```
 *
 * NO METHOD REJECTS. Every failure - including a programming error inside the parsing
 * code, which is guarded - comes back as `{ ok: false, error }`.
 *
 * STATELESS AND REENTRANT. Nothing is cached between calls, so two uploads may overlap
 * (though the caller has no reason to want that: they share one upstream link).
 */
export class StreamableClient {
  readonly #fetch: FetchLike
  readonly #openFile: OpenFileFn
  readonly #uploadTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #onInternalError: (error: unknown, context: string) => void

  constructor(options: StreamableClientOptions = {}) {
    this.#fetch = options.fetch ?? platformFetch
    this.#openFile = options.openFile ?? nodeOpenFile
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#onInternalError = options.onInternalError ?? ((): void => undefined)
  }

  // -------------------------------------------------------------------------
  // upload
  // -------------------------------------------------------------------------

  /**
   * Uploads a clip to Streamable and returns its shortcode.
   *
   * `POST https://api.streamable.com/upload`, HTTP Basic auth, `multipart/form-data`
   * with the video under the `file` field. THE ENDPOINT IS UNOFFICIAL - see the file
   * header, and do not move this request anywhere else.
   *
   * ORDER OF CHECKS, AND WHY IT IS THIS ORDER
   * -----------------------------------------
   *  1. Already aborted -> stop. A shutdown that started before we did.
   *  2. No credentials -> `auth-failed` WITHOUT a request. Sending an empty password to
   *     a third party to be told it is wrong helps nobody.
   *  3. Open the file -> `file-unreadable` on failure. A missing clip is a local
   *     problem and must not be reported as a network one.
   *  4. Size vs `maxBytes` -> `file-too-large` WITHOUT a request. The free plan stops
   *     at 250 MB; discovering that after a 20-minute upload is the failure mode this
   *     check exists to prevent.
   *  5. Only then does anything leave the machine.
   *
   * ON PROGRESS: `onProgress` is called ONCE, as the request is dispatched, with
   * `percent: null`. That is not laziness. A `fetch` with a `FormData` body has no
   * per-chunk hook in Node - the body is serialised by undici internally - so the
   * honest options are "indeterminate" or a fabricated number, and a progress bar that
   * lies about a 20-minute upload is worse than one that admits it does not know.
   * `UploadUploading.percent` in `src/shared/ipc.ts` is `number | null` for exactly
   * this reason: `null` means "render an indeterminate bar", never "0%".
   *
   * NEVER THROWS.
   */
  async upload(opts: UploadOptions): Promise<UploadResult> {
    const secrets = credentialSecrets(opts.email.trim(), opts.password)

    if (opts.signal?.aborted === true) {
      return { ok: false, error: abortedError('The upload was cancelled before it started.') }
    }

    const email = opts.email.trim()
    if (email === '' || opts.password === '') {
      return {
        ok: false,
        error: {
          kind: 'auth-failed',
          status: null,
          // Nothing was sent, so there is no response to quote.
          bodySnippet: '',
          message:
            'No Streamable email and password are saved, so poe-tool did not attempt an upload. ' +
            'Enter them in Settings - Streamable has no API key, so it is the account password itself.'
        }
      }
    }

    // ---- 3. Open the file (local failure, no network) ----------------------
    let source: UploadSource
    try {
      source = await this.#openFile(opts.filePath)
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'file-unreadable',
          filePath: opts.filePath,
          message: scrubSecrets(
            `poe-tool could not read the clip at ${opts.filePath}, so there was nothing to upload` +
              `${describeThrown(error) === '' ? '' : `: ${describeThrown(error)}`}. ` +
              'The file may have been moved or deleted, or it may live on another machine if OBS is remote.',
            secrets
          )
        }
      }
    }

    if (source.sizeBytes <= 0) {
      return {
        ok: false,
        error: {
          kind: 'file-unreadable',
          filePath: opts.filePath,
          message:
            `The clip at ${opts.filePath} is empty (0 bytes), so poe-tool did not upload it. ` +
            'OBS may have failed to flush the replay buffer.'
        }
      }
    }

    // ---- 4. Size limit (local failure, no network) -------------------------
    const limitBytes = opts.maxBytes ?? STREAMABLE_FREE_TIER_MAX_BYTES
    if (Number.isFinite(limitBytes) && limitBytes > 0 && source.sizeBytes > limitBytes) {
      return {
        ok: false,
        error: {
          kind: 'file-too-large',
          sizeBytes: source.sizeBytes,
          limitBytes,
          // Decided locally, before a byte left the machine: there is no response yet.
          bodySnippet: '',
          message:
            `This clip is ${formatMegabytes(source.sizeBytes)}, over the ` +
            `${formatMegabytes(limitBytes)} upload limit, so poe-tool did not send it. ` +
            "Streamable's free plan stops at " +
            `${formatMegabytes(STREAMABLE_FREE_TIER_MAX_BYTES)}; shorten the OBS replay buffer or ` +
            'lower its recording quality.'
        }
      }
    }

    // ---- 5. The request ----------------------------------------------------
    const body = new FormData()
    body.append('file', source.blob, source.fileName)

    this.#reportProgress(opts.onProgress, {
      totalBytes: source.sizeBytes,
      bytesSent: 0,
      percent: null
    })

    const outcome = await this.#request({
      url: STREAMABLE_UPLOAD_URL,
      method: 'POST',
      email,
      password: opts.password,
      body,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? this.#uploadTimeoutMs,
      what: 'upload the clip',
      sizeBytes: source.sizeBytes,
      secrets
    })
    if (!outcome.ok) return outcome

    // ---- Parse. DEFENSIVELY: this is the undocumented half. ----------------
    const snippet = bodySnippet(outcome.value.text, secrets)
    const parsed = parseJsonSafely(outcome.value.text)
    const shortcode = parseShortcode(parsed)
    if (shortcode === null) {
      return {
        ok: false,
        error: unexpectedResponse({
          status: outcome.value.status,
          snippet,
          what: 'upload the clip - it answered without a usable "shortcode"'
        })
      }
    }

    return {
      ok: true,
      value: {
        shortcode,
        url: videoPageUrl(shortcode),
        status: parseVideoStatus(parsed),
        sizeBytes: source.sizeBytes
      }
    }
  }

  // -------------------------------------------------------------------------
  // awaitReady
  // -------------------------------------------------------------------------

  /**
   * Polls the OFFICIAL, DOCUMENTED `GET https://api.streamable.com/videos/{shortcode}`
   * until the video is ready to watch.
   *
   * Status is numeric and documented: 0 uploading, 1 processing, 2 ready, 3 error.
   * Resolves on 2, fails `processing-failed` on 3, and otherwise keeps waiting with a
   * backing-off gap until `maxWaitMs` is spent, at which point it fails `timeout` -
   * CARRYING THE SHORTCODE, because a timeout here does not mean the clip was lost. It
   * means Streamable is still working and we stopped watching; the link in
   * {@link StreamableTimeoutError.shortcode} will very likely play later.
   *
   * A 404 IS TREATED AS "NOT YET", NOT AS AN ERROR. Streamable does not necessarily
   * expose a video the instant the upload request returns, and an unauthenticated poll
   * of a private video 404s as well. Giving up on the first 404 would report every
   * successful upload as a failure. Pass `email`/`password` so private videos resolve.
   *
   * NEVER THROWS.
   */
  async awaitReady(shortcode: string, opts: AwaitReadyOptions = {}): Promise<StreamableResult<ReadyVideo>> {
    const password = opts.password ?? ''
    const email = (opts.email ?? '').trim()
    const secrets = credentialSecrets(email, password)

    const trimmed = shortcode.trim()
    if (!SHORTCODE_PATTERN.test(trimmed)) {
      // Not a network failure: we were handed something that cannot be a Streamable id,
      // which means whoever produced it did not come from this file's parser.
      return {
        ok: false,
        error: unexpectedResponse({
          status: null,
          snippet: bodySnippet(shortcode, secrets),
          what: 'check whether a video is ready - it was given an unusable shortcode'
        })
      }
    }

    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    const baseDelayMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const maxDelayMs = opts.pollMaxDelayMs ?? DEFAULT_POLL_MAX_DELAY_MS
    const startedAt = Date.now()
    const url = `${STREAMABLE_VIDEO_API_BASE}/${encodeURIComponent(trimmed)}`

    let attempt = 0
    for (;;) {
      if (opts.signal?.aborted === true) {
        return { ok: false, error: abortedError('Waiting for Streamable to finish processing was cancelled.') }
      }

      attempt += 1
      const outcome = await this.#request({
        url,
        method: 'GET',
        email,
        password,
        body: null,
        signal: opts.signal,
        timeoutMs: opts.requestTimeoutMs ?? this.#requestTimeoutMs,
        what: 'check whether the video is ready',
        sizeBytes: null,
        secrets,
        // 404 is "not visible yet" here, not a failure - see the method doc.
        treatAsPending: [404]
      })

      if (!outcome.ok) return outcome

      if (outcome.value.pending) {
        // Nothing to parse; fall through to the wait below.
      } else {
        const parsed = parseJsonSafely(outcome.value.text)
        const status = parseVideoStatus(parsed)
        if (status === null) {
          return {
            ok: false,
            error: unexpectedResponse({
              status: outcome.value.status,
              snippet: bodySnippet(outcome.value.text, secrets),
              what: 'check whether the video is ready - it answered without a usable numeric "status"'
            })
          }
        }

        this.#reportStatus(opts.onStatus, status)

        if (status === STREAMABLE_STATUS.READY) {
          return { ok: true, value: { shortcode: trimmed, url: videoPageUrl(trimmed) } }
        }
        if (status === STREAMABLE_STATUS.ERROR) {
          const serverMessage = parseServerMessage(parsed, secrets)
          return {
            ok: false,
            error: {
              kind: 'processing-failed',
              shortcode: trimmed,
              message:
                'Streamable received the clip but could not process it into a playable video' +
                `${serverMessage === '' ? '' : `: ${serverMessage}`}. ` +
                `The upload itself worked - see ${videoPageUrl(trimmed)} - so re-uploading is the only fix.`
            }
          }
        }
      }

      // ---- Still uploading/processing. Wait, unless we are out of time. ----
      const elapsedMs = Date.now() - startedAt
      const remainingMs = maxWaitMs - elapsedMs
      if (remainingMs <= 0) return { ok: false, error: this.#pollTimeout(trimmed, elapsedMs) }

      const gap = Math.min(pollDelayMs(attempt, baseDelayMs, maxDelayMs), remainingMs)
      const aborted = await delay(gap, opts.signal)
      if (aborted) {
        return { ok: false, error: abortedError('Waiting for Streamable to finish processing was cancelled.') }
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        return { ok: false, error: this.#pollTimeout(trimmed, Date.now() - startedAt) }
      }
    }
  }

  #pollTimeout(shortcode: string, waitedMs: number): StreamableTimeoutError {
    return {
      kind: 'timeout',
      waitedMs,
      shortcode,
      message:
        `Streamable was still processing this clip after ${Math.round(waitedMs / 1000)}s, so poe-tool ` +
        `stopped waiting. THE UPLOAD SUCCEEDED - ${videoPageUrl(shortcode)} should play once ` +
        'Streamable finishes.'
    }
  }

  // -------------------------------------------------------------------------
  // testCredentials
  // -------------------------------------------------------------------------

  /**
   * Checks an email + password WITHOUT uploading a video, for the settings UI's
   * "Test credentials" button.
   *
   *
   * BE HONEST ABOUT WHAT THIS CAN AND CANNOT PROVE
   * ----------------------------------------------
   * THERE IS NO DOCUMENTED "VERIFY MY CREDENTIALS" ENDPOINT. Streamable's official API
   * is read-only (see the file header) and its two documented endpoints are both
   * unauthenticated - `GET /videos/{shortcode}` answers the same for a valid login, an
   * invalid one, and none at all, so it cannot test anything. Third-party wrappers
   * mention other paths, but none of them is documented and this file does not invent
   * endpoints: an invented URL that 404s would report every correct password as wrong,
   * which is worse than not offering the button.
   *
   * So this does the closest honest thing: it makes the SAME request the uploader makes,
   * to the SAME endpoint, with the SAME auth, AND NO FILE. A POST to `/upload` with an
   * empty multipart body carries no video, cannot publish anything, and still has to get
   * past HTTP Basic auth before the server can complain about the missing file.
   *
   *   - 401/403        -> `auth-failed`. CONCLUSIVE: these credentials do not work.
   *   - anything else  -> `{ ok: true }`. The server did NOT reject the login. A 400 or
   *                       a 415 about the absent file is the EXPECTED success shape here.
   *   - network/abort  -> reported as themselves, so "wrong password" and "no internet"
   *                       never look the same to the user.
   *
   * IT IS THEREFORE A NEGATIVE TEST. It can prove credentials are BAD; it cannot fully
   * prove they are good, because a server that validated the body before the
   * `Authorization` header would answer 400 to a bad password too. Word the UI
   * accordingly ("Streamable did not reject these credentials"), and do not promote this
   * to a guarantee.
   *
   * NEVER THROWS, and never echoes the password.
   */
  async testCredentials(
    email: string,
    password: string,
    opts: TestCredentialsOptions = {}
  ): Promise<StreamableResult<void>> {
    const trimmedEmail = email.trim()
    const secrets = credentialSecrets(trimmedEmail, password)

    if (opts.signal?.aborted === true) {
      return { ok: false, error: abortedError('The credential check was cancelled before it started.') }
    }

    if (trimmedEmail === '' || password === '') {
      return {
        ok: false,
        error: {
          kind: 'auth-failed',
          status: null,
          bodySnippet: '',
          message:
            'Enter both a Streamable email and a password first. Streamable has no API key, so ' +
            'poe-tool needs the account password itself.'
        }
      }
    }

    const outcome = await this.#request({
      url: STREAMABLE_UPLOAD_URL,
      method: 'POST',
      email: trimmedEmail,
      password,
      // Deliberately EMPTY: this must not upload anything. See the method doc.
      body: new FormData(),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? this.#requestTimeoutMs,
      what: 'check your Streamable credentials',
      sizeBytes: null,
      secrets,
      // Every non-auth rejection means "the login got through", which is all we asked.
      treatAsPending: 'all-but-auth'
    })

    if (!outcome.ok) {
      // `auth-failed`, `rate-limited`, `network`, `timeout` and `aborted` all reach here
      // and all say something true and different. Nothing is flattened.
      return outcome
    }
    return { ok: true, value: undefined }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One HTTP round trip: auth header, abort/timeout scope, status mapping, body read.
   *
   * Returns the RAW body text; parsing is each caller's job, because the two endpoints
   * have different shapes and only one of them is documented.
   *
   * `treatAsPending` decides which non-2xx statuses are NOT failures:
   *  - a list of statuses (`awaitReady` passing `[404]`, i.e. "not visible yet"), or
   *  - `'all-but-auth'` (`testCredentials`, where only 401/403 is an answer).
   */
  async #request(params: {
    readonly url: string
    readonly method: 'GET' | 'POST'
    readonly email: string
    readonly password: string
    readonly body: FormData | null
    readonly signal: AbortSignal | undefined
    readonly timeoutMs: number
    readonly what: string
    readonly sizeBytes: number | null
    readonly secrets: readonly string[]
    readonly treatAsPending?: readonly number[] | 'all-but-auth'
  }): Promise<StreamableResult<{ readonly status: number; readonly text: string; readonly pending: boolean }>> {
    const attempt = startAttempt(params.signal, params.timeoutMs)

    try {
      // NO `Authorization` AT ALL WHEN THERE IS NOTHING TO SEND. `GET /videos/{code}`
      // is public for a public video, and an empty Basic credential (`base64(":")`) is
      // not "no credential" - it is a wrong one, which a server is entitled to answer
      // 401 to. Sending nothing keeps an unauthenticated poll unauthenticated.
      const headers: Record<string, string> =
        params.password === '' && params.email === ''
          ? // Not a promise about what comes back - the endpoint is undocumented and has
            // been known to answer HTML. Purely a statement of preference.
            { Accept: 'application/json' }
          : {
              Authorization: buildAuthorizationHeader(params.email, params.password),
              Accept: 'application/json'
            }

      let response: StreamableHttpResponse
      try {
        response = await this.#fetch(params.url, {
          method: params.method,
          headers,
          body: params.body,
          signal: attempt.signal
        })
      } catch (error) {
        return { ok: false, error: this.#classifyThrown(error, params, attempt) }
      }

      // Reading the body can fail on its own (the connection dies mid-response), and
      // that is a transport failure, not a parse failure.
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        return { ok: false, error: this.#classifyThrown(error, params, attempt) }
      }

      if (response.ok) return { ok: true, value: { status: response.status, text, pending: false } }

      const pending =
        params.treatAsPending === 'all-but-auth'
          ? // A 5xx is NOT a pass. "Streamable is having a bad day" says nothing about
            // whether the credentials are right, and reporting it as a successful check
            // would send the user away believing something we did not verify.
            response.status < 500 &&
            response.status !== 401 &&
            response.status !== 403 &&
            response.status !== 429
          : (params.treatAsPending ?? []).includes(response.status)
      if (pending) return { ok: true, value: { status: response.status, text, pending: true } }

      // Parsed ONCE, and the fact that it parsed at all is itself evidence: an endpoint
      // that normally answers JSON and suddenly answers a page has been intercepted by
      // something, and a 401 from that something means nothing about the password.
      const parsedBody = parseJsonSafely(text)

      return {
        ok: false,
        error: describeHttpFailure({
          status: response.status,
          retryAfterMs: parseRetryAfterMs(this.#header(response, 'retry-after')),
          snippet: bodySnippet(text, params.secrets),
          serverMessage: parseServerMessage(parsedBody, params.secrets),
          bodyIsJson: parsedBody !== undefined,
          what: params.what,
          sizeBytes: params.sizeBytes
        })
      }
    } finally {
      attempt.dispose()
    }
  }

  /** Reads a response header, tolerating a `get` that throws. */
  #header(response: StreamableHttpResponse, name: string): string | null {
    try {
      return response.headers.get(name)
    } catch (error) {
      this.#report(error, 'response-header')
      return null
    }
  }

  /**
   * Turns a thrown transport failure into a {@link StreamableError}.
   *
   * The three-way split matters to the user: WE gave up (timeout), THEY gave up
   * (network), or the APP is shutting down (aborted) are three different sentences and
   * only one of them is worth investigating.
   */
  #classifyThrown(
    error: unknown,
    params: { readonly what: string; readonly timeoutMs: number; readonly secrets: readonly string[] },
    attempt: Attempt
  ): StreamableError {
    if (isAbortError(error)) {
      if (attempt.timedOut()) {
        return {
          kind: 'timeout',
          waitedMs: params.timeoutMs,
          shortcode: null,
          message:
            `Streamable did not respond within ${Math.round(params.timeoutMs / 1000)}s when poe-tool tried ` +
            `to ${params.what}.`
        }
      }
      return abortedError(`poe-tool stopped trying to ${params.what} because it was cancelled.`)
    }

    const detail = scrubSecrets(describeThrown(error), params.secrets)
    return {
      kind: 'network',
      message:
        `poe-tool could not reach Streamable to ${params.what}` +
        `${detail === '' ? '' : ` (${detail})`}. Check your internet connection.`
    }
  }

  /** Hands a progress update to the caller. A listener that throws cannot fail an upload. */
  #reportProgress(listener: ProgressListener | undefined, progress: UploadProgress): void {
    if (listener === undefined) return
    try {
      listener(progress)
    } catch (error) {
      this.#report(error, 'progress-listener')
    }
  }

  /** Hands a poll status to the caller. Same guarantee as {@link #reportProgress}. */
  #reportStatus(listener: ((status: number) => void) | undefined, status: number): void {
    if (listener === undefined) return
    try {
      listener(status)
    } catch (error) {
      this.#report(error, 'status-listener')
    }
  }

  /** Diagnostic hand-off. A hook that throws is itself swallowed. */
  #report(error: unknown, context: string): void {
    try {
      this.#onInternalError(error, context)
    } catch {
      // A diagnostic hook must never be the thing that crashes the main process.
    }
  }
}
