/**
 * src/main/obs/obs-client.ts
 * ==========================
 *
 * The obs-websocket v5 client wrapper. Owns exactly one live socket, publishes its
 * state as a discriminated union, and exposes the two operations the rest of the app
 * needs: "is the replay buffer running?" and "save the replay buffer, and tell me
 * where the file landed".
 *
 * NO `electron` IMPORT. Connection parameters arrive as plain arguments.
 *
 *
 * VERIFIED AGAINST THE INSTALLED LIBRARY (obs-websocket-js 5.0.8), NOT FROM MEMORY
 * -------------------------------------------------------------------------------
 * Everything below was read out of `node_modules/obs-websocket-js/dist/*.d.ts` and
 * the compiled `chunk-*.js`, because guessing here is expensive:
 *
 *  - `connect(url?, password?, identificationParams?)` REJECTS on failure and calls
 *    its own `disconnect()` first, so a failed attempt leaves no socket behind.
 *  - `call<T>(requestType, requestData?)` resolves with `OBSResponseTypes[T]`, and
 *    throws `OBSWebSocketError { code, message }` where `code` is the obs-websocket
 *    RequestStatus code.
 *  - Events come off an eventemitter3 base class typed as
 *    `EventEmitter<MapValueToArgsArray<EventTypes>>`, i.e. `on('X', (payload) => ...)`.
 *    `ConnectionClosed` and `ConnectionError` both carry an `OBSWebSocketError`;
 *    on close its `code` is the WEBSOCKET CLOSE CODE (4009 = auth failed), on a
 *    socket error it is `-1`.
 *  - **`SaveReplayBuffer` responds with `undefined`.** `OBSResponseTypes['SaveReplayBuffer']`
 *    is literally `undefined` in the type map - the response carries NO filename.
 *    The path arrives later, on the `ReplayBufferSaved` event, whose payload field is
 *    `savedReplayPath` (NOT `savedReplayFile`/`path`). This is the single most
 *    important fact in this file; see {@link ObsClient.saveReplayBuffer}.
 *  - `GetReplayBufferStatus` responds `{ outputActive: boolean }`.
 *  - `GetVersion` responds `{ obsVersion, obsWebSocketVersion, ... }` - note the
 *    websocket field is `obsWebSocketVersion`, which we surface as `websocketVersion`
 *    to match `ObsTestSuccess`.
 *
 *
 * THE HANG HAZARD THAT SHAPES EVERY REQUEST HERE
 * ----------------------------------------------
 * `call()` awaits an internal promise keyed by request id, and the library's
 * `cleanup()` (run on socket close) does `internalListeners.removeAllListeners()`.
 * A request that is in flight when the socket dies therefore NEVER SETTLES - it does
 * not reject, it hangs forever. So every `call()` in this file goes through
 * {@link ObsClient.#call}, which races it against a timeout. Same for `connect()`,
 * which has no timeout of its own and will sit on a filtered port until TCP gives up
 * minutes later.
 *
 *
 * NOTHING HERE IS ALLOWED TO CRASH THE MAIN PROCESS
 * -------------------------------------------------
 * A dropped OBS socket must degrade the app to "no clips", never take it down with
 * an unhandled rejection or a throwing event listener. Concretely:
 *  - every listener registered on an `OBSWebSocket` is wrapped by `#guard`,
 *  - every state emit is wrapped (`TypedEmitter` deliberately propagates listener
 *    throws to the emitter, see its header),
 *  - no public method rejects. Failures come back as data: a state transition, an
 *    `ObsTestResult`, or an {@link ObsResult} carrying an {@link ObsError}.
 *
 *
 * GENERATIONS, OR: WHY A STALE SOCKET CANNOT SPEAK
 * ------------------------------------------------
 * Each connect attempt gets a FRESH `OBSWebSocket` and a monotonically increasing
 * generation number. Anything asynchronous - a resolved connect, a late
 * `ConnectionClosed`, a scheduled reconnect - re-checks its captured generation
 * before touching shared state. `disconnect()` and a detected drop both bump the
 * generation, which is what makes "explicit disconnect stops the retry loop" and
 * "ConnectionError immediately followed by ConnectionClosed only schedules ONE
 * retry" fall out for free rather than needing extra flags.
 */

import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import type { OBSRequestTypes, OBSResponseTypes, OBSWebSocketError } from 'obs-websocket-js'

import type { ObsConnectionState, ObsTestRequest, ObsTestResult } from '../../shared/ipc'
import { TypedEmitter } from '../events/typed-emitter'
import type { EventListener } from '../events/typed-emitter'

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/**
 * The obs-websocket RPC version we identify as. Pinned to 1 deliberately: it is the
 * only version obs-websocket 5.x has ever spoken, and pinning means a future OBS that
 * advertises version 2 gets an explicit `UnsupportedRpcVersion` close (which we map to
 * a readable message) instead of silently negotiating a protocol this code has never
 * been tested against.
 */
export const OBS_RPC_VERSION = 1

/** Used when the configured host is blank. Matches `DEFAULT_SETTINGS.obs.host`. */
export const DEFAULT_OBS_HOST = '127.0.0.1'

/** The obs-websocket v5 default port. Matches `DEFAULT_SETTINGS.obs.port`. */
export const DEFAULT_OBS_PORT = 4455

/**
 * Event categories the live connection subscribes to.
 *
 * `EventSubscription.All` (4095) is the library's documented "all non-high-volume
 * events" helper and is EXACTLY what the server uses when the field is omitted, so
 * this cannot accidentally exclude anything. That matters: `ReplayBufferSaved` lives
 * in the `Outputs` category, and if it were ever filtered out every single
 * {@link ObsClient.saveReplayBuffer} would sit for the full 10s timeout and report a
 * `save-timeout` - a total, silent failure of the app's main feature. The genuinely
 * chatty events (volume meters at 65536, transform changes at 524288) are high-volume
 * and are therefore still excluded.
 */
export const LIVE_EVENT_SUBSCRIPTIONS: number = EventSubscription.All

/**
 * WebSocket close codes defined by the obs-websocket 5 protocol, i.e. the values that
 * turn up as `OBSWebSocketError.code` on a `ConnectionClosed` event.
 *
 * Only the ones we can say something useful about are listed. 1000/1001 are the
 * standard RFC 6455 normal/going-away codes, and 1006 is the synthetic "abnormal
 * closure" browsers and `ws` produce when the TCP connection failed or vanished
 * without a close frame.
 */
const CLOSE_NORMAL = 1000
const CLOSE_GOING_AWAY = 1001
const CLOSE_ABNORMAL = 1006
const CLOSE_AUTHENTICATION_FAILED = 4009
const CLOSE_UNSUPPORTED_RPC_VERSION = 4010
const CLOSE_SESSION_INVALIDATED = 4011

/**
 * obs-websocket RequestStatus code for "the output you addressed is not running".
 * `SaveReplayBuffer` answers with this when the replay buffer is stopped, which is by
 * far the most common reason clipping does nothing for a new user.
 */
const STATUS_OUTPUT_NOT_RUNNING = 501

// ---------------------------------------------------------------------------
// Timing defaults
// ---------------------------------------------------------------------------

/** Cap on `connect()` + identify. Long enough for a slow LAN, short enough to retry. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** Cap on a single `call()`. Requests to a live OBS answer in single-digit ms. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

/**
 * How long to wait for the `ReplayBufferSaved` event after `SaveReplayBuffer` is
 * acknowledged. OBS has to flush the buffer to disk first, so this is genuinely
 * seconds for a long buffer on a slow drive.
 */
export const DEFAULT_SAVE_TIMEOUT_MS = 10_000

/** Cap on the close handshake during teardown, so a wedged socket cannot stall a retry. */
const TEARDOWN_TIMEOUT_MS = 2_000

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** Shape of the reconnect backoff curve. All values in milliseconds. */
export interface BackoffOptions {
  /** Delay before the first retry. */
  readonly baseMs: number
  /** Multiplier applied per additional attempt. */
  readonly factor: number
  /** Ceiling. Reached after ~6 attempts with the defaults. */
  readonly maxMs: number
}

/** 1s, 2s, 4s, 8s, 16s, then 30s forever. */
export const DEFAULT_BACKOFF: BackoffOptions = Object.freeze({
  baseMs: 1_000,
  factor: 2,
  maxMs: 30_000
})

/**
 * Delay before retry number `attempt` (1-based), capped exponential.
 *
 * PURE and TOTAL: never throws, always returns a finite integer in
 * `[0, options.maxMs]`, for any input including `NaN`, `Infinity` and negatives.
 * Deliberately deterministic - no jitter - because a single desktop app reconnecting
 * to a single local OBS has no thundering-herd problem to solve, and determinism
 * makes the curve testable.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF): number {
  const maxMs = Number.isFinite(options.maxMs) ? Math.max(0, options.maxMs) : DEFAULT_BACKOFF.maxMs
  const baseMs = Number.isFinite(options.baseMs) ? Math.max(0, options.baseMs) : DEFAULT_BACKOFF.baseMs
  const factor = Number.isFinite(options.factor) && options.factor >= 1 ? options.factor : 1

  if (!Number.isFinite(attempt) || attempt <= 1) return Math.round(Math.min(baseMs, maxMs))

  // `factor ** big` overflows to Infinity long before it matters; Math.min pins it.
  const raw = baseMs * factor ** (Math.floor(attempt) - 1)
  if (!Number.isFinite(raw)) return Math.round(maxMs)
  return Math.round(Math.min(raw, maxMs))
}

// ---------------------------------------------------------------------------
// Host parsing (pure)
// ---------------------------------------------------------------------------

/** A `settings.obs.host` string taken apart. See {@link parseObsHost}. */
export interface ParsedObsHost {
  /** True when the user pasted a `wss://` or `https://` URL. */
  readonly secure: boolean
  /** Hostname with scheme, brackets, port and path removed. Lower-cased. */
  readonly hostname: string
  /** Port found INSIDE the host string, or null. Overrides `settings.obs.port`. */
  readonly port: number | null
}

/** Recognised URL schemes, mapped to whether they imply TLS. */
const SCHEME_PATTERN = /^(wss?|https?):\/\//i

/**
 * Splits a user-entered host into its parts.
 *
 * The settings field is documented as a bare host, but people paste what OBS shows
 * them ("Show Connect Info" prints a full `ws://…:4455` URL) and people type
 * `192.168.0.5:4455`. Accepting those is one small function; rejecting them is a
 * support burden. IPv6 is handled because `::1` is a legitimate loopback address that
 * MUST be bracketed in a URL or the `:1` reads as a port.
 *
 * PURE and TOTAL: never throws. A blank/garbage host yields
 * `{ secure: false, hostname: '', port: null }`; callers substitute their own default.
 */
export function parseObsHost(host: string): ParsedObsHost {
  let rest = host.trim()

  const scheme = SCHEME_PATTERN.exec(rest)
  const secure = scheme !== null && /^(wss|https)$/i.test(scheme[1] ?? '')
  if (scheme !== null) rest = rest.slice(scheme[0].length)

  // Drop any path/query/fragment: "127.0.0.1:4455/" and "…?token=x" both appear in
  // pasted URLs and neither is part of the authority.
  const authorityEnd = rest.search(/[/?#]/)
  if (authorityEnd !== -1) rest = rest.slice(0, authorityEnd)

  // Strip credentials ("user:pass@host") before any colon handling, otherwise the
  // password's colon would be mistaken for a port separator.
  const at = rest.lastIndexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)

  let port: number | null = null

  if (rest.startsWith('[')) {
    // Bracketed IPv6, optionally followed by ":port".
    const close = rest.indexOf(']')
    if (close !== -1) {
      const after = rest.slice(close + 1)
      if (after.startsWith(':')) port = toPort(after.slice(1))
      rest = rest.slice(1, close)
    } else {
      rest = rest.slice(1)
    }
  } else {
    const colons = countColons(rest)
    if (colons === 1) {
      // Exactly one colon: unambiguously host:port. (A bare IPv6 address always has
      // at least two, so this cannot misread `::1`.)
      const index = rest.indexOf(':')
      port = toPort(rest.slice(index + 1))
      rest = rest.slice(0, index)
    }
    // Two or more colons: a bare IPv6 literal. Leave it whole - there is no way to
    // tell a trailing group from a port without brackets, and the address wins.
  }

  // A trailing dot is the DNS root label; "localhost." is the same host as "localhost".
  const hostname = rest.trim().toLowerCase().replace(/\.$/, '')
  return { secure, hostname, port }
}

function countColons(value: string): number {
  let count = 0
  for (const char of value) {
    if (char === ':') count++
  }
  return count
}

/** Parses a port, returning null unless it is an integer in 1..65535. */
function toPort(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null
}

/** True when `hostname` is a bare IPv6 literal and therefore needs URL brackets. */
function needsBrackets(hostname: string): boolean {
  return hostname.includes(':')
}

/**
 * Builds the websocket URL `connect()` is given, e.g. `ws://127.0.0.1:4455`.
 *
 * Rules, in priority order:
 *  1. A scheme in `host` is honoured (`wss://`/`https://` -> `wss`, else `ws`).
 *  2. A port in `host` beats the `port` argument - if someone typed
 *     `192.168.0.5:4456` they meant 4456, whatever the port box says.
 *  3. A blank host becomes {@link DEFAULT_OBS_HOST}; an out-of-range or non-integer
 *     port becomes {@link DEFAULT_OBS_PORT}.
 *  4. Bare IPv6 literals are bracketed.
 *
 * PURE and TOTAL: never throws, always returns a well-formed `ws(s)://host:port`.
 */
export function buildObsUrl(host: string, port: number): string {
  const parsed = parseObsHost(host)
  const hostname = parsed.hostname === '' ? DEFAULT_OBS_HOST : parsed.hostname
  const resolvedPort = parsed.port ?? (Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_OBS_PORT)
  const scheme = parsed.secure ? 'wss' : 'ws'
  const authority = needsBrackets(hostname) ? `[${hostname}]` : hostname
  return `${scheme}://${authority}:${resolvedPort}`
}

// ---------------------------------------------------------------------------
// isLocalHost (pure)
// ---------------------------------------------------------------------------

/** `127.0.0.0/8` - the whole IPv4 loopback block, not just `127.0.0.1`. */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Every spelling of the IPv6 loopback address, including the IPv4-mapped forms. */
const IPV6_LOOPBACK = new Set(['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001'])

/**
 * True when `host` names THIS machine, i.e. when a path OBS reports is a path this
 * process can actually open.
 *
 * `clip-library.ts` uses `!isLocalHost(host)` as its `isRemoteObs` flag, and the two
 * failure modes are not symmetric:
 *  - a FALSE NEGATIVE (calling a local OBS remote) costs the user a manual copy and a
 *    clear explanatory note on the clip record;
 *  - a FALSE POSITIVE (calling a remote OBS local) means we take a path that is valid
 *    on the streaming PC, resolve it against THIS filesystem, and potentially rename
 *    or overwrite a completely unrelated file.
 * So this is deliberately conservative: only genuine loopback names qualify. The
 * machine's own LAN address (`192.168.x.x`) returns FALSE even though it does reach
 * the same box, because from here it is indistinguishable from a second PC.
 *
 * `""` counts as local: a blank host means "use the default", and the default is
 * {@link DEFAULT_OBS_HOST}.
 *
 * PURE and TOTAL: never throws. Accepts full URLs and `host:port` forms.
 */
export function isLocalHost(host: string): boolean {
  const { hostname } = parseObsHost(host)
  if (hostname === '') return true
  if (hostname === 'localhost') return true
  if (IPV6_LOOPBACK.has(hostname)) return true
  if (hostname.startsWith('::ffff:')) return IPV4_LOOPBACK.test(hostname.slice('::ffff:'.length))
  return IPV4_LOOPBACK.test(hostname)
}

// ---------------------------------------------------------------------------
// Error inspection (pure)
// ---------------------------------------------------------------------------

/**
 * The `code` off an `OBSWebSocketError`, or null.
 *
 * DUCK-TYPED rather than `instanceof OBSWebSocketError`. Two reasons: the class
 * identity does not survive every bundling arrangement Electron can produce, and
 * duck-typing lets the tests pass plain objects instead of importing the library.
 *
 * PURE and TOTAL: never throws, for any input including null and primitives.
 */
export function obsErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === 'number' && Number.isFinite(code) ? code : null
}

/**
 * A message for any thrown value: `Error.message`, a plain string, or `""`.
 *
 * PURE and TOTAL: never throws.
 */
export function obsErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (typeof error === 'object' && error !== null) {
    const message: unknown = (error as { message?: unknown }).message
    if (typeof message === 'string') return message.trim()
  }
  return ''
}

/**
 * Why a connection failed or died, at the granularity a user can act on.
 *
 * Distinct from {@link ObsError}: that describes a failed OPERATION on a live client,
 * this describes the SOCKET. The three the task cares about - refused, auth, timeout -
 * are the three a "Test connection" button has to tell apart.
 */
export type ObsFailureKind =
  | 'connection-refused'
  | 'auth-failed'
  | 'timeout'
  | 'host-unreachable'
  | 'unsupported-rpc-version'
  | 'closed-by-obs'
  | 'unknown'

/** Node/libuv error codes, matched as whole words inside the message. */
const REFUSED_PATTERN = /\bECONNREFUSED\b/i
const TIMEOUT_PATTERN = /\b(ETIMEDOUT|ESOCKETTIMEDOUT)\b|timed out|timeout/i
const UNREACHABLE_PATTERN = /\b(ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN)\b/i
const RESET_PATTERN = /\b(ECONNRESET|EPIPE)\b/i

/**
 * Classifies a connect failure or a mid-session drop.
 *
 * Close codes are checked BEFORE message text because they are authoritative: OBS
 * closes with 4009 for a bad password whatever the accompanying reason string says.
 * Message matching is the fallback for transport-level failures, which never reach
 * the obs-websocket protocol at all and arrive with `code === -1` (socket error) or
 * `code === 1006` (abnormal close).
 *
 * PURE and TOTAL: never throws, for any input.
 */
export function classifyObsFailure(error: unknown): ObsFailureKind {
  const code = obsErrorCode(error)
  const message = obsErrorMessage(error)

  switch (code) {
    case CLOSE_AUTHENTICATION_FAILED:
      return 'auth-failed'
    case CLOSE_UNSUPPORTED_RPC_VERSION:
      return 'unsupported-rpc-version'
    case CLOSE_NORMAL:
    case CLOSE_GOING_AWAY:
    case CLOSE_SESSION_INVALIDATED:
      return 'closed-by-obs'
    default:
      break
  }

  if (REFUSED_PATTERN.test(message)) return 'connection-refused'
  if (UNREACHABLE_PATTERN.test(message)) return 'host-unreachable'
  if (TIMEOUT_PATTERN.test(message)) return 'timeout'
  if (RESET_PATTERN.test(message)) return 'closed-by-obs'

  // 1006 with nothing to say is what both `ws` and browsers produce when the TCP
  // connection never came up (or died without a close frame). For a desktop app
  // talking to a local OBS that overwhelmingly means "OBS is not listening".
  if (code === CLOSE_ABNORMAL && message === '') return 'connection-refused'

  return 'unknown'
}

/**
 * A sentence the settings UI can show verbatim, naming the fix where there is one.
 *
 * Covers both phases - a failed connect and a dropped connection - because the
 * classification already distinguishes them (`connection-refused` cannot happen to an
 * established socket, `closed-by-obs` cannot happen during a connect).
 *
 * PURE and TOTAL: never throws. Never includes the password.
 */
export function describeObsFailure(error: unknown, host: string, port: number): string {
  const target = `${host.trim() === '' ? DEFAULT_OBS_HOST : host.trim()}:${port}`
  const detail = obsErrorMessage(error)

  switch (classifyObsFailure(error)) {
    case 'connection-refused':
      return (
        `Nothing is listening at ${target}. Check that OBS Studio is running, that ` +
        'Tools > WebSocket Server Settings > Enable WebSocket server is ticked, and that the ' +
        'port matches the one shown there.'
      )
    case 'auth-failed':
      return (
        'OBS rejected the password. Copy it again from Tools > WebSocket Server Settings > ' +
        'Show Connect Info, or untick Enable Authentication and clear the password here.'
      )
    case 'timeout':
      return (
        `Timed out connecting to ${target}. OBS may be busy starting up, or a firewall is ` +
        'dropping the connection rather than refusing it.'
      )
    case 'host-unreachable':
      return `Could not reach the host ${target}. Check the address is spelled correctly and that the machine is on.`
    case 'unsupported-rpc-version':
      return (
        `OBS at ${target} does not support obs-websocket RPC version ${OBS_RPC_VERSION}. ` +
        'Update OBS Studio to 28 or newer (obs-websocket 5.x).'
      )
    case 'closed-by-obs':
      return `OBS at ${target} closed the connection. It was probably shut down, or its WebSocket server was turned off.`
    case 'unknown':
      return detail === ''
        ? `The connection to OBS at ${target} failed, with no reason given.`
        : `The connection to OBS at ${target} failed: ${detail}`
  }
}

// ---------------------------------------------------------------------------
// ObsError
// ---------------------------------------------------------------------------

/** No live, identified socket. The operation was not attempted. */
export interface ObsNotConnectedError {
  readonly kind: 'not-connected'
  readonly message: string
}

/** OBS rejected our credentials (close code 4009). */
export interface ObsAuthFailedError {
  readonly kind: 'auth-failed'
  readonly message: string
}

/** The replay buffer is not running, so there is nothing to save (RequestStatus 501). */
export interface ObsBufferInactiveError {
  readonly kind: 'buffer-inactive'
  readonly message: string
}

/**
 * `SaveReplayBuffer` was accepted but no `ReplayBufferSaved` event arrived in time.
 * The clip may still land on disk later - this means "we do not know where", not
 * "nothing was written".
 */
export interface ObsSaveTimeoutError {
  readonly kind: 'save-timeout'
  readonly message: string
  readonly timeoutMs: number
}

/** Anything else: a non-success RequestStatus, or a request that never came back. */
export interface ObsRequestFailedError {
  readonly kind: 'request-failed'
  readonly message: string
  /** obs-websocket RequestStatus code, or null when the request simply timed out. */
  readonly code: number | null
  /** The request that failed, e.g. `"SaveReplayBuffer"`. */
  readonly requestType: string
}

/**
 * Everything an {@link ObsClient} operation can fail with. Switch on `kind`.
 *
 * `message` is always human-readable and always safe to show; none of these carry the
 * password or a stack trace.
 */
export type ObsError =
  | ObsNotConnectedError
  | ObsAuthFailedError
  | ObsBufferInactiveError
  | ObsSaveTimeoutError
  | ObsRequestFailedError

/** Discriminant of {@link ObsError}. */
export type ObsErrorKind = ObsError['kind']

/**
 * Result union used by the operations that can fail for expected reasons.
 *
 * A result rather than a rejection, for the same reason `ObsTestResult` is: "the
 * replay buffer is off" is an ordinary outcome on the death path, and that path runs
 * inside an event-bus listener where a rejection would become an unhandled rejection.
 */
export type ObsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ObsError }

/**
 * Maps a thrown request failure onto an {@link ObsError}.
 *
 * `requestType` scopes the interpretation: RequestStatus 501 (`OutputNotRunning`)
 * means "replay buffer inactive" for a replay-buffer request and nothing so specific
 * for anything else.
 *
 * PURE and TOTAL: never throws.
 */
export function mapRequestFailure(requestType: string, error: unknown): ObsError {
  const code = obsErrorCode(error)
  const detail = obsErrorMessage(error)

  if (code === CLOSE_AUTHENTICATION_FAILED) {
    return { kind: 'auth-failed', message: describeObsFailure(error, DEFAULT_OBS_HOST, DEFAULT_OBS_PORT) }
  }

  if (code === STATUS_OUTPUT_NOT_RUNNING && requestType.includes('ReplayBuffer')) {
    return {
      kind: 'buffer-inactive',
      message:
        'The OBS replay buffer is not running, so there was nothing to save. Start it in OBS ' +
        '(Controls > Start Replay Buffer) or enable Settings > Output > Replay Buffer.'
    }
  }

  return {
    kind: 'request-failed',
    message:
      detail === ''
        ? `The OBS request ${requestType} failed${code === null ? '' : ` (code ${code})`}.`
        : `The OBS request ${requestType} failed${code === null ? '' : ` (code ${code})`}: ${detail}`,
    code,
    requestType
  }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Connection parameters. Structurally the IPC `ObsTestRequest`, aliased rather than
 * redeclared so the two cannot drift apart.
 */
export type ObsConnectionConfig = ObsTestRequest

/** Extra behaviour for {@link ObsClient.connect}. */
export interface ObsConnectOptions {
  /**
   * Keep retrying with capped exponential backoff after a failed attempt or a drop.
   * Mirrors `settings.obs.autoConnect`. Defaults to false - retrying is opt-in, so a
   * one-shot manual connect stays one-shot.
   */
  readonly autoReconnect: boolean
}

/** Where and when OBS wrote a replay clip. */
export interface SavedReplay {
  /**
   * Absolute path ON THE MACHINE RUNNING OBS. Use {@link isLocalHost} on the
   * configured host before assuming this process can open it.
   */
  readonly savedReplayPath: string
  /** `Date.now()` when the `ReplayBufferSaved` event arrived. */
  readonly savedAt: number
}

/**
 * Channels {@link ObsClient} emits on.
 *
 * Only connection state. `ReplayBufferSaved` is deliberately NOT re-broadcast: it
 * also fires for saves the user triggered with an OBS hotkey, and a clipper listening
 * to both a broadcast and `saveReplayBuffer()`'s return value would process the same
 * clip twice. The return value is the app's ONLY route to a clip path - with the
 * correlation limits {@link ObsClient.saveReplayBuffer} documents.
 */
export interface ObsClientEventMap {
  /** Emitted on every state transition, including transitions between error states. */
  state: [ObsConnectionState]
}

/**
 * The obs-websocket events this client subscribes to, with their payload shapes.
 *
 * Hand-written rather than imported so {@link ObsSocket} stays a small structural
 * type a test can implement; the shapes are the ones in the library's `OBSEventTypes`.
 */
export interface ObsSocketEventMap {
  ReplayBufferSaved: { savedReplayPath: string }
  ReplayBufferStateChanged: { outputActive: boolean; outputState: string }
  ConnectionClosed: OBSWebSocketError
  ConnectionError: OBSWebSocketError
}

/**
 * The slice of `OBSWebSocket` this client drives.
 *
 * `OBSWebSocket` satisfies this structurally, so production passes the real class
 * unchanged. It exists so tests can drive the save/event correlation - the whole
 * point of {@link ObsClient.saveReplayBuffer} - without a live OBS, which is
 * otherwise untestable and was where a real bug hid.
 */
export interface ObsSocket {
  connect(
    url?: string,
    password?: string,
    identificationParams?: { rpcVersion?: number; eventSubscriptions?: number }
  ): Promise<unknown>
  disconnect(): Promise<void>
  call<Type extends keyof OBSRequestTypes>(
    requestType: Type,
    requestData?: OBSRequestTypes[Type]
  ): Promise<OBSResponseTypes[Type]>
  // Spelled out as overloads rather than one generic signature: eventemitter3's
  // `on` is generic over its whole (66-member) event map, and TypeScript cannot
  // relate that to a generic signature narrowed to four of them. Per-event
  // overloads instantiate concretely, so the real class satisfies this.
  on(event: 'ReplayBufferSaved', listener: (payload: ObsSocketEventMap['ReplayBufferSaved']) => void): unknown
  on(
    event: 'ReplayBufferStateChanged',
    listener: (payload: ObsSocketEventMap['ReplayBufferStateChanged']) => void
  ): unknown
  on(event: 'ConnectionClosed', listener: (payload: ObsSocketEventMap['ConnectionClosed']) => void): unknown
  on(event: 'ConnectionError', listener: (payload: ObsSocketEventMap['ConnectionError']) => void): unknown
  off(event: 'ReplayBufferSaved', listener: (payload: ObsSocketEventMap['ReplayBufferSaved']) => void): unknown
  removeAllListeners(): unknown
}

/**
 * How many recently reported clip paths are remembered, so a late or duplicated
 * `ReplayBufferSaved` cannot be handed to a later save as if it were its own.
 *
 * Bounded because the process runs for days: 32 is far more than the number of saves
 * that can be in flight at once (the clipper serialises them and debounces to one
 * per 5s), and costs a few hundred bytes.
 */
const MAX_REMEMBERED_SAVES = 32

/** Constructor extras. All optional; the defaults are the production behaviour. */
export interface ObsClientOptions {
  /** Cap on connect + identify. Defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  readonly connectTimeoutMs?: number
  /** Cap on a single request. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number
  /** Cap on waiting for `ReplayBufferSaved`. Defaults to {@link DEFAULT_SAVE_TIMEOUT_MS}. */
  readonly saveTimeoutMs?: number
  /** Reconnect curve. Defaults to {@link DEFAULT_BACKOFF}. */
  readonly backoff?: BackoffOptions
  /**
   * Called when a listener or a logger throws somewhere this class swallowed it.
   * Purely diagnostic - the default is a no-op, and a hook that throws is ignored.
   */
  readonly onInternalError?: (error: unknown, context: string) => void
  /**
   * Builds the underlying socket. Defaults to `new OBSWebSocket()`. A TEST SEAM, not
   * a production knob - see {@link ObsSocket}.
   */
  readonly createSocket?: () => ObsSocket
}

// ---------------------------------------------------------------------------
// Timeout plumbing
// ---------------------------------------------------------------------------

/** Result of racing a promise against a timer. */
type Timed<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true }

/**
 * Races `promise` against `ms`, ALWAYS clearing the timer.
 *
 * On timeout the underlying promise is left pending; that is safe because
 * `Promise.race` has already attached handlers to it, so a later rejection is
 * "handled" and cannot surface as an unhandled rejection and kill the process.
 *
 * A rejection that arrives before the timeout propagates to the caller unchanged.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<Timed<T>>([
      promise.then((value): Timed<T> => ({ timedOut: false, value })),
      new Promise<Timed<T>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ timedOut: true })
        }, ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Detaches every listener and closes `socket`, swallowing everything.
 *
 * Timeout-capped because `disconnect()` awaits a `ConnectionClosed` that a
 * half-dead socket may never produce, and teardown sits directly in front of the
 * next reconnect attempt.
 */
async function closeQuietly(socket: ObsSocket): Promise<void> {
  try {
    socket.removeAllListeners()
  } catch {
    // A failing removeAllListeners must not stop us from closing the socket.
  }
  try {
    await withTimeout(socket.disconnect(), TEARDOWN_TIMEOUT_MS)
  } catch {
    // Already closed, never opened, or rejected on the way down - all fine.
  }
}

// ---------------------------------------------------------------------------
// ObsClient
// ---------------------------------------------------------------------------

/**
 * One OBS connection, with optional auto-reconnect.
 *
 * ```ts
 * const obs = new ObsClient()
 * obs.on('state', (state) => window.webContents.send(IPC_PUSH.OBS_STATUS, state))
 * await obs.connect(settings.obs, { autoReconnect: settings.obs.autoConnect })
 *
 * const saved = await obs.saveReplayBuffer()
 * if (saved.ok) await clipLibrary.moveClip({ sourcePath: saved.value.savedReplayPath, ... })
 * else console.warn(saved.error.message)
 * ```
 *
 * NO PUBLIC METHOD REJECTS. `connect` resolves with the state it settled in,
 * `testConnection` resolves with a result union, `saveReplayBuffer` and
 * `getReplayBufferStatus` resolve with {@link ObsResult}, and `disconnect` resolves
 * once the socket is down however that went.
 */
export class ObsClient {
  readonly #emitter = new TypedEmitter<ObsClientEventMap>()
  readonly #connectTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #saveTimeoutMs: number
  readonly #backoff: BackoffOptions
  readonly #onInternalError: (error: unknown, context: string) => void
  readonly #createSocket: () => ObsSocket

  /**
   * Clip paths this client has already handed to (or consumed on behalf of) a save,
   * newest last. See {@link saveReplayBuffer}: without this, a `ReplayBufferSaved`
   * that arrived late for an abandoned save would be claimed by the NEXT save, which
   * then renames someone else's clip into the library under the wrong death's name.
   */
  readonly #claimedPaths = new Set<string>()
  readonly #claimOrder: string[] = []

  #state: ObsConnectionState = { state: 'disconnected', since: Date.now() }
  #config: ObsConnectionConfig | null = null
  #autoReconnect = false

  /** The live, identified socket. Only ever set after connect AND identify succeeded. */
  #socket: ObsSocket | null = null
  /** The socket of an attempt still in flight. Held only so `disconnect()` can kill it. */
  #pending: ObsSocket | null = null

  /** Bumped by every connect, disconnect and detected drop. See the file header. */
  #generation = 0
  /** Consecutive failed attempts; drives {@link backoffDelayMs}. Reset on success. */
  #attempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(options: ObsClientOptions = {}) {
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#saveTimeoutMs = options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF
    this.#onInternalError = options.onInternalError ?? ((): void => undefined)
    this.#createSocket = options.createSocket ?? ((): ObsSocket => new OBSWebSocket())
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** Current connection state. Cheap - this is a stored value, not a probe. */
  get state(): ObsConnectionState {
    return this.#state
  }

  /** True when there is a live, identified socket to make requests on. */
  get connected(): boolean {
    return this.#socket !== null && this.#state.state === 'connected'
  }

  /**
   * True when OBS is (or would be) on another machine, i.e. paths it reports are not
   * this filesystem's. Feed straight into `ClipLibrary.moveClip({ isRemoteObs })`.
   *
   * False when nothing has been configured yet - there is no remote host to worry
   * about, and nothing will be clipped anyway.
   */
  get isRemoteObs(): boolean {
    const config = this.#config
    return config !== null && !isLocalHost(config.host)
  }

  /** Subscribes to a channel. Mirrors `TypedEmitter.on`. */
  on<K extends keyof ObsClientEventMap>(channel: K, listener: EventListener<ObsClientEventMap, K>): this {
    this.#emitter.on(channel, listener)
    return this
  }

  /** Removes one registration of `listener`. Mirrors `TypedEmitter.off`. */
  off<K extends keyof ObsClientEventMap>(channel: K, listener: EventListener<ObsClientEventMap, K>): this {
    this.#emitter.off(channel, listener)
    return this
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connects (or reconnects) to OBS, replacing any existing connection.
   *
   * NEVER REJECTS. Resolves with the state it ended in: `connected` on success,
   * `error` on failure (with `willRetry` telling you whether a retry is already
   * scheduled), or `disconnected` if something cancelled the attempt mid-flight.
   *
   * Calling this while connected is the correct way to apply changed settings: the
   * old socket is torn down first and the attempt counter resets, so a user fixing
   * their password does not inherit a 30s backoff.
   */
  async connect(cfg: ObsConnectionConfig, options?: ObsConnectOptions): Promise<ObsConnectionState> {
    if (this.#disposed) return this.#state
    this.#config = { host: cfg.host, port: cfg.port, password: cfg.password }
    this.#autoReconnect = options?.autoReconnect ?? false
    // A user-initiated connect is a fresh start, not a continuation of a retry chain.
    this.#attempt = 0
    return this.#attemptConnect()
  }

  /**
   * Closes the connection and STOPS the retry loop.
   *
   * Cancels any pending reconnect timer and bumps the generation, so an attempt that
   * is mid-flight tears its own socket down and publishes nothing. Idempotent.
   */
  async disconnect(): Promise<void> {
    this.#autoReconnect = false
    this.#generation += 1
    this.#clearReconnectTimer()

    const sockets = [this.#socket, this.#pending].filter((s): s is ObsSocket => s !== null)
    this.#socket = null
    this.#pending = null
    this.#attempt = 0

    for (const socket of sockets) {
      await closeQuietly(socket)
    }

    if (!this.#disposed) this.#setState({ state: 'disconnected', since: Date.now() })
  }

  /**
   * Permanent shutdown: disconnects, drops every subscriber, and makes all further
   * calls no-ops. Call from the app's `before-quit`.
   */
  async dispose(): Promise<void> {
    await this.disconnect()
    this.#disposed = true
    this.#emitter.removeAllListeners()
  }

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  /**
   * One-shot credential check on a THROWAWAY socket.
   *
   * Deliberately does not touch `#socket`, `#config`, the state machine or the retry
   * loop, so the "Test connection" button is safe to press while a clip-worthy fight
   * is going on. The throwaway identifies with `EventSubscription.None`, so it also
   * cannot receive - and therefore cannot race us for - a `ReplayBufferSaved` event.
   *
   * NEVER THROWS. Failures come back as `{ ok: false, error }` with a message that
   * distinguishes connection refused (OBS not running / websocket server disabled),
   * auth failure (wrong password) and timeout.
   */
  async testConnection(cfg: ObsConnectionConfig): Promise<ObsTestResult> {
    const socket = this.#createSocket()
    const url = buildObsUrl(cfg.host, cfg.port)

    try {
      const connected = await withTimeout(
        socket.connect(url, cfg.password, {
          rpcVersion: OBS_RPC_VERSION,
          eventSubscriptions: EventSubscription.None
        }),
        this.#connectTimeoutMs
      )
      if (connected.timedOut) {
        return { ok: false, error: describeObsFailure(new Error('ETIMEDOUT'), cfg.host, cfg.port) }
      }

      // `connect()` reports `obsWebSocketVersion` but not the OBS Studio version, so
      // GetVersion is a real round trip, not decoration - and it doubles as proof the
      // session is actually usable rather than merely open.
      const version = await withTimeout(socket.call('GetVersion'), this.#requestTimeoutMs)
      if (version.timedOut) {
        return {
          ok: false,
          error: `Connected to OBS at ${url}, but it did not answer GetVersion within ${this.#requestTimeoutMs}ms.`
        }
      }

      return {
        ok: true,
        obsVersion: version.value.obsVersion,
        websocketVersion: version.value.obsWebSocketVersion
      }
    } catch (error) {
      return { ok: false, error: describeObsFailure(error, cfg.host, cfg.port) }
    } finally {
      await closeQuietly(socket)
    }
  }

  // -------------------------------------------------------------------------
  // Replay buffer
  // -------------------------------------------------------------------------

  /**
   * Whether OBS reports the replay buffer as running.
   *
   * NEVER THROWS, and answers `false` for every failure - not connected, request
   * failed, request timed out. Use {@link getReplayBufferStatus} when you need to
   * tell "off" from "could not ask".
   */
  async isReplayBufferActive(): Promise<boolean> {
    const result = await this.getReplayBufferStatus()
    return result.ok && result.value
  }

  /**
   * `GetReplayBufferStatus` -> `outputActive`, with the failure reason preserved.
   *
   * Also refreshes the cached `replayBufferActive` on the connected state, so the UI
   * updates as a side effect of anyone asking.
   */
  async getReplayBufferStatus(): Promise<ObsResult<boolean>> {
    const socket = this.#liveSocket()
    if (socket === null) return { ok: false, error: this.#notConnected('check the replay buffer') }

    const result = await this.#call(socket, 'GetReplayBufferStatus')
    if (!result.ok) return result

    this.#updateReplayBufferActive(socket, result.value.outputActive)
    return { ok: true, value: result.value.outputActive }
  }

  /**
   * Saves the replay buffer and resolves with the path OBS wrote.
   *
   * THE RACE THIS METHOD EXISTS TO AVOID
   * ------------------------------------
   * In obs-websocket v5 the `SaveReplayBuffer` RESPONSE CARRIES NO FILENAME - its
   * response type is literally `undefined`. The path only ever arrives on the
   * separate, asynchronous `ReplayBufferSaved` event. That event can be emitted and
   * dispatched BEFORE the request response is delivered, so registering the listener
   * after `await call(...)` loses the path outright and every save then reports a
   * `save-timeout`. Hence: listener first, request second.
   *
   * The listener is removed once the save is settled, so repeated deaths cannot pile
   * up listeners on the socket (obs-websocket-js does not cap them, and a leak here
   * would mean every past save's handler firing on every new one).
   *
   * WHAT CORRELATION IS AND IS NOT POSSIBLE
   * ---------------------------------------
   * obs-websocket v5 puts NO request id on `ReplayBufferSaved`, so "is this event
   * mine?" cannot be answered exactly. Two guards make the answer safe rather than
   * merely optimistic:
   *
   *  1. A PATH IS CLAIMED ONCE. Every path handed back is remembered
   *     ({@link MAX_REMEMBERED_SAVES}), and an event repeating a claimed path is
   *     ignored. OBS timestamps clip filenames, so a repeat means "already dealt
   *     with", never "a second, different clip".
   *  2. AN ABANDONED SAVE CLEANS UP AFTER ITSELF. When this call gives up (the
   *     request failed, or the file never got reported), the listener stays attached
   *     for one more save window in ORPHAN mode: if the straggler finally arrives it
   *     is claimed and discarded here instead of being handed to the next death's
   *     save. The request itself is capped at the SAVE timeout rather than the much
   *     shorter request timeout, so a busy OBS that acknowledges slowly does not get
   *     abandoned in the first place.
   *
   * WHAT REMAINS AMBIGUOUS, DELIBERATELY UNRESOLVED: a save the user triggered with
   * their own OBS hotkey a moment before the death line lands. Its `ReplayBufferSaved`
   * is indistinguishable from ours - same shape, no id, and it may legitimately arrive
   * before our request is even acknowledged - so this call can return the user's
   * manual clip. It is then moved into the library like any other clip; nothing is
   * lost, but it may be the wrong footage under the right name.
   *
   * NEVER THROWS. `buffer-inactive` (RequestStatus 501) is the expected answer when
   * the user has not started the replay buffer; `save-timeout` means the request was
   * accepted but OBS never reported a path - the clip may still exist, we just do not
   * know where.
   */
  async saveReplayBuffer(): Promise<ObsResult<SavedReplay>> {
    const socket = this.#liveSocket()
    if (socket === null) return { ok: false, error: this.#notConnected('save a replay clip') }

    // Executors run synchronously, so `resolveSaved` is always replaced before any
    // event can fire; the initial no-op only exists to satisfy definite assignment.
    let resolveSaved: (path: string) => void = (): void => undefined
    const savedPath = new Promise<string>((resolve) => {
      resolveSaved = resolve
    })

    // 'waiting' - this call still wants a path.
    // 'orphan'  - we gave up; consume a straggler so nobody else claims it.
    // 'done'    - detached; ignore everything.
    let phase: 'waiting' | 'orphan' | 'done' = 'waiting'
    let orphanTimer: ReturnType<typeof setTimeout> | null = null

    const detach = (): void => {
      phase = 'done'
      if (orphanTimer !== null) {
        clearTimeout(orphanTimer)
        orphanTimer = null
      }
      try {
        socket.off('ReplayBufferSaved', onSaved)
      } catch (error) {
        this.#report(error, 'ReplayBufferSaved-off')
      }
    }

    const onSaved = this.#guard('ReplayBufferSaved', (payload: { savedReplayPath: string }): void => {
      const savedReplayPath = payload.savedReplayPath
      if (phase === 'done') return
      // Someone already took responsibility for this exact file.
      if (this.#claimedPaths.has(savedReplayPath)) return
      this.#claim(savedReplayPath)
      if (phase === 'waiting') {
        phase = 'done'
        resolveSaved(savedReplayPath)
        return
      }
      // Orphan mode: the straggler for a save we already gave up on. Claimed above
      // (so no later save can adopt it) and dropped here.
      detach()
    })

    // REGISTER BEFORE THE CALL - see the method doc.
    socket.on('ReplayBufferSaved', onSaved)
    try {
      // The SAVE timeout, not the request timeout: abandoning a slow-but-accepted
      // request is what leaves an orphaned event looking for an owner.
      const requested = await this.#call(socket, 'SaveReplayBuffer', this.#saveTimeoutMs)
      if (!requested.ok) return requested

      const saved = await withTimeout(savedPath, this.#saveTimeoutMs)
      if (saved.timedOut) {
        return {
          ok: false,
          error: {
            kind: 'save-timeout',
            message:
              `OBS accepted the save but did not report a file within ${this.#saveTimeoutMs}ms. ` +
              'The clip may still have been written - check the OBS recording folder.',
            timeoutMs: this.#saveTimeoutMs
          }
        }
      }

      return { ok: true, value: { savedReplayPath: saved.value, savedAt: Date.now() } }
    } finally {
      if (phase === 'waiting') {
        // Gave up without a path. Keep listening just long enough to swallow a late
        // event for THIS save, then detach unconditionally so nothing leaks.
        phase = 'orphan'
        const timer = setTimeout(detach, this.#saveTimeoutMs)
        if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
        orphanTimer = timer
      } else {
        detach()
      }
    }
  }

  /** Remembers a path as spoken for, evicting the oldest beyond the cap. */
  #claim(savedReplayPath: string): void {
    if (this.#claimedPaths.has(savedReplayPath)) return
    this.#claimedPaths.add(savedReplayPath)
    this.#claimOrder.push(savedReplayPath)
    while (this.#claimOrder.length > MAX_REMEMBERED_SAVES) {
      const evicted = this.#claimOrder.shift()
      if (evicted !== undefined) this.#claimedPaths.delete(evicted)
    }
  }

  // -------------------------------------------------------------------------
  // Internals: connecting
  // -------------------------------------------------------------------------

  /**
   * One connect attempt. Owns the whole transition from `connecting` to either
   * `connected` or `error`, and schedules the retry when appropriate.
   */
  async #attemptConnect(): Promise<ObsConnectionState> {
    const config = this.#config
    if (this.#disposed || config === null) return this.#state

    const generation = ++this.#generation
    this.#clearReconnectTimer()

    // Tear down whatever was there. Anything that survives this has a stale
    // generation and will refuse to touch shared state.
    const stale = [this.#socket, this.#pending].filter((s): s is ObsSocket => s !== null)
    this.#socket = null
    this.#pending = null
    for (const old of stale) {
      await closeQuietly(old)
    }
    if (generation !== this.#generation) return this.#state

    this.#attempt += 1
    const socket = this.#createSocket()
    this.#pending = socket
    this.#setState({
      state: 'connecting',
      host: config.host,
      port: config.port,
      since: Date.now(),
      attempt: this.#attempt
    })

    try {
      const url = buildObsUrl(config.host, config.port)
      const opened = await withTimeout(
        socket.connect(url, config.password, {
          rpcVersion: OBS_RPC_VERSION,
          eventSubscriptions: LIVE_EVENT_SUBSCRIPTIONS
        }),
        this.#connectTimeoutMs
      )
      if (generation !== this.#generation) {
        await closeQuietly(socket)
        return this.#state
      }
      if (opened.timedOut) {
        await closeQuietly(socket)
        return this.#fail(generation, new Error('ETIMEDOUT'), config)
      }

      // Attach the drop handlers BEFORE the GetVersion round trip: OBS quitting in
      // that window would otherwise leave us with a dead socket and no notification,
      // since a request in flight when the socket dies never settles at all.
      this.#attachLiveListeners(socket, generation)

      const version = await withTimeout(socket.call('GetVersion'), this.#requestTimeoutMs)
      if (generation !== this.#generation) {
        await closeQuietly(socket)
        return this.#state
      }
      if (version.timedOut) {
        await closeQuietly(socket)
        return this.#fail(generation, new Error(`OBS did not answer GetVersion within ${this.#requestTimeoutMs}ms`), config)
      }

      this.#pending = null
      this.#socket = socket
      this.#attempt = 0
      this.#setState({
        state: 'connected',
        host: config.host,
        port: config.port,
        obsVersion: version.value.obsVersion,
        websocketVersion: version.value.obsWebSocketVersion,
        since: Date.now(),
        // Unknown until we ask - which we do immediately below, off the hot path.
        replayBufferActive: null
      })

      // Fire-and-forget: knowing the buffer state is a UI nicety, and blocking the
      // connect on it would delay the point at which clipping becomes possible.
      void this.getReplayBufferStatus().catch((error: unknown) => {
        this.#report(error, 'initial-replay-buffer-status')
      })

      return this.#state
    } catch (error) {
      await closeQuietly(socket)
      return this.#fail(generation, error, config)
    }
  }

  /** Publishes an `error` state for a failed attempt and schedules the retry. */
  #fail(generation: number, error: unknown, config: ObsConnectionConfig): ObsConnectionState {
    // A drop handler or an explicit disconnect got here first; it owns the outcome.
    if (generation !== this.#generation || this.#disposed) return this.#state

    if (this.#pending !== null) this.#pending = null
    const willRetry = this.#autoReconnect
    this.#setState({
      state: 'error',
      message: describeObsFailure(error, config.host, config.port),
      since: Date.now(),
      willRetry
    })
    if (willRetry) this.#scheduleReconnect()
    return this.#state
  }

  /**
   * Handles `ConnectionClosed`/`ConnectionError` on a socket we already accepted.
   *
   * Bumping the generation here is what makes this idempotent: obs-websocket-js emits
   * `ConnectionError` and then `ConnectionClosed` for the same underlying failure, and
   * the second call sees a stale generation and returns. It also cancels any attempt
   * still in flight, so exactly one retry gets scheduled.
   */
  #handleDrop(socket: ObsSocket, generation: number, error: unknown): void {
    if (this.#disposed || generation !== this.#generation) return
    this.#generation += 1

    if (this.#socket === socket) this.#socket = null
    if (this.#pending === socket) this.#pending = null
    try {
      socket.removeAllListeners()
    } catch {
      // Nothing useful to do; the socket is already gone.
    }

    const config = this.#config
    const willRetry = this.#autoReconnect && config !== null
    this.#setState({
      state: 'error',
      message:
        config === null
          ? describeObsFailure(error, DEFAULT_OBS_HOST, DEFAULT_OBS_PORT)
          : describeObsFailure(error, config.host, config.port),
      since: Date.now(),
      willRetry
    })
    if (willRetry) this.#scheduleReconnect()
  }

  /** Registers the guarded listeners a live socket needs. */
  #attachLiveListeners(socket: ObsSocket, generation: number): void {
    socket.on(
      'ConnectionClosed',
      this.#guard('ConnectionClosed', (error: OBSWebSocketError): void => {
        this.#handleDrop(socket, generation, error)
      })
    )
    socket.on(
      'ConnectionError',
      this.#guard('ConnectionError', (error: OBSWebSocketError): void => {
        this.#handleDrop(socket, generation, error)
      })
    )
    socket.on(
      'ReplayBufferStateChanged',
      this.#guard('ReplayBufferStateChanged', (payload: { outputActive: boolean; outputState: string }): void => {
        this.#updateReplayBufferActive(socket, payload.outputActive)
      })
    )
  }

  // -------------------------------------------------------------------------
  // Internals: reconnect
  // -------------------------------------------------------------------------

  /**
   * Arms the retry timer. At most ONE timer exists at a time - the existing one is
   * always cleared first - so a burst of failures cannot fan out into a burst of
   * attempts, and `disconnect()` only ever has one handle to cancel.
   */
  #scheduleReconnect(): void {
    this.#clearReconnectTimer()
    if (this.#disposed || !this.#autoReconnect || this.#config === null) return

    const generation = this.#generation
    const delay = backoffDelayMs(this.#attempt, this.#backoff)
    const timer = setTimeout(() => {
      this.#reconnectTimer = null
      // Anything that changed the generation while we waited - a manual connect, a
      // disconnect, a dispose - has already superseded this retry.
      if (this.#disposed || !this.#autoReconnect || generation !== this.#generation) return
      void this.#attemptConnect().catch((error: unknown) => {
        this.#report(error, 'reconnect')
      })
    }, delay)

    // A pending retry must not be the reason a plain-node process refuses to exit.
    // (Electron's main process is kept alive by the app itself, so this is a no-op
    // there, and the guard covers hosts where the handle is a plain number.)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    this.#reconnectTimer = timer
  }

  /** Cancels the retry timer if one is armed. Safe to call any number of times. */
  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
  }

  // -------------------------------------------------------------------------
  // Internals: requests and state
  // -------------------------------------------------------------------------

  /** The live socket, or null when there is nothing to make a request on. */
  #liveSocket(): ObsSocket | null {
    if (this.#disposed) return null
    return this.#state.state === 'connected' ? this.#socket : null
  }

  #notConnected(action: string): ObsNotConnectedError {
    return {
      kind: 'not-connected',
      message: `Not connected to OBS, so poe-tool could not ${action}.`
    }
  }

  /**
   * `socket.call()` with a timeout and errors mapped to {@link ObsError}.
   *
   * The timeout is not belt-and-braces: a request in flight when the socket dies is
   * dropped by the library's cleanup and its promise NEVER SETTLES. Without this,
   * losing OBS mid-request would leave an await hanging for the life of the process.
   */
  async #call<Type extends keyof OBSRequestTypes>(
    socket: ObsSocket,
    requestType: Type,
    timeoutMs: number = this.#requestTimeoutMs
  ): Promise<ObsResult<OBSResponseTypes[Type]>> {
    const name = String(requestType)
    try {
      const outcome = await withTimeout(socket.call(requestType), timeoutMs)
      if (outcome.timedOut) {
        return {
          ok: false,
          error: {
            kind: 'request-failed',
            message: `OBS did not answer the ${name} request within ${timeoutMs}ms.`,
            code: null,
            requestType: name
          }
        }
      }
      return { ok: true, value: outcome.value }
    } catch (error) {
      return { ok: false, error: mapRequestFailure(name, error) }
    }
  }

  /** Refreshes `replayBufferActive` on the connected state, if it actually changed. */
  #updateReplayBufferActive(socket: ObsSocket, active: boolean): void {
    if (this.#socket !== socket) return
    const current = this.#state
    if (current.state !== 'connected' || current.replayBufferActive === active) return
    this.#setState({ ...current, replayBufferActive: active })
  }

  /**
   * Stores and publishes a state.
   *
   * The emit is wrapped because `TypedEmitter` deliberately lets listener exceptions
   * propagate to the emitter, and this is called from socket callbacks and timers
   * where there is nobody left to catch them.
   */
  #setState(next: ObsConnectionState): ObsConnectionState {
    this.#state = next
    try {
      this.#emitter.emit('state', next)
    } catch (error) {
      this.#report(error, 'state-listener')
    }
    return next
  }

  /**
   * Wraps a socket listener so a throw inside it can never escape into
   * obs-websocket-js's emit loop (and from there into the main process).
   */
  #guard<A extends unknown[]>(context: string, fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      try {
        fn(...args)
      } catch (error) {
        this.#report(error, context)
      }
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
