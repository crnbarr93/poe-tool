/**
 * src/main/index.ts
 * =================
 *
 * The bootstrap. Creates the window, constructs every service in dependency order,
 * wires them to each other and to the IPC layer, and tears the whole thing down
 * exactly once on quit.
 *
 * This is one of exactly three files allowed to import `electron` (the others being
 * `src/main/ipc-handlers.ts` and `src/main/updater.ts`). Everything it assembles is
 * electron-free and therefore unit-testable on its own; this file is the seam where the
 * OS-specific facts enter the graph - the userData directory, the Videos directory, the
 * renderer URL, and the `safeStorage` cipher that `SettingsStore` encrypts passwords
 * with but may not import (see {@link makeSettingsCrypto}).
 *
 *
 * THE RENDERER IS NEVER ON THE CRITICAL PATH
 * ------------------------------------------
 * Log tailing, OBS connection and clipping all run to completion with zero windows
 * open. The window is a config UI: it is created after the services, it is optional,
 * and `IpcHandlerDeps.getWindow` is a FUNCTION so a window that is closed, crashed or
 * replaced by a dev-server reload is simply "no window right now" rather than a
 * broken reference. Nothing below awaits the renderer.
 *
 *
 * CONSTRUCTION ORDER IS A REAL DEPENDENCY ORDER, NOT A STYLE CHOICE
 * -----------------------------------------------------------------
 * ```text
 *   SettingsStore ─┬──► CharacterTracker ──────► LogWatcher ──► PoeEventBus
 *                  │            ▲   (per line)        │              │
 *                  │            └── level-up ─────────┘              │
 *                  │                                                 │
 *                  │                              ZoneTracker ◄──────┤
 *                  │                                    │            │
 *                  ├──► ClipLibrary ──┐                 │            │
 *                  ├──► ObsClient ────┴──► ReplayClipper ◄───────────┘  (death:self)
 *                  │                             │    │
 *                  │      StreamableClient ──┐   │    └── clip (POST-MOVE)
 *                  └──────────────────────── UploadQueue ◄─────────────┘
 *                                                │
 *                       registerIpcHandlers ◄────┴── clips + uploads + bus + obs + watcher
 *                                 ▲
 *                       AppUpdater ┘  (independent - depends on nothing, feeds only IPC)
 * ```
 *  - the bus must exist before the watcher (the watcher publishes onto it) and before
 *    the zone tracker, character tracker and clipper (they subscribe to it);
 *  - the character tracker must exist before the watcher, which asks it who "me" is
 *    once per LINE and hands level-ups back in, so that a level-up encountered
 *    mid-stream changes `isSelf` for the lines after it;
 *  - the zone tracker must exist before the clipper, which snapshots `zones.current`
 *    at death-admission time;
 *  - the clipper must exist before the upload queue, which subscribes to its POST-MOVE
 *    `clip` channel - NEVER to `death:self`, so no part of uploading can sit on the
 *    death path or delay a clip reaching disk;
 *  - `registerIpcHandlers` must run BEFORE `watcher.start()`, because it owns the
 *    `events:recent` ring buffer and anything published before it subscribes is lost
 *    to a window that opens later;
 *  - and it must also run before the UPLOAD QUEUE subscribes, which is why the queue is
 *    constructed, immediately `stop()`ped, and `start()`ed again after registration.
 *    `handleClip` publishes its first upload state synchronously inside the clipper's
 *    `clip` emit, and listeners fire in subscription order, so a queue that subscribed
 *    first would publish that state before the IPC layer had the clip in its
 *    `clips:recent` buffer - and for a clip whose first update is also its last
 *    (uploading off, or a clip that was never moved) that is the only update there will
 *    ever be. See the comment on `uploads.stop()` in {@link createServices}.
 *
 *
 * WHY SO MANY LITTLE ADAPTER OBJECTS
 * ----------------------------------
 * `ipc-handlers.ts` depends on structural PORTS, not on these classes (see its
 * header). Most of them are satisfied as-is - `SettingsStore` already IS a
 * `SettingsPort`, and `UploadQueue` already IS an `UploadPort`. The ones that are not
 * get a small adapter here, which is exactly where that adaptation belongs: this file
 * owns the wiring, and smearing it through the handlers would couple them to concrete
 * classes.
 *
 * The clip library gets one for a second reason: `ClipLibrary` is constructed with a
 * directory, but `settings.clips.libraryDir` can change at runtime. {@link makeClipTarget}
 * re-creates it when the setting moves, so a user who repoints their clips folder does
 * not have to restart the app.
 *
 * The Streamable adapters exist for a third reason, and it is the important one: the
 * upload queue deliberately declares its OWN error vocabulary rather than importing the
 * client's, so that every assumption about Streamable's unofficial upload endpoint stays
 * in one file. {@link toUploadError} and {@link makeUploadClient} are the seam where the
 * two vocabularies meet, and they are the only place in the app that knows both.
 *
 *
 * THE PASSWORD NEVER PASSES THROUGH THIS FILE'S HANDS FOR LONGER THAN AN `await`
 * ------------------------------------------------------------------------------
 * This repository is PUBLIC and the Streamable credential is a real account password.
 * {@link makeUploadClient} reads it out of the store at the moment of each request and
 * hands it straight to the one module allowed to build an `Authorization` header with
 * it. It is never captured on an adapter object, never given to the queue (which asks
 * `hasCredentials`, a boolean), and never passed to {@link log} - the credential
 * diagnostics below log a STATUS word, and the Streamable client's `onInternalError`
 * hook is given only its context string.
 *
 *
 * TEARDOWN AND macOS
 * ------------------
 * `window-all-closed` quits on Windows and Linux. On macOS it deliberately does NOT:
 * the platform convention is that the app stays alive with no windows, `activate`
 * re-opens one, and this app is explicitly designed to keep tailing and clipping with
 * no window at all. Real teardown hangs off `before-quit`, which fires on every route
 * out of the app (Cmd-Q, the last window on Windows, `app.quit()`), so there is exactly
 * one shutdown path and it is asynchronous-safe.
 */

import { join } from 'node:path'

import {
  app,
  BrowserWindow,
  safeStorage,
  shell,
  type BrowserWindowConstructorOptions
} from 'electron'

import type { WatcherStatus } from '../shared/events'
import type {
  ClipRecord,
  CredentialsStatusResult,
  StreamableTestRequest,
  StreamableTestResult
} from '../shared/ipc'
import { PoeEventBus } from './events/event-bus'
import { registerIpcHandlers, type CredentialsPort, type StreamablePort } from './ipc-handlers'
import { CharacterTracker } from './log/character-tracker'
import { LogWatcher } from './log/log-watcher'
import { ZoneTracker } from './log/zone-tracker'
import { ClipLibrary, type MoveClipOptions } from './obs/clip-library'
import { ObsClient } from './obs/obs-client'
import {
  isClipFailure,
  ReplayClipper,
  type ClipOutcome,
  type ClipTarget
} from './obs/replay-clipper'
import { SettingsStore, type SettingsCrypto } from './settings/store'
import { AppUpdater } from './updater'
import { StreamableClient, type StreamableError } from './upload/streamable-client'
import {
  UploadQueue,
  type UploadClient,
  type UploadClientResult,
  type UploadError,
  type UploadErrorKind,
  type UploadedVideo,
  type VideoReadiness,
  type VideoStatus
} from './upload/upload-queue'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sub-path under the OS Videos directory used when `clips.libraryDir` is unset. */
const DEFAULT_CLIPS_SUBDIR = ['poe-tool', 'clips'] as const

/** Window geometry. Tall and narrow: this is a settings panel, not a dashboard. */
const WINDOW_WIDTH = 960
const WINDOW_HEIGHT = 760
const WINDOW_MIN_WIDTH = 720
const WINDOW_MIN_HEIGHT = 520

/**
 * How long {@link shutdown} may take before we stop waiting and quit anyway.
 *
 * Every teardown step is documented as never rejecting, but `obs.dispose()` awaits a
 * socket close that a half-dead connection can leave pending forever. A process that
 * refuses to exit is worse than one that abandons a socket the OS is about to reclaim.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * The single logging sink. Everything this app swallows is reported through here, so
 * there is one place to point at a file logger later.
 *
 * Infallible on purpose: a logger must never be the reason the main process dies.
 */
function log(context: string, detail: unknown): void {
  try {
    console.error(`[poe-tool] ${context}`, detail)
  } catch {
    // stdout/stderr can be closed or redirected to a broken pipe in a packaged build.
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** Every long-lived service, plus the teardown for the IPC registration. */
interface Services {
  readonly settings: SettingsStore
  readonly bus: PoeEventBus
  readonly zones: ZoneTracker
  readonly characters: CharacterTracker
  readonly watcher: LogWatcher
  readonly obs: ObsClient
  readonly clipper: ReplayClipper
  readonly uploads: UploadQueue
  readonly updater: AppUpdater
  /**
   * Cancels the credential checks driven from `streamable:test`.
   *
   * SEPARATE FROM THE QUEUE'S OWN CONTROLLER, which `UploadQueue.dispose()` owns and
   * fires for the uploads and status polls it started. A `testCredentials` request comes
   * from the window rather than from the queue, so nothing else is holding a handle on
   * it, and a quit while one is in flight would otherwise sit on an open socket for the
   * full request timeout with `before-quit` waiting on it.
   */
  readonly streamableAbort: AbortController
  readonly disposeIpc: () => void
}

/**
 * Resolves the default clips directory from electron's Videos path.
 *
 * `app.getPath('videos')` THROWS when the OS cannot report the folder (a stripped
 * Windows install, a service account with no profile). That is not a reason to refuse
 * to boot: `""` is the documented "not resolved yet" value for
 * `ClipSettings.libraryDir`, and `ClipLibrary` already fails every move loudly rather
 * than dumping clips into the process CWD.
 *
 * Must be called AFTER `app.whenReady()` - `getPath` is not reliable before it.
 */
function defaultClipsDir(): string {
  try {
    return join(app.getPath('videos'), ...DEFAULT_CLIPS_SUBDIR)
  } catch (error) {
    log('paths/videos', error)
    return ''
  }
}

/**
 * Wraps electron's `safeStorage` as the {@link SettingsCrypto} pair `SettingsStore`
 * encrypts `obs.password` and `streamable.password` with.
 *
 * This function exists because `src/main/settings/store.ts` may not import electron, and
 * because `safeStorage` is NOT USABLE BEFORE `app.whenReady()` - on Linux it has to
 * resolve a keyring backend first, and asking early gets the wrong answer rather than an
 * error. Everything below therefore runs from `createServices`, which only ever runs
 * inside the `whenReady` continuation.
 *
 * BASE64, NOT A BUFFER. `encryptString` hands back a `Buffer`, but the value has to
 * survive `JSON.stringify` into a hand-editable text file and come back identical, and a
 * Buffer round-trips through JSON as `{"type":"Buffer","data":[...]}`. Base64 is the one
 * representation that stays a single opaque string that nobody is tempted to edit.
 *
 * WHAT IS GUARDED, AND WHAT MUST NOT BE
 * -------------------------------------
 * `isEncryptionAvailable()` is the only safeStorage call made during bootstrap, so it is
 * the only one whose throwing could abort startup - a platform without a keyring must
 * cost the user their stored passwords, never their app. It is wrapped, and a failure
 * degrades to `available: false`, which the store reads as "hold passwords for this
 * session and persist nothing".
 *
 * `encrypt` and `decrypt` are deliberately NOT wrapped, and that is load-bearing rather
 * than an oversight. They are only ever called from inside `SettingsStore`, which
 * catches both and - crucially - classifies them DIFFERENTLY: a `decrypt` throw is
 * `'undecryptable'` ("this file came from another machine; type your password again")
 * while an `encrypt` throw is `'unavailable'`. Swallowing a decrypt failure here and
 * returning `''` would collapse that distinction into a password field that merely looks
 * empty, which is precisely the silent failure the whole credential-status channel
 * exists to prevent.
 */
function makeSettingsCrypto(): SettingsCrypto {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch (error) {
    // Documented as throwing on a platform where the OS keyring is missing or broken.
    log('safe-storage/availability', error)
    available = false
  }

  return {
    available,
    encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher: string): string => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }
}

/**
 * Builds the `ClipTarget` the replay clipper writes through.
 *
 * Re-creates the underlying `ClipLibrary` whenever `settings.clips.libraryDir` moves,
 * so repointing the clips folder takes effect on the very next clip with no restart.
 * Comparing before re-creating matters: `moveClip` is called on the clip path and
 * allocating a library per clip would throw away nothing important but would obscure
 * that the directory is meant to be stable.
 */
function makeClipTarget(settings: SettingsStore): ClipTarget {
  let library = new ClipLibrary(settings.get().clips.libraryDir)

  return {
    moveClip: (options: MoveClipOptions): Promise<ClipRecord> => {
      const dir = settings.get().clips.libraryDir
      if (dir !== library.libraryDir) library = new ClipLibrary(dir)
      return library.moveClip(options)
    }
  }
}

// ---------------------------------------------------------------------------
// Streamable adapters
// ---------------------------------------------------------------------------

/**
 * Translates one {@link StreamableError} into the vendor-free {@link UploadError} the
 * upload queue reasons about.
 *
 * THIS FUNCTION IS THE WHOLE POINT OF THE SPLIT. `src/main/upload/streamable-client.ts`
 * owns every assumption about Streamable's HTTP surface; `src/main/upload/upload-queue.ts`
 * owns the retry policy and the user-facing wording and deliberately declares its own
 * error vocabulary (see its header on why `UploadClient` is declared there rather than
 * imported). The two never meet - this file is where they are joined, exactly like
 * {@link makeClipTarget} joins the clipper to a library whose directory can move.
 *
 * THE ONE MAPPING THAT IS A JUDGEMENT CALL is `unexpected-response`. The queue splits its
 * kinds by ONE question - is retrying worth anything - and that question has two answers
 * here:
 *  - a 5xx is Streamable having a bad day, which is `server-error` and IS retried;
 *  - anything else (a 4xx we do not recognise, or a 2xx whose body we could not narrow)
 *    is the UNDOCUMENTED endpoint's contract having moved, which is `bad-response`,
 *    is NOT retried, and produces the "poe-tool probably needs an update" message.
 * Collapsing both into `bad-response` would abandon a clip because Streamable restarted a
 * server; collapsing both into `server-error` would burn four attempts and 42 seconds
 * re-asking a question whose answer cannot change until this repository does.
 *
 * `message` is carried across verbatim: the client documents it as human-readable, safe
 * to render, and ALREADY SCRUBBED OF THE PASSWORD in every form (plaintext, base64
 * credential and full `Basic ...` header). Nothing is added to it here, because this
 * function has no secret in scope to add.
 *
 * PURE and TOTAL: never throws.
 */
function toUploadError(error: StreamableError): UploadError {
  return {
    kind: toUploadErrorKind(error),
    message: error.message,
    retryAfterMs: error.kind === 'rate-limited' ? error.retryAfterMs : null
  }
}

/** The `kind` half of {@link toUploadError}. EXHAUSTIVE, so a new vendor error kind is a compile error. */
function toUploadErrorKind(error: StreamableError): UploadErrorKind {
  switch (error.kind) {
    case 'auth-failed':
      return 'auth-failed'
    case 'file-too-large':
      return 'file-too-large'
    case 'file-unreadable':
      return 'file-unreadable'
    case 'network':
      return 'network'
    case 'rate-limited':
      return 'rate-limited'
    case 'timeout':
      return 'timeout'
    case 'aborted':
      return 'aborted'
    case 'unexpected-response':
      // See the note in `toUploadError`: 5xx is transient, everything else is a contract
      // change. A null status means the failure was in PARSING rather than in an HTTP
      // status, which is a contract change by definition.
      return error.status !== null && error.status >= 500 ? 'server-error' : 'bad-response'
    case 'processing-failed':
      // UNREACHABLE THROUGH EITHER `UploadClient` METHOD. It is only ever produced by
      // `awaitReady`, and `getVideoStatus` below intercepts it and reports it as the
      // readiness word `'error'` - which is what the queue is built to render, and which
      // says the true thing ("Streamable could not process this clip") instead of the
      // false one ("poe-tool needs an update"). This arm exists so the switch stays
      // total, not because anything depends on the value.
      return 'bad-response'
  }
}

/** Streamable's numeric video status, as the readiness word the queue speaks. */
function readinessFromStatus(status: number | undefined): VideoReadiness {
  // `undefined` is the ordinary "the video is not visible to us yet" case - the client
  // treats a 404 as pending and never reports a number for it - and "not visible yet" is
  // the earliest point of the same progression, so it reads as `uploading`.
  if (status === undefined) return 'uploading'
  return status === 1 ? 'processing' : 'uploading'
}

/**
 * Adapts the {@link StreamableClient} to the {@link UploadClient} the queue was written
 * against.
 *
 * READS THE STORE ON EVERY CALL rather than capturing the credential, and that is the
 * design rather than a convenience:
 *  - a password the user re-types in the config window takes effect on the very next
 *    upload, with nothing to invalidate and no copy to go stale. `UploadClient.reconfigure`
 *    is therefore deliberately NOT implemented - there is nothing to re-read, because
 *    nothing was ever cached. `UploadPort.reconfigure` in `./ipc-handlers.ts` is still
 *    called on every settings save; the queue's own half of it (reporting a backlog that
 *    is now switched off) is what does the work.
 *  - the plaintext exists only for the duration of one `await`, inside the module that
 *    puts it in an `Authorization` header. It is never stored on this object, never
 *    passed to the queue (which asks `hasCredentials`, a boolean), and never reaches an
 *    outcome, a log line or an IPC payload.
 */
function makeUploadClient(
  streamable: StreamableClient,
  settings: SettingsStore
): UploadClient {
  return {
    // A GETTER, not a captured boolean: the answer changes the moment the user saves
    // credentials, and the queue asks it again for every clip it admits.
    get hasCredentials(): boolean {
      const { email, password } = settings.get().streamable
      return email.trim() !== '' && password !== ''
    },

    upload: async (request): Promise<UploadClientResult<UploadedVideo>> => {
      const account = settings.get().streamable
      const result = await streamable.upload({
        filePath: request.filePath,
        email: account.email,
        password: account.password,
        // The queue already refused anything over this, so the client's own check can
        // only fire if the file grew between the two - but it costs nothing and keeps
        // the client usable on its own terms.
        maxBytes: account.maxFileBytes,
        signal: request.signal
      })
      if (!result.ok) return { ok: false, error: toUploadError(result.error) }
      // Narrowed to the two fields the queue's contract names. The client's own
      // `UploadedVideo` also carries the size and a status that the undocumented upload
      // response may or may not have contained; neither crosses this seam.
      return { ok: true, value: { shortcode: result.value.shortcode, url: result.value.url } }
    },

    getVideoStatus: async (shortcode, signal): Promise<UploadClientResult<VideoStatus>> => {
      const account = settings.get().streamable

      // ONE REQUEST, NOT A POLL LOOP. `awaitReady` is a loop by default, and the queue is
      // already one (`#awaitReady`, bounded by `maxStatusPolls` with its own interval).
      // Nesting them would multiply into hundreds of requests per clip to a third party,
      // which is how an app earns a rate limit. `maxWaitMs: 0` collapses it to a single
      // `GET /videos/{shortcode}` - the OFFICIAL, documented endpoint - and hands the
      // schedule back to the queue, which is where it belongs.
      //
      // The consequence is that "not ready yet" comes back as a `timeout` error rather
      // than as data, so the numeric status is captured through `onStatus` on the way
      // past. An array rather than a mutable `number | null`, because a value assigned
      // only inside a callback stays narrowed to its initialiser as far as the compiler
      // is concerned.
      const observed: number[] = []

      const result = await streamable.awaitReady(shortcode, {
        email: account.email,
        password: account.password,
        signal,
        maxWaitMs: 0,
        onStatus: (status) => {
          observed.push(status)
        }
      })

      if (result.ok) return { ok: true, value: { readiness: 'ready', message: null } }

      // Streamable took the video and its own transcode failed. NOT a client failure:
      // this is an answer, and the queue renders it as such (naming the local file and
      // suggesting a manual re-upload) rather than as "we could not check".
      if (result.error.kind === 'processing-failed') {
        return { ok: true, value: { readiness: 'error', message: result.error.message } }
      }

      // `shortcode !== null` distinguishes "we asked and it is still working" - the
      // expected outcome of `maxWaitMs: 0`, and an ordinary in-progress answer - from a
      // request that genuinely timed out on the wire, which has no shortcode and is a
      // transient failure the queue should keep polling through.
      if (result.error.kind === 'timeout' && result.error.shortcode !== null) {
        return { ok: true, value: { readiness: readinessFromStatus(observed.at(-1)), message: null } }
      }

      return { ok: false, error: toUploadError(result.error) }
    }
  }
}

/**
 * Adapts the {@link StreamableClient} to the {@link StreamablePort} the `streamable:test`
 * handler calls.
 *
 * ONLY THE MESSAGE CROSSES BACK. `StreamableError.message` is documented as
 * human-readable and as having been scrubbed of the password in all three forms it could
 * appear in; the rest of the error (a status, a body snippet, a byte count) stays in the
 * main process. The credentials come IN from the handler, which has already substituted
 * the stored password for the renderer's redacted blank.
 *
 * The app-level `signal` is what lets a quit cancel a check that is sitting on a socket.
 */
function makeStreamablePort(
  streamable: StreamableClient,
  signal: AbortSignal
): StreamablePort {
  return {
    testCredentials: async (request: StreamableTestRequest): Promise<StreamableTestResult> => {
      const result = await streamable.testCredentials(request.email, request.password, { signal })
      return result.ok ? { ok: true } : { ok: false, error: result.error.message }
    }
  }
}

/**
 * Adapts {@link SettingsStore.credentials} to {@link CredentialsPort}.
 *
 * A three-line adapter rather than passing the store, for the reason the header gives:
 * `credentials` is a GETTER, and a plain object literal built once at wiring time would
 * snapshot it forever - so a password re-typed after a failed decrypt would keep
 * reporting `'undecryptable'` until the app restarted. This keeps the read live.
 */
function makeCredentialsPort(settings: SettingsStore): CredentialsPort {
  return {
    status: (): CredentialsStatusResult => settings.credentials
  }
}

/**
 * Constructs and wires every service. Performs no I/O beyond reading `settings.json`
 * and does NOT start the watcher - {@link start} does that, after the IPC layer is
 * listening.
 */
function createServices(getWindow: () => BrowserWindow | null): Services {
  // 1. Settings first: everything else reads from it. `load()` never throws - a
  //    corrupt or missing file, or a password blob this machine cannot decrypt, all
  //    resolve to something usable, because a user who mangled their settings needs a
  //    working settings UI to fix them in.
  const settings = new SettingsStore({
    dir: app.getPath('userData'),
    defaultLibraryDir: defaultClipsDir(),
    crypto: makeSettingsCrypto()
  })
  settings.load()

  // Nothing in this app fails silently, and a password that did not come back is the
  // easiest failure in it to miss: uploads simply stop, and the settings field looks the
  // same as it does on a fresh install. The window reports this properly through
  // `credentials:status`; this line is for the case where there is no window - a
  // console-launched build, or a bug report with a log and no screenshot.
  //
  // The STATUS is logged, never the secret: `CredentialSlotStatus` carries facts about a
  // password and never the password itself, which is the entire reason it exists.
  const credentials = settings.credentials
  for (const [slot, state] of Object.entries(credentials)) {
    if (state.status !== 'ok') log(`settings/credentials/${slot}`, state.status)
  }

  // 2. The bus. Every producer publishes through it; every consumer subscribes to it.
  const bus = new PoeEventBus({
    onListenerError: (error, channel) => {
      log(`bus/${String(channel)}`, error)
    }
  })

  // 3. Derived state. Subscribes in its constructor, so it is armed before any
  //    producer can run.
  const zones = new ZoneTracker({
    bus,
    onError: (error) => {
      log('zone-tracker', error)
    }
  })

  // 4. Who counts as "me". Built BEFORE the watcher because the watcher consumes it
  //    per line, and it reads/writes settings through four narrow callbacks rather
  //    than being handed the store - so it cannot be the thing that decides what else
  //    lives in settings.json.
  //
  //    `persist` is what makes a single level-up survive a restart, which is the
  //    entire point: level-ups are sparse enough that a level-98 character can play
  //    for weeks without producing one. `save` throws on a failed write; the tracker
  //    contains that and keeps the detection for the session.
  const characters = new CharacterTracker({
    bus,
    getOverride: () => settings.get().character.override,
    getPersisted: () => {
      const { detected, detectedClass, detectedLevel } = settings.get().character
      return { name: detected, className: detectedClass, level: detectedLevel }
    },
    persist: (detection) => {
      settings.save({
        character: {
          detected: detection.name,
          detectedClass: detection.className,
          detectedLevel: detection.level
        }
      })
    },
    onError: (error) => {
      log('character-tracker', error)
    }
  })

  // 5. The producer. `publish` is delegated to the bus so the live tail and
  //    `replay()` share one fan-out implementation - see the bus's header.
  //
  //    `characters` is NOT optional in practice: without it the watcher has no way to
  //    resolve who "me" is, so every `DeathEvent.isSelf` would be false and the
  //    clipper would sit idle for the whole session without a single error anywhere.
  //    It is passed as `.characterSource` - the two-way view - because the watcher
  //    both reads the resolved name per line and hands level-ups back in.
  const watcher = new LogWatcher({
    bus,
    getSettings: () => settings.get(),
    characters: characters.characterSource,
    publish: (result) => {
      bus.publish(result)
    },
    onError: (error) => {
      log('log-watcher', error)
    }
  })

  // 6. OBS. Not connected yet; `start()` decides that from `obs.autoConnect`.
  const obs = new ObsClient({
    onInternalError: (error, context) => {
      log(`obs/${context}`, error)
    }
  })

  // 7. The clip pipeline. The clipper subscribes to `death:self` in its constructor,
  //    which is why the bus and the zone tracker have to exist by now.
  const clipper = new ReplayClipper({
    bus,
    obs,
    library: makeClipTarget(settings),
    getSettings: () => settings.get(),
    getZone: () => zones.current,
    onInternalError: (error, context) => {
      log(`clipper/${context}`, error)
    }
  })

  // Every death produces an outcome, including the ones that never become a file.
  // Only the failures are worth a line in the log; `push:clip` carries the successes.
  clipper.on('outcome', (outcome: ClipOutcome) => {
    if (isClipFailure(outcome)) log(`clip/${outcome.kind}`, outcome.message)
  })

  // 7b. Streamable. THE UPLOAD ENDPOINT IS UNOFFICIAL - every assumption about it lives
  //     in `./upload/streamable-client.ts` and that file's header is the one to read
  //     before touching any of this. Constructing it does nothing: it holds no
  //     connection, no credential and no state, and the first byte only leaves the
  //     machine when a clip is filed with uploading switched on.
  //
  //     `onInternalError` is handed the value a caller-supplied callback threw. It is
  //     logged as a CONTEXT ONLY, never with the error's own text, because the one thing
  //     that could plausibly be inside such a value is a request dump - and this repo is
  //     public.
  const streamableAbort = new AbortController()
  const streamable = new StreamableClient({
    onInternalError: (_error, context) => {
      log('streamable', context)
    }
  })

  // 7c. The upload pipeline. Subscribes to the clipper's POST-MOVE `clip` channel - not
  //     to `death:self` - so nothing here can ever sit on the death path or delay a clip
  //     reaching disk. See the queue's header: the local file is the artefact, the
  //     upload is a courtesy.
  //
  //     IT IS DETACHED AGAIN IMMEDIATELY, AND RE-ATTACHED AFTER `registerIpcHandlers`.
  //     That is not fussiness, it is an ordering bug being closed. `handleClip` runs
  //     SYNCHRONOUSLY inside the clipper's `clip` emit and publishes its first upload
  //     state (`pending`, `disabled` or `skipped`) before that emit returns. Listeners
  //     fire in subscription order, so with the queue subscribed first, that first
  //     update would be published BEFORE the IPC layer had put the clip in its
  //     `clips:recent` ring buffer - the update would find no row to fold itself into
  //     and be dropped, and the buffer would keep answering with the clip's birth state
  //     forever. For a clip whose first update is also its LAST (uploading switched off,
  //     or a clip that was never moved) that is the only update there will ever be, so a
  //     window opened later would show a permanently wrong row. Re-subscribing here puts
  //     the queue behind the IPC layer, where its updates always find the record.
  const uploads = new UploadQueue({
    clips: clipper,
    client: makeUploadClient(streamable, settings),
    getSettings: () => settings.get(),
    onInternalError: (error, context) => {
      log(`uploads/${context}`, error)
    }
  })
  uploads.stop()

  // 8. Auto-update. Depends on NOTHING above it and feeds nothing below it - it is here
  //    purely so the IPC layer can push its state at the window. Constructing it is
  //    cheap: in an unpackaged build it pins itself to `disabled-in-dev` and never
  //    touches electron-updater at all, and in a packaged one it only attaches
  //    listeners. The single network check is deferred to `start()`.
  //
  //    IT ALSO CANNOT THROW, which matters more than it looks: a throw here would leave
  //    `services` null, so `openWindow()` and `watcher.start()` below would never run
  //    and the user would get a process holding the single-instance lock and nothing
  //    else - no window, no tailing, no clips - because an update check went wrong.
  //    That guarantee lives in `AppUpdater`'s constructor, which wraps its own attach
  //    (electron-updater's platform updater throws on a non-semver app version); see
  //    RULE 2 in `./updater.ts`. Do not weaken it there without adding a guard here.
  //
  //    It deliberately does NOT subscribe to the bus and is NOT drained on shutdown
  //    beyond removing its listeners: a downloaded update installs from
  //    electron-updater's own `quit` handler, long after everything here is torn down.
  const updater = new AppUpdater({
    onError: (error, context) => {
      log(`updater/${context}`, error)
    },
    onInfo: (message, context) => {
      log(`updater/${context}`, message)
    }
  })

  // 9. IPC last, and BEFORE the watcher starts - it owns the `events:recent` ring
  //    buffer, and anything published before it subscribes is invisible to a window
  //    that opens later in the session.
  const disposeIpc = registerIpcHandlers({
    settings,
    bus,
    obs,
    clipper,
    // `AppUpdater` satisfies `UpdaterPort` as-is: `state` is a getter and `on`/`off`
    // mirror `TypedEmitter`, exactly like `ObsClient` does for `ObsPort`.
    updater,
    // `CharacterTracker` satisfies `CharacterPort` as-is: `active()` and
    // `refreshOverride()` are both methods, and the port asks for exactly those two.
    // Passed by reference rather than adapted, so the IPC layer calls them as members
    // and the class's `#` private state resolves - see the port's own note on that.
    characters,
    // `LogWatcher.status` is a getter and `reconfigure()` matches the port exactly, but
    // `WatcherPort` is a plain object type - an adapter keeps the getter live rather
    // than snapshotting `status` once at wiring time.
    watcher: {
      get status(): WatcherStatus {
        return watcher.status
      },
      reconfigure: () => watcher.reconfigure()
    },
    streamable: makeStreamablePort(streamable, streamableAbort.signal),
    // `UploadQueue` satisfies `UploadPort` as-is: `reconfigure()` is a method and
    // `on`/`off` mirror `TypedEmitter`, exactly like `ObsClient` does for `ObsPort`.
    uploads,
    credentials: makeCredentialsPort(settings),
    getWindow,
    onError: (error, context) => {
      log(`ipc/${context}`, error)
    }
  })

  // 10. NOW the upload queue may listen. Everything above this line is why - see the
  //     comment on `uploads.stop()`. `start()` is idempotent and appends, so from here on
  //     a saved clip reaches the IPC ring buffer before its first upload update does.
  uploads.start()

  return {
    settings,
    bus,
    zones,
    characters,
    watcher,
    obs,
    clipper,
    uploads,
    updater,
    streamableAbort,
    disposeIpc
  }
}

/**
 * Brings the services to life: starts the tail loop and, if configured, opens the OBS
 * connection.
 *
 * NEVER REJECTS. A failure to attach to the log or to reach OBS is a state the UI
 * renders, not a reason to abort startup.
 */
async function start(services: Services): Promise<void> {
  try {
    await services.watcher.start()
  } catch (error) {
    log('startup/watcher', error)
  }

  // Fire-and-forget, and deliberately AFTER the watcher: an update check is the least
  // important thing this process does and must never delay the tail loop attaching.
  // `checkOnLaunch` is documented as never rejecting - a `.catch` is attached anyway
  // because an unhandled rejection here would be reported as an app-level defect.
  try {
    void services.updater.checkOnLaunch().catch((error: unknown) => {
      log('startup/update-check', error)
    })
  } catch (error) {
    log('startup/update-check', error)
  }

  const { obs } = services.settings.get()
  if (!obs.autoConnect) return

  try {
    // Fire-and-forget: a connect can sit for the full 10s timeout, and the window must
    // not wait on it. The renderer learns the outcome from `push:obs-status`.
    void services.obs
      .connect(
        { host: obs.host, port: obs.port, password: obs.password },
        { autoReconnect: true }
      )
      .catch((error: unknown) => {
        log('startup/obs-connect', error)
      })
  } catch (error) {
    log('startup/obs-connect', error)
  }
}

/**
 * Tears everything down, in reverse dependency order.
 *
 * NEVER REJECTS and is idempotent at the call site ({@link quitting} guards re-entry).
 * Each step is individually guarded so that one failure cannot leave a later timer or
 * socket alive - which, in a `before-quit` handler, means a process that never exits.
 */
async function shutdown(services: Services): Promise<void> {
  // 1. Stop producing. Kills the poll timer and drops the reader, so nothing new
  //    reaches the bus while the rest is coming down.
  try {
    services.watcher.stop()
  } catch (error) {
    log('shutdown/watcher', error)
  }

  // 2. Detach the IPC layer: no more `webContents.send` into a window that is being
  //    destroyed, and every `ipcMain` handler removed.
  try {
    services.disposeIpc()
  } catch (error) {
    log('shutdown/ipc', error)
  }

  // 2b. Detach the updater. Removes every listener it put on electron-updater's module
  //     singleton (which outlives this instance) and on its own emitter.
  //
  //     It does NOT cancel a download and does NOT disarm install-on-quit, and must not:
  //     applying a downloaded update on quit is the whole design, and electron-updater
  //     drives that from its own `app.on('quit')` handler, which is untouched by this.
  try {
    services.updater.dispose()
  } catch (error) {
    log('shutdown/updater', error)
  }

  // 3. Drain the clipper BEFORE closing OBS: a clip mid-move must not be abandoned
  //    half-copied. `dispose()` detaches from the bus first, so nothing new is
  //    admitted while it drains.
  try {
    await services.clipper.dispose()
  } catch (error) {
    log('shutdown/clipper', error)
  }

  // 3b. The upload pipeline, AFTER the clipper - `clipper.dispose()` above drains a clip
  //     that was mid-move, and the record it emits at the end of that must still be
  //     admitted rather than arriving at a queue that has stopped listening.
  //
  //     ABORTS, IT DOES NOT WAIT. `dispose()` fires the queue's AbortController first, so
  //     a 200 MB upload sitting on a domestic uplink is cancelled rather than held open
  //     while `before-quit` waits on it, and every clip still queued is walked out with a
  //     visible `skipped` outcome. The clips themselves are untouched: a cancelled upload
  //     costs the upload and nothing else.
  try {
    await services.uploads.dispose()
  } catch (error) {
    log('shutdown/uploads', error)
  }

  // 3c. And the credential check, which is the one Streamable request the queue's own
  //     controller does not cover: it is started from `streamable:test` on behalf of the
  //     window, so nothing else holds a handle on it.
  try {
    services.streamableAbort.abort()
  } catch (error) {
    log('shutdown/streamable', error)
  }

  try {
    services.zones.stop()
  } catch (error) {
    log('shutdown/zones', error)
  }

  // Detaching the character tracker keeps its DETECTION - `stop()` only unsubscribes.
  // That matters because the last thing persisted is what identifies the player on the
  // next launch, and level-ups are far too sparse to re-learn on demand.
  try {
    services.characters.stop()
  } catch (error) {
    log('shutdown/characters', error)
  }

  // 4. OBS last: it holds the socket and the reconnect timer, and step 3 may still
  //    have needed it.
  try {
    await services.obs.dispose()
  } catch (error) {
    log('shutdown/obs', error)
  }

  // 5. Finally drop every remaining subscriber, so a listener that outlived its owner
  //    cannot be reached by a straggling emit.
  try {
    services.bus.removeAllListeners()
  } catch (error) {
    log('shutdown/bus', error)
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Creates the config window.
 *
 * SECURITY POSTURE, all three of which are load-bearing:
 *  - `contextIsolation: true` - the preload runs in its own world, so the renderer
 *    cannot reach `ipcRenderer` even if it can reach `window.poeTool`;
 *  - `nodeIntegration: false` - no `require` in the renderer, ever;
 *  - `sandbox: true` - the renderer process runs under the OS sandbox. This is
 *    compatible with our preload because `src/preload/index.ts` imports ONLY
 *    `electron` (`contextBridge` + `ipcRenderer`), which a sandboxed preload still
 *    gets. Adding a `node:*` import there would break at runtime, not compile time,
 *    which is why it is called out here as well as in the preload's header.
 *
 * `show: false` + `ready-to-show` avoids the white flash of an empty BrowserWindow.
 */
function createWindow(): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#12131a',
    title: 'poe-tool',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The renderer talks to exactly one origin - itself. Nothing here fetches.
      webSecurity: true
    }
  }

  const win = new BrowserWindow(options)

  win.on('ready-to-show', () => {
    win.show()
  })

  // A config UI has no business navigating anywhere, and an external link that opened
  // INSIDE the app would be a full-window browser with our preload attached.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch((error: unknown) => {
      log('shell/open-external', error)
    })
    return { action: 'deny' }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    log('renderer/gone', details)
  })

  // Same reasoning for in-page navigation: replacing the document would hand a
  // remote origin our preload bridge. The dev server's own URL is the one exception.
  win.webContents.on('will-navigate', (event, url) => {
    const devTarget = process.env['ELECTRON_RENDERER_URL']
    if (devTarget !== undefined && devTarget !== '' && url.startsWith(devTarget)) return
    event.preventDefault()
    log('renderer/navigation-blocked', url)
  })

  // electron-vite sets ELECTRON_RENDERER_URL in dev (HMR); a packaged build loads the
  // built HTML from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && devUrl !== '') {
    void win.loadURL(devUrl).catch((error: unknown) => {
      log('window/load-url', error)
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html')).catch((error: unknown) => {
      log('window/load-file', error)
    })
  }

  return win
}

// ---------------------------------------------------------------------------
// Application lifecycle
// ---------------------------------------------------------------------------

/**
 * The live window, or null when there is none.
 *
 * Read through a closure by the IPC layer rather than captured, precisely so that
 * "there is no window right now" is an ordinary, expected state.
 */
let mainWindow: BrowserWindow | null = null

/** Set once the services exist. Null before `whenReady` and after a failed bootstrap. */
let services: Services | null = null

/** Guards {@link shutdown} against the re-entrant `before-quit` that follows it. */
let quitting = false

/**
 * Creates the window and keeps {@link mainWindow} honest about its lifetime.
 *
 * The `closed` hook is the whole point: without it `getWindow()` would keep handing
 * the IPC layer a destroyed window, and every push would take the `isDestroyed()`
 * branch forever instead of the app simply having no window.
 */
function openWindow(): void {
  const win = createWindow()
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

/**
 * Process-level nets.
 *
 * An unhandled rejection is fatal by default in modern node, and every one of them in
 * this codebase would be a bug in a `void promise.catch(...)` chain somewhere - a real
 * defect, but never a reason to kill a running capture session in front of the user.
 * Logging and continuing is the right trade for a companion app: the alternative is
 * the app vanishing mid-map with no explanation.
 *
 * An uncaught EXCEPTION is treated the same way for the same reason, but it is worth
 * being honest that the process state after one is less trustworthy than after a
 * stray rejection.
 */
process.on('unhandledRejection', (reason) => {
  log('unhandled-rejection', reason)
})

process.on('uncaughtException', (error) => {
  log('uncaught-exception', error)
})

/**
 * BEST-EFFORT: route a console Ctrl-C (or a `kill` from a script) through the SAME
 * teardown as a normal quit, instead of terminating where the process stands and
 * abandoning a clip mid-move.
 *
 * "Best-effort" is measured, not hedged: on macOS, Chromium installs its own handlers
 * in the browser process and neither SIGINT nor SIGTERM reaches node here - verified
 * by sending both to a running build and watching it ignore them. The handlers are
 * kept because they DO fire for a console-launched build on Windows, which is the
 * target platform and the one where `npm run dev` is Ctrl-C'd all day.
 *
 * Nothing depends on this: the real teardown contract is `before-quit`, which fires
 * on every route a user can actually take out of the app.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.quit()
  })
}

/**
 * A second instance would tail the same Client.txt and race the first one to save the
 * same replay buffer, producing duplicate clips and a debounce window that means
 * nothing. Hand focus to the instance that is already running instead.
 */
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(
    () => {
      let created: Services
      try {
        // The closure - not `mainWindow`'s current value - is what lets the window be
        // closed, re-created or replaced by a dev reload without re-registering IPC.
        created = createServices(() => mainWindow)
      } catch (error) {
        // Nothing below can work without the services. Report loudly and leave the
        // process up so the failure is visible in a terminal rather than silent.
        log('bootstrap', error)
        return
      }
      services = created

      openWindow()

      // Services first, window second, and `start` last: the IPC layer is already
      // subscribed by now, so the first lines the watcher reads reach the ring buffer.
      void start(created)
    },
    (error: unknown) => {
      log('bootstrap/ready', error)
    }
  )

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open must re-create one. The
    // services are untouched by this - they never depended on a window existing.
    if (BrowserWindow.getAllWindows().length > 0) return
    openWindow()
  })

  app.on('window-all-closed', () => {
    // macOS convention: stay resident so `activate` can re-open. Everywhere else,
    // closing the last window means quitting - which routes through `before-quit`
    // below, the single teardown path.
    if (process.platform === 'darwin') return
    app.quit()
  })

  app.on('before-quit', (event) => {
    // Re-entrant: `app.quit()` at the end of the async teardown fires this again, and
    // that pass must fall straight through so the quit actually happens.
    if (quitting) return
    quitting = true

    const current = services
    if (current === null) return

    // Teardown is asynchronous (a clip may be mid-move, a socket mid-close), so the
    // quit has to be deferred until it finishes.
    event.preventDefault()

    const done = (): void => {
      services = null
      app.quit()
    }

    void Promise.race([
      shutdown(current),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()
      })
    ]).then(done, (error: unknown) => {
      log('shutdown', error)
      done()
    })
  })
}
