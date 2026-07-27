/**
 * src/main/ipc-handlers.ts
 * =======================
 *
 * The main-process half of the wire protocol declared in `src/shared/ipc.ts`.
 *
 * This is one of exactly three files allowed to import `electron` (the others being
 * `src/main/index.ts` and - via an injected directory - `src/main/settings/store.ts`).
 * Everything it orchestrates is electron-free and therefore unit-testable on its own.
 *
 *
 * WHY THE DEPENDENCIES ARE STRUCTURAL PORTS AND NOT CONCRETE CLASSES
 * ------------------------------------------------------------------
 * {@link IpcHandlerDeps} names the *capabilities* this file needs - "give me the
 * current settings", "tell me when a clip lands" - rather than importing
 * `SettingsStore`, `EventBus`, `ObsClient`, `LogWatcher` and `ReplayClipper`. Three
 * concrete reasons:
 *
 *  1. It keeps the IPC layer off the critical path's import graph. Nothing here can
 *     accidentally reach into the tail loop's internals.
 *  2. `src/main/index.ts` owns service construction and lifetimes. If a concrete class
 *     shape does not line up with a port (a `getStatus()` where the port wants a
 *     `status` getter, say), index.ts passes a three-line adapter object literal. That
 *     adaptation belongs in the wiring file, not smeared through the handlers.
 *  3. The real classes satisfy these ports structurally with no `implements` clause
 *     and no runtime cost - `SettingsStore` already IS a `SettingsPort`.
 *
 *
 * EVERY RENDERER PAYLOAD IS UNTRUSTED
 * -----------------------------------
 * `contextIsolation` and a narrow preload bridge make it hard for renderer code to
 * send something unexpected, but "hard" is not "impossible" - a compromised renderer
 * can call `ipcRenderer.invoke` with anything at all, and the preload's types are
 * erased at runtime. So every handler here takes `unknown` and narrows it with the
 * total, never-throwing helpers below before a value reaches a service. In
 * particular `applySettingsPatch` reads `patch.log` directly and would throw a
 * TypeError on a `null` patch, so {@link narrowSettingsPatch} runs first.
 *
 *
 * NOTHING CROSSES IPC AS AN `Error`
 * ---------------------------------
 * Electron serialises a rejected `handle` into
 * `Error: Error invoking remote method 'x': ...` - an opaque string with the original
 * type, code and structure gone. Every handler therefore RESOLVES with a value from
 * the frozen contract and reports failures either as a result union (`ObsTestResult`)
 * or by falling back to the honest current state. Diagnostics go to
 * {@link IpcHandlerDeps.onError}, never to the renderer.
 *
 *
 * A CLOSED WINDOW MUST NOT BREAK THE TAIL LOOP
 * --------------------------------------------
 * The push listeners registered here run INSIDE `TypedEmitter.emit`, which
 * deliberately propagates listener exceptions back to the emitter (see its header).
 * The emitter is fed from the log watcher's tail loop. A `webContents.send` on a
 * destroyed window throws `Object has been destroyed`, so an unguarded send would
 * take down log tailing the moment the user closed the window. {@link makeSender}
 * checks `isDestroyed()` on both the window and its webContents AND wraps the send,
 * because the window can be torn down between the check and the call.
 *
 *
 * A PASSWORD TRAVELS RENDERER -> MAIN, NEVER MAIN -> RENDERER
 * -----------------------------------------------------------
 * THE INVARIANT, in full: the Streamable credential is an ACCOUNT email + password
 * (Streamable has no revocable upload token), this repository is PUBLIC, and the
 * renderer is a real web page - anything that reaches it reaches devtools and any
 * script that ends up running there. So a password crosses this boundary in exactly one
 * direction, and only because the user has just typed it: `settings:set` and
 * `streamable:test` carry one IN. Nothing carries one OUT. Not a result, not a push, not
 * an error message, not a diagnostic string.
 *
 * THREE MECHANISMS ENFORCE IT HERE, and all three are load-bearing:
 *
 *  1. EVERY `AppSettings` LEAVING THIS FILE GOES THROUGH `redactSecrets`. Both
 *     `settings:get` and `settings:set` resolve with one, so without it every settings
 *     round-trip would ship the account password into the window. The helper lives in
 *     `src/shared/settings.ts` so the rule is one greppable function; the only thing
 *     this file has to get right is calling it on EVERY return path, including the
 *     failure path of `settings:set`.
 *  2. THE RENDERER THEREFORE HOLDS `''`, and `useSettingsController` echoes its whole
 *     settings object back as a patch - so an EMPTY `streamable.password` in an incoming
 *     patch must mean "leave the stored one alone", never "clear it". That is
 *     {@link optionalSecret}, and it is the same class of rule as `character.detected*`
 *     being unwriteable: main's copy wins because the renderer's is knowingly
 *     incomplete. The cost is that an empty field cannot express "forget my password";
 *     the frozen contract accepts that trade rather than risk wiping a credential every
 *     time the user edits an unrelated field.
 *  3. WHETHER A PASSWORD EXISTS IS ANSWERED SEPARATELY, by `credentials:status`, which
 *     reports facts ABOUT a secret and never the secret. `''` from `settings:get` says
 *     nothing either way, deliberately.
 *
 * And the corollary for failure text: {@link StreamableTestFailure.error} describes the
 * ATTEMPT. The one place an unrecognised value could smuggle a credential back out is a
 * message built from a thrown error, so the `streamable:test` crash path deliberately
 * discards the thrown detail and reports a fixed sentence, logging the original through
 * {@link IpcHandlerDeps.onError} where it stays inside the main process.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import type { ActiveCharacter, PoeEvent, PoeEventMap, WatcherStatus } from '../shared/events'
import {
  IPC_INVOKE,
  IPC_PUSH,
  type ClipRecord,
  type ClipUploadUpdate,
  type CredentialsStatusResult,
  type IpcInvokeChannel,
  type IpcInvokeResult,
  type IpcPushChannel,
  type IpcPushPayload,
  type ObsConnectionState,
  type ObsTestRequest,
  type ObsTestResult,
  type SessionStatsSnapshot,
  type StreamableTestRequest,
  type StreamableTestResult,
  type UpdateState
} from '../shared/ipc'
import type {
  AppSettings,
  DeepPartial,
  ObsSettings,
  StreamableSettings
} from '../shared/settings'
import { PORT_MAX, PORT_MIN, redactSecrets } from '../shared/settings'
// A pure static, NOT a service: `CharacterTracker.suggestionsFrom` takes events and
// returns names, touching no bus, no settings and no instance state. Importing it is
// therefore not a violation of the ports doctrine above - the alternative, re-implementing
// the tally here, would let the picker's idea of "names in your log" drift from the
// detector's. The live tracker still arrives as {@link CharacterPort}, like every other
// service.
import { CharacterTracker } from './log/character-tracker'
import { autodetectLogPath, fileExists } from './log/default-paths'
// Also a pure function rather than a service, and imported for the same reason
// `autodetectLogPath` is: it reads the filesystem and returns a value, holding no state
// and touching nothing this file orchestrates. See the `character:suggestions` handler
// for why the session ring buffer alone is not an acceptable source of names.
import { scanLogForNameEvents } from './log/name-scan'

// ---------------------------------------------------------------------------
// Ring buffer sizes
// ---------------------------------------------------------------------------

/**
 * How many `PoeEvent`s to keep for `events:recent`.
 *
 * The buffer exists so a window that opens (or reloads, or is re-created from the
 * tray) mid-session renders a populated feed instead of an empty one. It is
 * SESSION-SCOPED and starts filling the moment {@link registerIpcHandlers} runs -
 * which index.ts must do BEFORE starting the watcher, so nothing is missed.
 *
 * 200 events is a few hundred KB at worst (each carries its source line) and covers
 * far more history than the UI shows.
 */
export const RECENT_EVENTS_LIMIT = 200

/**
 * How many `ClipRecord`s to keep for `clips:recent`.
 *
 * Also session-scoped. There is deliberately no on-disk clip index: `ClipLibrary`
 * writes optional per-clip `.json` sidecars and otherwise treats the library
 * directory as the source of truth, and inventing a second index that could disagree
 * with the filesystem would be worse than showing only this session's clips.
 */
export const RECENT_CLIPS_LIMIT = 50

/**
 * The `character:active` answer when the tracker could not be asked.
 *
 * Deliberately the SAME value the tracker itself returns for "nothing configured and
 * nothing ever detected", so a failure here degrades into a state the UI already handles
 * loudly rather than into an invented one. Frozen because it is handed out by reference.
 */
const NO_CHARACTER: ActiveCharacter = Object.freeze({
  name: null,
  className: null,
  level: null,
  source: 'none'
})

/**
 * The `credentials:status` answer when the store could not be asked.
 *
 * {@link CredentialsPort.status} is documented as never throwing, so this is the belt to
 * that braces - but the choice of value still matters, because all three
 * {@link CredentialStatus} values are ASSERTIONS the UI puts in front of the user:
 *
 *  - `'ok'` would claim the secret is fine when we have just failed to establish
 *    anything at all. That is the one answer that could leave a user believing uploads
 *    are configured while they silently are not.
 *  - `'undecryptable'` would tell them their saved password is gone and must be retyped.
 *    Instructing a user to redo work on the strength of an internal fault is worse than
 *    saying less.
 *  - `'unavailable'` says "poe-tool cannot vouch for a stored secret right now", which is
 *    exactly what a store that would not answer has told us. It warns without inventing
 *    a cause and without asking for anything to be redone.
 *
 * `present: false` for the same reason: we cannot see a usable secret, so claiming one is
 * held would be a guess. Frozen because it is handed out by reference.
 */
const CREDENTIALS_UNKNOWN: CredentialsStatusResult = Object.freeze({
  obs: Object.freeze({ status: 'unavailable', present: false }),
  streamable: Object.freeze({ status: 'unavailable', present: false })
})

/**
 * What `streamable:test` reports when the credential check THREW instead of resolving.
 *
 * FIXED TEXT, ON PURPOSE - it is the one string in this file that could otherwise be
 * built out of a value nobody has inspected. {@link StreamablePort.testCredentials} is
 * documented as never rejecting and never quoting the credential it was handed, so
 * reaching here at all means an assumption broke; and an unrecognised thrown value is
 * precisely the kind of thing that might carry an `Authorization` header or a request
 * dump inside its message. The original goes to {@link IpcHandlerDeps.onError}, where it
 * stays inside the main process. See the password invariant in this file's header.
 */
const STREAMABLE_TEST_CRASH =
  'Could not check your Streamable credentials — the check itself failed unexpectedly. ' +
  'Try again; if it keeps happening, uploading is probably broken rather than your password.'

/**
 * What `streamable:test` reports when uploading is switched off.
 *
 * `settings.streamable.enabled` is documented as a MASTER SWITCH: with it off, poe-tool
 * never contacts Streamable at all - "no upload, no status poll, no credential check".
 * Enforcing that at the IPC boundary rather than only in the UI is what makes it true: a
 * renderer is untrusted, and "we never talk to that third party unless you turned it on"
 * is a promise about network traffic, not a button state.
 */
const STREAMABLE_TEST_DISABLED =
  'Streamable uploading is turned off, so nothing was sent. Turn it on first, then test.'

// ---------------------------------------------------------------------------
// Dependency ports
// ---------------------------------------------------------------------------

/** What this file needs from `src/main/settings/store.ts`. `SettingsStore` satisfies it as-is. */
export interface SettingsPort {
  /** Current validated settings. Must not throw. */
  readonly get: () => AppSettings
  /**
   * Applies a patch and persists it, returning the complete new settings.
   *
   * MAY THROW - the store is transactional and surfaces a failed disk write rather
   * than pretending it succeeded. {@link registerIpcHandlers} catches it, because a
   * rejected invoke would reach the renderer as an opaque string.
   */
  readonly save: (patch: DeepPartial<AppSettings>) => AppSettings
}

/**
 * What this file needs from `src/main/events/event-bus.ts`.
 *
 * Only `on`/`off` over the frozen {@link PoeEventMap} - the IPC layer is a pure
 * consumer of the bus and must never emit onto it. `TypedEmitter<PoeEventMap>` and
 * anything extending it satisfy this. The return type is `unknown` so a bus that
 * returns `this` (for chaining) and one that returns an unsubscribe function are both
 * acceptable.
 */
export interface EventBusPort {
  readonly on: <K extends keyof PoeEventMap>(
    channel: K,
    listener: (...args: PoeEventMap[K]) => void
  ) => unknown
  readonly off: <K extends keyof PoeEventMap>(
    channel: K,
    listener: (...args: PoeEventMap[K]) => void
  ) => unknown
}

/** What this file needs from `src/main/obs/obs-client.ts`. `ObsClient` satisfies it as-is. */
export interface ObsPort {
  /** Current connection state. A stored value, not a probe - cheap to read. */
  readonly state: ObsConnectionState
  /** One-shot credential check on a throwaway socket. Never rejects. */
  readonly testConnection: (config: ObsTestRequest) => Promise<ObsTestResult>
  /** Connects (or reconnects, replacing any existing socket). Never rejects. */
  readonly connect: (
    config: ObsTestRequest,
    options: { readonly autoReconnect: boolean }
  ) => Promise<ObsConnectionState>
  /** Closes the socket and stops the retry loop. Idempotent. Never rejects. */
  readonly disconnect: () => Promise<void>
  readonly on: (channel: 'state', listener: (state: ObsConnectionState) => void) => unknown
  readonly off: (channel: 'state', listener: (state: ObsConnectionState) => void) => unknown
}

/** What this file needs from `src/main/log/log-watcher.ts`. `LogWatcher` satisfies it as-is. */
export interface WatcherPort {
  /** Current watcher state. A stored value, mirroring `ObsPort.state`. */
  readonly status: WatcherStatus
  /**
   * Re-reads the settings store and restarts the tail if anything it cares about
   * moved.
   *
   * CALLED UNCONDITIONALLY after every successful `settings:set`, so the CONTRACT is
   * that the implementation compares first and no-ops otherwise. That is the right
   * place for the comparison: the watcher knows that `log.path` and
   * `log.pollIntervalMs` force a restart while `character.override` is re-read on every
   * tick and needs none. Duplicating that knowledge here would let the two drift, and
   * a needless restart costs the reader's carry buffer and its byte offset.
   *
   * Takes no arguments because the watcher already holds the same settings store this
   * handler just wrote to - the ordering below (save, then reconfigure) is what makes
   * that safe.
   */
  readonly reconfigure: () => void | Promise<void>
}

/**
 * What this file needs from `src/main/log/character-tracker.ts`. `CharacterTracker`
 * satisfies it as-is - both members are methods on the class, and a method is assignable
 * to a function-typed property.
 *
 * CALL THESE AS MEMBERS, never destructured. `CharacterTracker` keeps its state in `#`
 * private fields, so a detached `active` reference would throw on `this` rather than
 * quietly return the wrong answer.
 *
 * WHY THE RENDERER ASKS MAIN INSTEAD OF DERIVING THIS ITSELF
 * ----------------------------------------------------------
 * The renderer already receives the whole of `settings.character` from `settings:get`,
 * so it could compute "override if non-empty, else detected" on its own. It must not.
 * The resolution rule (and the `source` label the UI explains itself with) is the same
 * one `DeathEvent.isSelf` is computed from; two implementations of it would eventually
 * disagree, and the failure mode of that disagreement is a UI that says clipping is
 * armed while the clipper sits idle. One owner, one answer - see `ActiveCharacter`.
 */
export interface CharacterPort {
  /**
   * The RESOLVED active character: override > detected > none. Cheap (it re-reads the
   * in-memory settings), side-effect free, and documented as never throwing.
   */
  readonly active: () => ActiveCharacter
  /**
   * Re-resolve and announce `character-changed` if the answer moved.
   *
   * MUST be called after a `settings:set` that touched `settings.character`, because
   * the tracker learns about a typed override only by being told to look again: it
   * subscribes to `level-up`, not to the settings store. Without this call the override
   * still takes effect for `isSelf` (the watcher re-reads it per line) but the UI never
   * hears about it, so the "no character detected" warning would stay on screen after
   * the user had just fixed it.
   */
  readonly refreshOverride: () => void
}

/**
 * What this file needs from `src/main/obs/replay-clipper.ts`: notification that a clip
 * was saved. `ReplayClipper` satisfies it as-is.
 *
 * Clips are NOT on the {@link PoeEventMap} bus - a `ClipRecord` is produced well
 * downstream of a `death:self` event, after OBS and the filesystem have both had
 * their say - so this is a second, separate subscription rather than another bus
 * channel.
 *
 * Only the `clip` channel. The clipper also emits an `outcome` for every death
 * (including the skips and failures that never produce a file), which is exactly the
 * diagnostic firehose the frozen `push:clip` contract does not carry; index.ts can
 * log that separately.
 */
export interface ClipperPort {
  readonly on: (channel: 'clip', listener: (clip: ClipRecord) => void) => unknown
  readonly off: (channel: 'clip', listener: (clip: ClipRecord) => void) => unknown
}

/**
 * What this file needs from the ONE module allowed to talk to Streamable: a credential
 * check that uploads nothing.
 *
 * DELIBERATELY ONE METHOD. How a credential is verified against a service whose upload
 * endpoint is UNOFFICIAL and whose documented API is read-only is that module's problem,
 * and keeping every assumption about it in one file is the entire point of the design -
 * see its header. This port is the seam, so nothing about that endpoint leaks in here.
 *
 * CONTRACT:
 *  - NEVER REJECTS. A wrong password is the expected outcome of pressing "Test
 *    credentials", not an exception (mirroring {@link ObsPort.testConnection}).
 *  - {@link StreamableTestFailure.error} is safe to render verbatim and MUST NOT quote the
 *    password it was handed. See the password invariant in this file's header.
 */
export interface StreamablePort {
  readonly testCredentials: (request: StreamableTestRequest) => Promise<StreamableTestResult>
}

/**
 * What this file needs from the clip upload queue: per-clip progress, and a poke when the
 * settings it runs on have moved.
 *
 * A SECOND EMITTER, NOT A BUS CHANNEL, for the same reason {@link ClipperPort} is: an
 * upload update happens far downstream of anything the log parser produced, and
 * `PoeEventMap` describes log-derived events.
 *
 * The updates are addressed by {@link ClipRecord.id} rather than carrying a whole record -
 * see {@link ClipUploadUpdate} - so one row in the UI changes in place.
 */
export interface UploadPort {
  /**
   * Re-read the settings store and adopt anything that moved: the master switch, the
   * account credentials, the auto-upload flag, the size cap.
   *
   * CALLED UNCONDITIONALLY after every successful `settings:set`, exactly like
   * {@link WatcherPort.reconfigure}, so the CONTRACT is that the implementation compares
   * first and no-ops otherwise. The comparison belongs on that side: the queue is the
   * thing that knows whether a changed field means "rebuild the client" (email,
   * password), "stop accepting new clips" (enabled, autoUpload) or "nothing at all"
   * (a size cap that only matters at the next admission). Duplicating that knowledge here
   * would let the two drift, and this handler must not be the thing that decides an
   * in-flight upload is worth cancelling.
   *
   * Takes no arguments BECAUSE OF THE PASSWORD INVARIANT as much as for symmetry with the
   * watcher: the queue already holds the same settings store this handler just wrote to,
   * so the new credential reaches it without being passed through another hop - and it is
   * one hop the plaintext therefore never travels along.
   */
  readonly reconfigure: () => void | Promise<void>
  readonly on: (channel: 'upload', listener: (update: ClipUploadUpdate) => void) => unknown
  readonly off: (channel: 'upload', listener: (update: ClipUploadUpdate) => void) => unknown
}

/**
 * What this file needs from whoever owns encryption at rest - in practice
 * `src/main/settings/store.ts`, adapted by index.ts.
 *
 * THE COMPANION TO REDACTION. Because every `AppSettings` leaving this file has its
 * secrets blanked, the renderer cannot tell "no password saved" from "a password is
 * saved and you are holding a redacted blank", and it cannot tell either of those from
 * "an encrypted blob is on disk that this machine can no longer decrypt". That last state
 * is the one that matters: without it the field simply looks empty and the user is left
 * to work out for themselves why uploads stopped. So the question is answered by a
 * channel that returns FACTS ABOUT a secret and never a secret.
 *
 * Documented as never throwing, cheap (it reports what the store already knows rather
 * than probing the OS), and reporting BOTH slots - a DPAPI failure hits them together,
 * and a UI that explained one while silently dropping the other is how a user ends up
 * believing OBS is misconfigured.
 */
export interface CredentialsPort {
  readonly status: () => CredentialsStatusResult
}

/**
 * What this file needs from `src/main/updater.ts`. `AppUpdater` satisfies it as-is -
 * `state` is a getter and `on`/`off` mirror `TypedEmitter`, exactly like {@link ObsPort}.
 *
 * READ-ONLY ON PURPOSE. There is no `checkNow()` here and there must not be: the IPC
 * contract deliberately gives the renderer no way to trigger a network check, so a
 * config window left open cannot turn into a poller against GitHub. The one check
 * poe-tool performs is fired by `src/main/index.ts` at launch.
 */
export interface UpdaterPort {
  /** Current update state. A stored value, not a probe - reading it starts nothing. */
  readonly state: UpdateState
  readonly on: (channel: 'state', listener: (state: UpdateState) => void) => unknown
  readonly off: (channel: 'state', listener: (state: UpdateState) => void) => unknown
}

/**
 * What this file needs from `src/main/stats/session-stats.ts`. `SessionStats` satisfies it
 * as-is - `snapshot` is a getter and `on`/`off` mirror `TypedEmitter`, exactly like
 * {@link ObsPort} and {@link UpdaterPort}.
 *
 * A SECOND EMITTER, NOT A BUS CHANNEL, for the reason {@link ClipperPort} and
 * {@link UploadPort} are: `PoeEventMap` describes log-derived events and the state derived
 * from them, and a running total is neither.
 *
 * READ-ONLY, and there is deliberately no `reset()`. A "clear my session" button would be
 * a control that makes the numbers on screen disagree with what actually happened, which
 * is the one thing these counters exist not to do; a session ends when the app does.
 */
export interface StatsPort {
  /**
   * The counters right now. A stored value with a fresh clock read, not a probe - cheap,
   * side-effect free, documented as never throwing.
   */
  readonly snapshot: SessionStatsSnapshot
  readonly on: (
    channel: 'stats',
    listener: (snapshot: SessionStatsSnapshot) => void
  ) => unknown
  readonly off: (
    channel: 'stats',
    listener: (snapshot: SessionStatsSnapshot) => void
  ) => unknown
}

/** Everything {@link registerIpcHandlers} needs. Assembled by `src/main/index.ts`. */
export interface IpcHandlerDeps {
  /**
   * The running app's version, for the window's brand block.
   *
   * A FUNCTION rather than a string, for the reason {@link CredentialsPort.status} is one:
   * it keeps the read live and keeps `electron` out of this file - `app.getVersion()` is
   * called by index.ts, which owns every OS-specific fact in the graph.
   *
   * Documented as never throwing. If it does anyway, the channel answers `''` and the
   * window renders no version at all, which is the honest outcome: a version is a claim
   * about which build the user is running, and a wrong one sends them to the wrong
   * release notes and the wrong bug report.
   */
  readonly appVersion: () => string
  readonly settings: SettingsPort
  readonly bus: EventBusPort
  readonly obs: ObsPort
  readonly clipper: ClipperPort
  readonly watcher: WatcherPort
  readonly characters: CharacterPort
  readonly updater: UpdaterPort
  /**
   * The Streamable client, for `streamable:test`.
   *
   * REQUIRED, like every other port here, even though uploading defaults to OFF. An
   * optional dependency would mean a build that forgot to wire it answered "credentials
   * rejected" or "not available" to a user whose credentials are fine - a silent
   * misconfiguration of exactly the kind this app refuses to ship. Missing it is a
   * compile error in index.ts instead.
   */
  readonly streamable: StreamablePort
  /** The clip upload queue: the source of `push:clip-upload`, and a reconfigure target. */
  readonly uploads: UploadPort
  /** Whether each stored secret is present and usable. Never returns a secret. */
  readonly credentials: CredentialsPort
  /** This session's live counters: the source of `push:stats` and of `stats:session`. */
  readonly stats: StatsPort
  /**
   * The window to push to, or null/undefined when there is none.
   *
   * A FUNCTION, not a window: the main process outlives any particular window
   * (close-to-tray, a renderer crash, a dev-server reload all replace it) and must
   * keep tailing and clipping with zero windows open. Called fresh on every push so a
   * new window starts receiving without any re-registration.
   */
  readonly getWindow: () => BrowserWindow | null | undefined
  /**
   * Diagnostic sink for everything this file swallows. Defaults to `console.error`.
   *
   * Purely observational - a hook that throws is itself swallowed, because a logger
   * must never be the reason the main process dies.
   */
  readonly onError?: (error: unknown, context: string) => void
}

/**
 * Removes every `ipcMain` handler and every bus/OBS/clipper listener this
 * registration added. Idempotent; safe to call from `before-quit`.
 */
export type IpcTeardown = () => void

// ---------------------------------------------------------------------------
// Untrusted-payload narrowing (all pure, all total, none throw)
// ---------------------------------------------------------------------------

/** True for plain objects only - rejects `null` and arrays, both `typeof 'object'`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `key` off an unknown value, yielding `undefined` when it is not a record. */
function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

/** A string, or `undefined` for anything else. `undefined` means "not present in the patch". */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A string or an explicit `null`; anything else is "not present". */
function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

/**
 * A finite number, or `undefined`.
 *
 * Numeric strings are accepted because `<input type="number">` hands back a string
 * and the renderer should not have to remember to coerce. Range clamping is NOT done
 * here - `validateSettings` owns the bounds, and duplicating them would let the two
 * drift apart.
 */
function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * A SECRET from a patch: a non-empty string, or `undefined` for everything else -
 * INCLUDING `''`.
 *
 * This is the second half of the redaction rule, and the half that is easy to miss. The
 * renderer is handed `streamable.password: ''` by `redactSecrets` and echoes its whole
 * settings object back as a patch on every edit, so if `''` were treated as a value, then
 * changing the clip folder - or toggling auto-upload, or typing in the log path - would
 * wipe the user's stored Streamable password. It would look like the app forgetting a
 * credential at random, which is precisely how a user learns to distrust an app.
 *
 * `applySettingsPatch` deliberately does NOT know this rule (see its own note): there,
 * "absent means no change" is the only patch semantic, so that a deliberate clear stays
 * expressible in-process. Dropping the empty string is this file's job, at the trust
 * boundary, where "the renderer's copy is knowingly incomplete" is the reason.
 *
 * THE ACCEPTED COST: with `''` meaning "no change", the config window has no way to say
 * "forget the password I stored". Replacing it by typing a new one works; emptying the
 * field does not. The frozen contract chose that over a credential that vanishes whenever
 * an unrelated field is saved.
 */
function optionalSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value === '' ? undefined : value
}

/** A boolean, or the strings `"true"`/`"false"` (checkbox round-trips), else `undefined`. */
function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return undefined
}

/**
 * Rebuilds an arbitrary renderer payload as a well-typed {@link DeepPartial} patch.
 *
 * Only the fifteen known fields survive; everything else - extra keys, prototype
 * pollution attempts, functions, nested junk - is dropped on the floor. A field whose
 * value has the wrong type becomes `undefined`, which `applySettingsPatch` reads as "no
 * change" rather than "reset to default", so a garbled patch can never silently wipe a
 * setting the user did not touch.
 *
 * `streamable.password` GETS ITS OWN NARROWER
 * -------------------------------------------
 * It is read with {@link optionalSecret} rather than {@link optionalString}, so an empty
 * string is dropped as "no change" instead of clearing the stored credential. That is not
 * a nicety: the renderer holds a redacted `''` for this field at all times and sends its
 * whole settings object back on every edit. See {@link optionalSecret} for the full
 * reasoning, and this file's header for the invariant it belongs to.
 *
 * `character.override` IS THE ONLY WRITEABLE HALF OF `character`
 * -------------------------------------------------------------
 * `detected`, `detectedClass` and `detectedLevel` are deliberately absent, so a
 * `settings:set` can never write them. Two reasons, and the second is the one that
 * actually bites:
 *
 *  1. They are not the user's to set. They record what was read off a `... is now level
 *     N` line; a renderer that could write them could forge a detection that no log line
 *     supports, and every subsequent death would be attributed on that basis.
 *  2. THE RENDERER'S COPY IS ROUTINELY STALE. `useSettingsController` sends the whole
 *     settings object as its patch, and a level-up detected in main a second ago is not
 *     in the copy the renderer is holding. Letting those three fields through would mean
 *     a user editing an unrelated field silently rolls the fresh detection back to
 *     whatever the window last saw - which, because level-ups are sparse, could be the
 *     only detection that will happen for weeks. Dropping them makes main's value win by
 *     construction.
 *
 * Clearing a wrong detection is therefore done by setting an override, which out-ranks
 * it - see `ActiveCharacter`.
 *
 * PURE and TOTAL: never throws, for any input including `null`, arrays and primitives.
 */
export function narrowSettingsPatch(raw: unknown): DeepPartial<AppSettings> {
  const log = field(raw, 'log')
  const character = field(raw, 'character')
  const obs = field(raw, 'obs')
  const clips = field(raw, 'clips')
  const streamable = field(raw, 'streamable')

  return {
    log: {
      path: optionalNullableString(field(log, 'path')),
      pollIntervalMs: optionalNumber(field(log, 'pollIntervalMs'))
    },
    character: {
      override: optionalString(field(character, 'override'))
    },
    obs: {
      host: optionalString(field(obs, 'host')),
      port: optionalNumber(field(obs, 'port')),
      password: optionalString(field(obs, 'password')),
      autoConnect: optionalBoolean(field(obs, 'autoConnect'))
    },
    clips: {
      enabled: optionalBoolean(field(clips, 'enabled')),
      libraryDir: optionalString(field(clips, 'libraryDir')),
      debounceMs: optionalNumber(field(clips, 'debounceMs')),
      writeSidecar: optionalBoolean(field(clips, 'writeSidecar'))
    },
    streamable: {
      enabled: optionalBoolean(field(streamable, 'enabled')),
      email: optionalString(field(streamable, 'email')),
      // NOT `optionalString`. An empty password means "leave the stored one alone".
      password: optionalSecret(field(streamable, 'password')),
      autoUpload: optionalBoolean(field(streamable, 'autoUpload')),
      maxFileBytes: optionalNumber(field(streamable, 'maxFileBytes'))
    }
  }
}

/** An integer inside the valid TCP port range, else `undefined`. */
function optionalPort(value: unknown): number | undefined {
  const parsed = optionalNumber(value)
  if (parsed === undefined) return undefined
  const rounded = Math.round(parsed)
  return rounded >= PORT_MIN && rounded <= PORT_MAX ? rounded : undefined
}

/**
 * Rebuilds an `obs:test` payload, substituting the SAVED setting for any field the
 * renderer omitted or sent as the wrong type.
 *
 * Falling back rather than rejecting is deliberate: the common shape of this call is
 * "test what is currently in the form", and a form that has not been touched sends
 * exactly the saved values anyway. A test against the saved credentials is a useful
 * answer; an error about a malformed payload is not.
 *
 * PURE and TOTAL: never throws.
 */
export function narrowObsTestRequest(raw: unknown, fallback: ObsSettings): ObsTestRequest {
  return {
    host: optionalString(field(raw, 'host')) ?? fallback.host,
    port: optionalPort(field(raw, 'port')) ?? fallback.port,
    password: optionalString(field(raw, 'password')) ?? fallback.password
  }
}

/**
 * Rebuilds a `streamable:test` payload, substituting the SAVED credential for anything
 * the renderer omitted, sent as the wrong type, or sent as blank.
 *
 * THE BLANK PASSWORD CASE IS THE NORMAL ONE, and it is why this cannot just be
 * {@link narrowObsTestRequest} with different field names. The renderer's copy of
 * `streamable.password` is `''` at all times - `redactSecrets` blanked it - so a user who
 * saved a password last week, reopened the window and pressed "Test credentials" is
 * sending an empty string. Testing that empty string would report "Streamable rejected
 * your credentials" about a password that is perfectly good, and send the user off to
 * change a password that was never wrong. Falling back to the stored value tests what the
 * uploader will actually use, which is the only question the button is asking.
 *
 * The email falls back for the ordinary reason its OBS counterpart does: "test what is
 * currently configured" is a useful answer, and a complaint about a malformed payload is
 * not.
 *
 * NOTHING IN THE RESULT TRAVELS BACK. The password put in here is used to build an HTTP
 * Basic header inside the Streamable module and is never part of a
 * {@link StreamableTestResult}.
 *
 * PURE and TOTAL: never throws.
 */
export function narrowStreamableTestRequest(
  raw: unknown,
  fallback: StreamableSettings
): StreamableTestRequest {
  const typed = optionalString(field(raw, 'email'))
  return {
    email: typed === undefined || typed.trim() === '' ? fallback.email : typed.trim(),
    password: optionalSecret(field(raw, 'password')) ?? fallback.password
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The shape of an `ipcMain.handle` listener for one channel.
 *
 * `args` is `unknown[]`, NOT the contract's argument tuple: what actually arrives is
 * whatever the renderer sent. The tuple type describes what a well-behaved renderer
 * sends; the handler body is responsible for turning `unknown` into that.
 */
type InvokeHandler<C extends IpcInvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>

/**
 * Wires every channel in `src/shared/ipc.ts` and starts forwarding bus, OBS and clip
 * activity to the renderer.
 *
 * Call ONCE during bootstrap, BEFORE starting the log watcher, so the recent-events
 * ring buffer does not miss the first lines.
 *
 * @returns a teardown that removes everything it registered.
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): IpcTeardown {
  const report = makeReporter(deps.onError)
  const send = makeSender(deps.getWindow, report)

  /** Newest-LAST, matching the `events:recent` contract. */
  const recentEvents: PoeEvent[] = []
  /** Newest-FIRST, matching the `clips:recent` contract. */
  const recentClips: ClipRecord[] = []

  let disposed = false

  // -------------------------------------------------------------------------
  // Invoke channels
  // -------------------------------------------------------------------------

  const registered: IpcInvokeChannel[] = []

  /**
   * Registers one handler.
   *
   * `removeHandler` first because `ipcMain.handle` THROWS on a duplicate channel, and
   * a dev-mode reload that re-runs bootstrap without a clean teardown would otherwise
   * take the main process down on startup.
   */
  const register = <C extends IpcInvokeChannel>(channel: C, handler: InvokeHandler<C>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
    registered.push(channel)
  }

  // Display only. `''` is the documented "could not be read" answer and the renderer shows
  // nothing for it - see the channel's note in `src/shared/ipc.ts`.
  register(IPC_INVOKE.APP_VERSION, () => {
    try {
      return deps.appVersion()
    } catch (error) {
      report(error, 'app:version')
      return ''
    }
  })

  // `redactSecrets` on EVERY return path out of both settings channels - see the password
  // invariant in this file's header. It returns its argument by reference when there is
  // nothing to blank, so the common case allocates nothing.
  register(IPC_INVOKE.SETTINGS_GET, () => redactSecrets(deps.settings.get()))

  register(IPC_INVOKE.SETTINGS_SET, (_event, ...args) => {
    const previous = deps.settings.get()
    const patch = narrowSettingsPatch(args[0])

    let next: AppSettings
    try {
      next = deps.settings.save(patch)
    } catch (error) {
      // The store writes to disk BEFORE swapping its in-memory value, so a failed
      // save leaves memory and disk agreeing on the old settings. Returning that old
      // value is therefore honest rather than a guess: the UI re-renders what is
      // actually in effect, and the user sees their edit revert instead of believing
      // a change took hold that did not.
      report(error, 'settings:set/save')
      return redactSecrets(deps.settings.get())
    }

    reconfigure(deps, previous, next, report)
    return redactSecrets(next)
  })

  register(IPC_INVOKE.OBS_TEST, async (_event, ...args) => {
    const request = narrowObsTestRequest(args[0], deps.settings.get().obs)
    try {
      return await deps.obs.testConnection(request)
    } catch (error) {
      // `testConnection` is documented as never throwing; this is the belt to that
      // braces. A "Test connection" button must always get an answer it can render.
      report(error, 'obs:test')
      return { ok: false, error: describeUnexpected(error) }
    }
  })

  register(IPC_INVOKE.OBS_STATUS, () => deps.obs.state)

  register(IPC_INVOKE.STREAMABLE_TEST, async (_event, ...args) => {
    const settings = deps.settings.get().streamable

    // The master switch is enforced BEFORE the request is even assembled, so with
    // uploading off there is no code path from this channel to the network. See
    // {@link STREAMABLE_TEST_DISABLED}.
    if (!settings.enabled) return { ok: false, error: STREAMABLE_TEST_DISABLED }

    const request = narrowStreamableTestRequest(args[0], settings)

    // Answering "you have not entered an email yet" here rather than letting Streamable
    // answer it: an HTTP round trip to say what we can see locally is both slower and
    // vaguer, and the vaguer version ("401") reads like a rejected password.
    if (request.email === '') {
      return {
        ok: false,
        error: 'No Streamable account email is set. Enter the email you sign in with, then test.'
      }
    }
    if (request.password === '') {
      return {
        ok: false,
        error: 'No Streamable password is stored. Type your account password, then test.'
      }
    }

    try {
      return await deps.streamable.testCredentials(request)
    } catch (error) {
      // `testCredentials` is documented as never rejecting; this is the belt to that
      // braces. The thrown value is reported to main's log and DELIBERATELY NOT
      // rendered - see {@link STREAMABLE_TEST_CRASH}.
      report(error, 'streamable:test')
      return { ok: false, error: STREAMABLE_TEST_CRASH }
    }
  })

  register(IPC_INVOKE.CREDENTIALS_STATUS, () => {
    try {
      return deps.credentials.status()
    } catch (error) {
      report(error, 'credentials:status')
      return CREDENTIALS_UNKNOWN
    }
  })

  register(IPC_INVOKE.LOG_AUTODETECT, async () => {
    try {
      return { candidates: await autodetectLogPath(process.env, fileExists) }
    } catch (error) {
      // `autodetectLogPath` swallows per-candidate failures already. An empty list is
      // the documented "nothing found, ask the user to browse" outcome, which is also
      // the right thing to say when the scan itself fell over.
      report(error, 'log:autodetect')
      return { candidates: [] }
    }
  })

  register(IPC_INVOKE.LOG_STATUS, () => deps.watcher.status)

  // Mirrors `obs:status`: a stored value read straight off the port. Reading it does NOT
  // trigger a check - see `UpdaterPort`.
  register(IPC_INVOKE.UPDATE_STATE, () => deps.updater.state)

  register(IPC_INVOKE.STATS_SESSION, () => {
    try {
      return deps.stats.snapshot
    } catch (error) {
      // `SessionStats.snapshot` is documented as never throwing; this is the belt to that
      // braces. `null` rather than a zeroed snapshot, and the difference is the whole
      // point: `{ deaths: 0, areasEntered: 0 }` is not "we do not know", it is the CLAIM
      // that nothing has happened this session - a claim the renderer would print as
      // confidently as a real one. `null` makes the UI show nothing, which is what we
      // actually know. Same rule as `app:version` answering `''`.
      report(error, 'stats:session')
      return null
    }
  })

  // `slice()` so a renderer-side mutation (or a later push) cannot reach into the
  // live buffer. The events themselves are deeply readonly value objects.
  register(IPC_INVOKE.EVENTS_RECENT, () => recentEvents.slice())
  register(IPC_INVOKE.CLIPS_RECENT, () => recentClips.slice())

  register(IPC_INVOKE.CHARACTER_ACTIVE, () => {
    try {
      return deps.characters.active()
    } catch (error) {
      // `CharacterTracker.active()` is documented as never throwing. If it somehow does,
      // NOBODY is the honest answer rather than a convenient one: `source: 'none'` is
      // precisely the state in which `isSelf` is false for every death and the clipper
      // sits idle, and it is the state the UI shouts about. Reporting anything else here
      // would paper over a broken detector with a UI that claims clipping is armed.
      report(error, 'character:active')
      return NO_CHARACTER
    }
  })

  register(IPC_INVOKE.CHARACTER_SUGGESTIONS, async () => {
    try {
      // TWO SOURCES, ONE TALLY.
      //
      // The session ring buffer alone is empty in EXACTLY the state this picker exists
      // for. `LogWatcher` starts with a `seekToEnd()`, so a freshly launched app has
      // parsed none of the log it is tailing: `character.detected` is null on a first
      // run, the override is empty, the UI raises its full-width alarm - and the picker
      // it offers alongside it would list nothing, while every name that would fix the
      // problem sits in the file main already has open. The list would only fill after
      // the user's first death or level-up, i.e. after the first clip has already been
      // silently lost, which is the outcome the picker was specified to prevent. The
      // buffer is also only 200 events deep against a stream dominated by zone traffic,
      // so it can hold no name-bearing event even mid-session.
      //
      // So the tail of Client.txt is swept first (read-only, bounded, and NOT published
      // onto the bus - see `name-scan.ts`), and the session's events are appended after
      // it. Order matters: `suggestionsFrom` counts occurrences and breaks ties by
      // "seen most recently", assuming log order, and the scanned lines are by
      // definition older than anything the watcher has read since.
      //
      // Deaths count here as well as level-ups: the only claim being made is "this name
      // appears in your log", and a party member costing one wrong row in a picker is
      // nothing like a party member being silently detected as you.
      //
      // EMPTY IS STILL A NORMAL ANSWER (no log path configured yet, a log the game has
      // never written), which is why the renderer must keep offering free-text entry.
      const scanned = await scanLogForNameEvents(deps.settings.get().log.path, {
        onError: (error) => {
          report(error, 'character:suggestions/scan')
        }
      })
      return { names: CharacterTracker.suggestionsFrom([...scanned, ...recentEvents]) }
    } catch (error) {
      report(error, 'character:suggestions')
      return { names: [] }
    }
  })

  // -------------------------------------------------------------------------
  // Push channels
  // -------------------------------------------------------------------------

  // Every one of these runs inside the emitter it subscribes to, on the critical path.
  // Nothing in them may throw: `send` swallows, and the ring-buffer writes cannot
  // fail.

  const onBusEvent = (event: PoeEvent): void => {
    if (disposed) return
    recentEvents.push(event)
    if (recentEvents.length > RECENT_EVENTS_LIMIT) {
      recentEvents.splice(0, recentEvents.length - RECENT_EVENTS_LIMIT)
    }
    send(IPC_PUSH.EVENT, event)
  }

  const onBusStatus = (status: WatcherStatus): void => {
    if (disposed) return
    send(IPC_PUSH.STATUS, status)
  }

  const onObsState = (state: ObsConnectionState): void => {
    if (disposed) return
    send(IPC_PUSH.OBS_STATUS, state)
  }

  const onClipSaved = (clip: ClipRecord): void => {
    if (disposed) return
    recentClips.unshift(clip)
    if (recentClips.length > RECENT_CLIPS_LIMIT) {
      recentClips.length = RECENT_CLIPS_LIMIT
    }
    send(IPC_PUSH.CLIP, clip)
  }

  /**
   * One clip's upload state moved.
   *
   * TWO JOBS, AND THE SECOND ONE IS THE ONE THAT IS EASY TO FORGET.
   *
   *  1. Push the update at whatever window exists, addressed by clip id so the UI
   *     changes one row in place.
   *  2. FOLD IT BACK INTO THE RING BUFFER. `ClipRecord.upload` is documented as a
   *     snapshot "at the moment this record was sent" - and for `clips:recent` that
   *     moment is whenever a window next asks. A buffer holding the record as it was at
   *     save time would answer `pending` for every clip forever, so a window opened after
   *     an upload finished (or reloaded, or re-created from the tray - all ordinary, since
   *     main outlives every window) would show a feed of stalled uploads and no links.
   *     Rewriting the one field keeps the snapshot true without inventing a second
   *     source of truth: the queue still owns the state, this is just where the answer to
   *     `clips:recent` is kept current.
   *
   * An id that is not in the buffer is NORMAL - the clip may have aged out past
   * {@link RECENT_CLIPS_LIMIT}, or been saved before this registration existed. The push
   * still goes out; the renderer drops unknown ids by contract.
   *
   * Runs inside the queue's emitter, so nothing here may throw: the array write cannot
   * fail and `send` swallows.
   */
  const onUploadUpdate = (update: ClipUploadUpdate): void => {
    if (disposed) return

    const index = recentClips.findIndex((clip) => clip.id === update.clipId)
    if (index !== -1) {
      const existing = recentClips[index]
      // `noUncheckedIndexedAccess` - the index came from `findIndex` on this same array
      // one statement ago, so this cannot be undefined, but the check costs nothing.
      if (existing !== undefined) recentClips[index] = { ...existing, upload: update.upload }
    }

    send(IPC_PUSH.CLIP_UPLOAD, update)
  }

  /**
   * The resolved active character moved - a level-up was detected, or the override was
   * edited and {@link CharacterPort.refreshOverride} was called.
   *
   * NOT ring-buffered, unlike events and clips: `character-changed` carries a COMPLETE
   * current-value snapshot rather than an occurrence, so a window that opens later gets
   * the truth from `character:active` instead of from a history it does not need. The
   * tracker also emits only on a real change, so this cannot spray during a levelling
   * session.
   */
  const onCharacterChanged = (character: ActiveCharacter): void => {
    if (disposed) return
    send(IPC_PUSH.CHARACTER, character)
  }

  /**
   * The auto-update state moved.
   *
   * NOT ring-buffered, for the same reason `push:character` is not: this is a complete
   * current-value snapshot, not an occurrence, so a window opening later reads the truth
   * from `update:state` rather than replaying a history it does not need.
   *
   * `AppUpdater` only emits on a real change (its reducer returns the previous state by
   * reference otherwise), so a download cannot spray a push per network chunk through
   * here. `send` is the same window-guarded sender everything else uses, so a state
   * change landing while the user is closing the window is a no-op rather than an
   * `Object has been destroyed` throw.
   */
  const onUpdateState = (state: UpdateState): void => {
    if (disposed) return
    send(IPC_PUSH.UPDATE, state)
  }

  /**
   * A session counter moved.
   *
   * NOT ring-buffered, for the same reason `push:character` and `push:update` are not:
   * this is a complete current-value snapshot rather than an occurrence, so a window that
   * opens later reads the truth from `stats:session` instead of replaying a history of
   * increments. That is also why the counters live in main and not in the renderer - a
   * window that opened at 11pm still sees the whole evening's totals.
   *
   * `SessionStats` only emits on a real change and never on a clock tick, so this cannot
   * become a once-a-second heartbeat into a window that is doing nothing.
   */
  const onSessionStats = (snapshot: SessionStatsSnapshot): void => {
    if (disposed) return
    send(IPC_PUSH.STATS, snapshot)
  }

  // Subscribing to `event` (rather than to each of `zone-entered`/`area-generated`/
  // `death`) is what makes this exactly-once: the bus fans every PoeEvent out on
  // `event` IN ADDITION to its per-type channel, so listening to both would show the
  // user every death twice.
  //
  // `character-changed` is NOT one of those fanned-out channels - it is derived state
  // the character tracker owns and `publish` never touches it - so it needs its own
  // subscription and cannot arrive twice.
  deps.bus.on('event', onBusEvent)
  deps.bus.on('watcher-status', onBusStatus)
  deps.bus.on('character-changed', onCharacterChanged)
  deps.obs.on('state', onObsState)
  deps.clipper.on('clip', onClipSaved)
  deps.uploads.on('upload', onUploadUpdate)
  deps.updater.on('state', onUpdateState)
  deps.stats.on('stats', onSessionStats)

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  return (): void => {
    if (disposed) return
    disposed = true

    for (const channel of registered) {
      try {
        ipcMain.removeHandler(channel)
      } catch (error) {
        report(error, `teardown:${channel}`)
      }
    }
    registered.length = 0

    try {
      deps.bus.off('event', onBusEvent)
      deps.bus.off('watcher-status', onBusStatus)
      deps.bus.off('character-changed', onCharacterChanged)
    } catch (error) {
      report(error, 'teardown:bus')
    }

    try {
      deps.obs.off('state', onObsState)
    } catch (error) {
      report(error, 'teardown:obs')
    }

    try {
      deps.clipper.off('clip', onClipSaved)
    } catch (error) {
      report(error, 'teardown:clipper')
    }

    // Detached in its own try/catch like every other subscription: an upload in flight
    // outlives the window it was being reported to, and its next state change must not
    // reach a `webContents.send` for a window that is being destroyed.
    try {
      deps.uploads.off('upload', onUploadUpdate)
    } catch (error) {
      report(error, 'teardown:uploads')
    }

    try {
      deps.updater.off('state', onUpdateState)
    } catch (error) {
      report(error, 'teardown:updater')
    }

    // The counters outlive this registration - `SessionStats` keeps counting with no
    // window open - so the listener has to come off, or a snapshot emitted during
    // shutdown would reach a `webContents.send` for a window being destroyed.
    try {
      deps.stats.off('stats', onSessionStats)
    } catch (error) {
      report(error, 'teardown:stats')
    }

    recentEvents.length = 0
    recentClips.length = 0
  }
}

// ---------------------------------------------------------------------------
// Live reconfiguration
// ---------------------------------------------------------------------------

/**
 * Applies the side effects of a settings change to the running services.
 *
 * FIRE-AND-FORGET BY DESIGN. A reconnect can sit for the full 10s connect timeout,
 * and blocking `settings:set` on it would freeze the settings form on every keystroke
 * that touches a connection field. The renderer learns the outcome from the
 * `push:obs-status` / `push:status` streams instead, which is where it was always
 * going to have to watch for it.
 *
 * COMPARISONS ARE AGAINST THE VALIDATED `next`, NOT THE RAW PATCH. `validateSettings`
 * clamps and coerces, so a patch that sets `port` to `"4455"` or `0` produces a
 * `next.obs.port` that may well equal the previous one. Diffing the validated values
 * means such a no-op does not tear down a healthy OBS connection.
 *
 * The watcher gets no diff at all - see {@link WatcherPort.reconfigure} for why the
 * comparison belongs on its side.
 */
function reconfigure(
  deps: IpcHandlerDeps,
  previous: AppSettings,
  next: AppSettings,
  report: (error: unknown, context: string) => void
): void {
  // The character tracker learns about level-ups from the bus, but it has no way to hear
  // about a TYPED override - it reads `settings.character.override` through an injected
  // getter and only looks when told to. So a settings write that moved any part of
  // `character` has to poke it.
  //
  // Whether `isSelf` is right does NOT depend on this call: `active()` re-reads the
  // getter every time, and the watcher calls it per line, so the new override is in
  // force for the very next line either way. What depends on it is the ANNOUNCEMENT -
  // `character-changed`, and therefore `push:character`, and therefore whether the UI's
  // "no character detected" warning clears the instant the user fixes it. Skipping it
  // would leave the window telling the user they are broken while they are not.
  //
  // The whole section is compared rather than just `override`, so a hand-edited
  // settings.json reloaded through this path is covered too. The tracker de-duplicates
  // internally (it compares against the last value it announced), so a comparison that is
  // too generous costs nothing.
  const characterChanged =
    previous.character.override !== next.character.override ||
    previous.character.detected !== next.character.detected ||
    previous.character.detectedClass !== next.character.detectedClass ||
    previous.character.detectedLevel !== next.character.detectedLevel

  if (characterChanged) {
    try {
      deps.characters.refreshOverride()
    } catch (error) {
      // Documented as never throwing, and it runs synchronously inside this handler, so
      // an escape would reject `settings:set` and the user would see their save fail for
      // a reason that has nothing to do with saving.
      report(error, 'reconfigure:characters')
    }
  }

  try {
    void Promise.resolve(deps.watcher.reconfigure()).catch((error: unknown) => {
      report(error, 'reconfigure:watcher')
    })
  } catch (error) {
    // A synchronous throw from a `void`-returning implementation never reaches the
    // `.catch` above, so it needs its own guard.
    report(error, 'reconfigure:watcher')
  }

  // The upload queue, on the same unconditional terms as the watcher - it compares and
  // no-ops, see {@link UploadPort.reconfigure}.
  //
  // THIS CALL IS THE ONLY THING THAT MAKES A CREDENTIAL EDIT TAKE EFFECT. The queue and
  // the Streamable client read the settings store, but nothing tells them it moved: a
  // user who fixes a wrong password would otherwise keep failing every upload with the
  // old one until they restarted the app, with the config window showing the new value
  // the whole time. Note that no credential is passed HERE - the queue re-reads the store
  // it already holds, which is both simpler and one hop the plaintext never travels.
  //
  // Deliberately NOT gated on a `previous.streamable` vs `next.streamable` diff. Main
  // holds both plaintexts and could compare them, but doing so would be this file
  // guessing at the queue's business: whether a changed size cap, a paused auto-upload or
  // a re-typed identical password is worth rebuilding a client - or cancelling an upload
  // already in flight - is knowledge that belongs on that side, exactly as the watcher's
  // restart rules belong on its. A redundant no-op poke costs nothing next to an upload
  // that silently keeps using a stale credential.
  try {
    void Promise.resolve(deps.uploads.reconfigure()).catch((error: unknown) => {
      report(error, 'reconfigure:uploads')
    })
  } catch (error) {
    report(error, 'reconfigure:uploads')
  }

  const connectionChanged =
    previous.obs.host !== next.obs.host ||
    previous.obs.port !== next.obs.port ||
    previous.obs.password !== next.obs.password
  const autoConnectChanged = previous.obs.autoConnect !== next.obs.autoConnect

  if (!connectionChanged && !autoConnectChanged) return

  // `obs.autoConnect` is the effective on/off switch for the live connection: the
  // frozen IPC contract has no manual "connect now" channel (only the throwaway
  // `obs:test`), so with it off there is no way back to a connected state anyway.
  // Turning it off therefore means "disconnect", and a credential change while it is
  // off means "drop the socket that is now using stale credentials".
  if (next.obs.autoConnect) {
    try {
      void deps.obs
        .connect(
          { host: next.obs.host, port: next.obs.port, password: next.obs.password },
          { autoReconnect: true }
        )
        .catch((error: unknown) => {
          report(error, 'reconfigure:obs-connect')
        })
    } catch (error) {
      report(error, 'reconfigure:obs-connect')
    }
    return
  }

  try {
    void deps.obs.disconnect().catch((error: unknown) => {
      report(error, 'reconfigure:obs-disconnect')
    })
  } catch (error) {
    report(error, 'reconfigure:obs-disconnect')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps the diagnostic hook so a throwing logger cannot escape. */
function makeReporter(
  onError: ((error: unknown, context: string) => void) | undefined
): (error: unknown, context: string) => void {
  const sink =
    onError ??
    ((error: unknown, context: string): void => {
      console.error(`[ipc] ${context}`, error)
    })

  return (error: unknown, context: string): void => {
    try {
      sink(error, context)
    } catch {
      // A logger must never be the thing that crashes the main process.
    }
  }
}

/**
 * Builds the typed, window-safe push function.
 *
 * The channel/payload pairing is enforced by {@link IpcPushPayload}, so a `ClipRecord`
 * cannot be sent down `push:status`.
 *
 * Three separate guards, all necessary:
 *  - no window at all (closed to tray, or not created yet),
 *  - `win.isDestroyed()` - reading `.webContents` off a destroyed window throws,
 *  - `webContents.isDestroyed()` - a crashed or navigating renderer can leave the
 *    window alive with dead contents.
 * The surrounding try/catch covers the gap between the last check and the send, which
 * is genuinely reachable: window teardown is driven by native events that can land
 * between two statements.
 */
function makeSender(
  getWindow: () => BrowserWindow | null | undefined,
  report: (error: unknown, context: string) => void
): <C extends IpcPushChannel>(channel: C, payload: IpcPushPayload<C>) => void {
  return <C extends IpcPushChannel>(channel: C, payload: IpcPushPayload<C>): void => {
    try {
      const win = getWindow()
      if (win === null || win === undefined || win.isDestroyed()) return
      const contents = win.webContents
      if (contents.isDestroyed()) return
      contents.send(channel, payload)
    } catch (error) {
      report(error, `send:${channel}`)
    }
  }
}

/**
 * A renderable sentence for a value that was never supposed to be thrown.
 *
 * Deliberately message-only: a stack trace is diagnostic noise in a settings dialog,
 * and `ObsTestFailure.error` is documented as safe to render verbatim.
 */
function describeUnexpected(error: unknown): string {
  let detail = ''
  if (error instanceof Error) detail = error.message
  else if (typeof error === 'string') detail = error

  return detail.trim() === ''
    ? 'The OBS connection test failed for an unknown reason.'
    : `The OBS connection test failed: ${detail.trim()}`
}
