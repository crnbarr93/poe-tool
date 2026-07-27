/**
 * src/main/updater.ts
 * ===================
 *
 * electron-updater, wrapped so it cannot hurt anything.
 *
 * This is the FOURTH file allowed to import `electron` (after `src/main/index.ts`,
 * `src/main/ipc-handlers.ts` and - through an injected directory - `src/main/settings/store.ts`),
 * and the only one allowed to import `electron-updater`. Every DECISION it makes is
 * delegated to `./update-state.ts`, which imports neither and is unit-tested directly
 * with no mocks at all - see that file's header for why the split exists. What is left
 * here is wiring, and the three rules below are what that wiring is for;
 * `test/updater.test.ts` mocks both modules to hold this file to them.
 *
 *
 * ============================================================================
 * RULE 1: IT DOES NOTHING AT ALL WHEN THE APP IS NOT PACKAGED
 * ============================================================================
 * `electron-vite dev` runs from `out/` with no `app-update.yml` beside it. In that
 * situation electron-updater has no provider configuration, no `currentVersion` it can
 * trust, and - depending on version - either logs a skip or throws outright.
 *
 * THIS IS THE SINGLE MOST LIKELY WAY TO BREAK THE DEVELOPER LOOP, so the guard is
 * explicit and it is checked BEFORE the `autoUpdater` export is ever touched:
 *
 *   - {@link AppUpdater.enabled} is `app.isPackaged`, read once in the constructor;
 *   - when it is false, NOT ONE listener is attached, NOT ONE property is assigned, and
 *     `checkForUpdates()` is never called. The state is pinned to `disabled-in-dev`,
 *     which `reduceUpdateState` treats as terminal.
 *
 * Never touching the export matters more than it looks. `electron-updater`'s
 * `autoUpdater` is a lazy getter that constructs a platform updater on first ACCESS,
 * and on macOS that constructor reaches for electron's own native `autoUpdater` and
 * attaches listeners to it - inside an unsigned dev build, which is exactly where that
 * is least welcome. So dev does not merely skip the check; it never instantiates the
 * thing.
 *
 * (electron-updater 6.8.9 happens to guard `checkForUpdates()` with its own
 * `isUpdaterActive()` check and resolve `null` when unpackaged. That is a happy
 * accident of the current version, not a contract, and it does nothing about the
 * construction-on-access problem above. The guard here stays.)
 *
 *
 * ============================================================================
 * RULE 2: IT CAN NEVER CRASH THE MAIN PROCESS
 * ============================================================================
 * `autoUpdater` is a node EventEmitter, and an `'error'` emitted on an EventEmitter with
 * NO `'error'` listener is rethrown - which in the main process means the app dies.
 * Offline, DNS failure, GitHub down, a corporate proxy, a rate limit: all of them emit
 * `'error'`. poe-tool's job is to tail a log file and save clips, and it must keep doing
 * that on a machine with no internet at all.
 *
 * So {@link AppUpdater.#attach} registers the `'error'` handler FIRST, before any other
 * listener and before any property assignment or call. Do not reorder it.
 *
 * That listener covers the EMITTED failures. There are two other routes out of
 * electron-updater that never touch it, and each has its own belt:
 *
 *   1. REJECTED PROMISES. `checkForUpdates()` both emits `'error'` and returns a
 *      rejected promise for the same failure, so {@link AppUpdater.checkOnLaunch}
 *      catches it. It ALSO hands back a `downloadPromise` - the auto-download it just
 *      started - and electron-updater attaches nothing to that one in the auto path
 *      (only `checkForUpdatesAndNotify`, which this file does not use, does). A
 *      download that dies half way through - Wi-Fi drops, GitHub 403s the asset, the
 *      disk fills - therefore rejects into nobody's hands unless the result is caught,
 *      so `checkOnLaunch` catches that too. An unhandled rejection is fatal by default
 *      in modern node; `src/main/index.ts` keeps a process-wide net, but that net is
 *      for BUGS, and relying on it here would make an ordinary flaky download print a
 *      line that reads like an app defect.
 *
 *   2. A SYNCHRONOUS THROW OUT OF THE CONSTRUCTOR. Merely ACCESSING the `autoUpdater`
 *      export constructs the platform updater (see RULE 1), and that constructor throws
 *      `ERR_UPDATER_INVALID_VERSION` when `app.getVersion()` is not valid semver -
 *      a `"version": "0.2"` in package.json packages and ships perfectly happily, and
 *      only detonates on the user's machine. Unguarded, that throw would escape
 *      `createServices()` and take the ENTIRE bootstrap with it: no window, no log
 *      tailing, no clipping, because the update check failed. So the constructor wraps
 *      {@link AppUpdater.#attach} and degrades to a reported `error` state instead.
 *      The guarantee is structural, not an assumption about what the library does.
 *
 * A failed update is a logged non-event. The user is told nothing beyond a quiet line in
 * the config window they may never open.
 *
 *
 * ============================================================================
 * RULE 3: THE APP IS NEVER RESTARTED OUT FROM UNDER A CLIP
 * ============================================================================
 * `autoInstallOnAppQuit = true` and `quitAndInstall()` is NEVER called. The installer
 * downloads in the background and is applied only when the user quits of their own
 * accord.
 *
 * This is not politeness. `ReplayClipper` can have a save in flight - OBS flushing
 * seconds of buffered video to disk, then a cross-volume copy into the clips library -
 * and `src/main/index.ts` deliberately drains it during `before-quit`. Forcing a restart
 * mid-session would abandon a clip half-copied, i.e. lose the exact thing the app exists
 * to capture, in order to deliver an update nobody asked for right then.
 *
 *
 * ON `autoUpdater.logger = null`
 * -----------------------------
 * electron-updater defaults to logging through `console`, which in a packaged Windows
 * GUI app goes to a stdout nobody is reading. Its useful output is duplicated by the
 * events we already subscribe to, so it is switched off and this file reports through
 * the injected hooks instead - keeping one diagnostic sink, the one `src/main/index.ts`
 * owns.
 */

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type {
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo
} from 'electron-updater'

import type { UpdateState } from '../shared/ipc'
import { TypedEmitter } from './events/typed-emitter'
import type { EventListener } from './events/typed-emitter'
import {
  clampPercent,
  describeUpdateError,
  DISABLED_UPDATE_STATE,
  formatUpdatePercent,
  IDLE_UPDATE_STATE,
  normalizeVersion,
  reduceUpdateState,
  type UpdaterEvent
} from './update-state'

// ---------------------------------------------------------------------------
// Emitter contract
// ---------------------------------------------------------------------------

/**
 * What {@link AppUpdater} broadcasts. Mirrors `ObsClientEventMap` deliberately: the IPC
 * layer consumes both through the same `state` channel shape.
 */
export interface AppUpdaterEventMap {
  /** Emitted on every real state change, and never when the state did not move. */
  state: [UpdateState]
}

/** Construction options. Both hooks are optional and both default to doing nothing. */
export interface AppUpdaterOptions {
  /**
   * Diagnostic sink for failures this class swallows. Every one of them is swallowed.
   *
   * Purely observational - a hook that throws is itself swallowed, because a logger must
   * never be the reason the main process dies.
   */
  readonly onError?: (error: unknown, context: string) => void
  /**
   * Diagnostic sink for the ordinary, non-failure narration: "disabled in dev",
   * "update 0.2.0 available", "42%", "ready, installs on quit".
   *
   * Separate from {@link onError} on purpose. Routing "auto-update is off because this
   * is a dev build" through an error channel would make a normal, expected, every-single-
   * `npm run dev` condition look like a defect in the logs.
   */
  readonly onInfo?: (message: string, context: string) => void
}

// ---------------------------------------------------------------------------
// AppUpdater
// ---------------------------------------------------------------------------

/**
 * Owns the app's one auto-update conversation.
 *
 * ```ts
 * const updater = new AppUpdater({ onError, onInfo })
 * updater.on('state', (state) => { ... })   // push it at the renderer
 * void updater.checkOnLaunch()              // fire and forget
 * // ... later, from before-quit:
 * updater.dispose()
 * ```
 *
 * NO PUBLIC METHOD REJECTS OR THROWS, AND NEITHER DOES THE CONSTRUCTOR.
 * {@link checkOnLaunch} resolves once the check has settled however it settled;
 * {@link dispose} is idempotent; {@link state} is a stored value; and a failure to
 * attach to electron-updater at all becomes an `error` state (see RULE 2 in the file
 * header) rather than an exception the caller has to handle.
 */
export class AppUpdater {
  readonly #emitter = new TypedEmitter<AppUpdaterEventMap>()
  readonly #onError: (error: unknown, context: string) => void
  readonly #onInfo: (message: string, context: string) => void

  /**
   * Detach functions for every listener attached to the `autoUpdater` SINGLETON,
   * paired with their registration at the point of registration.
   *
   * The singleton is the reason this list exists at all: `autoUpdater` is one
   * module-level object for the life of the process, so a second `AppUpdater` (a
   * dev-server reload, a bootstrap retry) would stack a second full set of listeners on
   * it and every state change would be emitted twice.
   */
  readonly #detach: Array<() => void> = []

  /** False in `electron-vite dev`. See RULE 1 in the file header. */
  readonly #enabled: boolean

  #state: UpdateState
  #disposed = false

  constructor(options: AppUpdaterOptions = {}) {
    this.#onError = wrapHook(options.onError)
    this.#onInfo = wrapHook(options.onInfo)

    // Read once. `app.isPackaged` is a fixed fact about the running binary and cannot
    // change, so re-reading it later could only introduce disagreement.
    this.#enabled = app.isPackaged
    this.#state = this.#enabled ? IDLE_UPDATE_STATE : DISABLED_UPDATE_STATE

    if (!this.#enabled) {
      this.#onInfo(
        'Auto-update is DISABLED: this build is not packaged, so there is no app-update.yml to read. ' +
          'This is normal for `npm run dev`; a packaged installer updates itself from GitHub Releases.',
        'disabled-in-dev'
      )
      return
    }

    // SEE RULE 2, ROUTE 2 IN THE FILE HEADER. `#attach()`'s first statement touches the
    // `autoUpdater` export, which constructs the platform updater on first access, and
    // that construction can throw. Everything below this line exists so that such a
    // throw becomes an `error` state nobody has to care about, rather than an exception
    // escaping `new AppUpdater()` and aborting the bootstrap that owns log tailing and
    // clipping. Do not "simplify" this back to a bare call.
    try {
      this.#attach()
    } catch (error) {
      this.#onError(error, 'attach')
      // Assigned directly rather than through `#apply`, because `dispose()` below pins
      // the instance shut and `#apply` refuses to record after that - and because there
      // is nobody subscribed yet at construction time, so there is nothing to emit at.
      this.#state = { state: 'error', message: describeUpdateError(error) }
      // Removes whatever listeners DID get registered before the throw (the `'error'`
      // one is registered first, so there is usually at least one), and makes
      // `checkOnLaunch()` a no-op. A half-attached updater must not go on to run a
      // network check against a singleton it never finished configuring.
      this.dispose()
    }
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /** Current update state. Cheap - a stored value, not a probe. Never triggers a check. */
  get state(): UpdateState {
    return this.#state
  }

  /**
   * False in an unpackaged build. Exposed so a caller can skip work rather than having
   * to compare {@link state} against a string literal.
   */
  get enabled(): boolean {
    return this.#enabled
  }

  /** Subscribes to a channel. Mirrors `TypedEmitter.on`. */
  on<K extends keyof AppUpdaterEventMap>(
    channel: K,
    listener: EventListener<AppUpdaterEventMap, K>
  ): this {
    this.#emitter.on(channel, listener)
    return this
  }

  /** Removes one registration of `listener`. Mirrors `TypedEmitter.off`. */
  off<K extends keyof AppUpdaterEventMap>(
    channel: K,
    listener: EventListener<AppUpdaterEventMap, K>
  ): this {
    this.#emitter.off(channel, listener)
    return this
  }

  // -------------------------------------------------------------------------
  // The one check
  // -------------------------------------------------------------------------

  /**
   * Checks GitHub Releases once, and - if there is something newer - downloads it in the
   * background for install on quit.
   *
   * NEVER REJECTS. Call it fire-and-forget from bootstrap; nothing waits on it and
   * nothing downstream cares whether it succeeded.
   *
   * RESOLVES WHEN THE *CHECK* SETTLES, NOT WHEN THE DOWNLOAD DOES. With
   * `autoDownload = true` a successful check starts an installer download that runs for
   * as long as it takes; this method returns long before that finishes, having attached
   * a catch to it. Waiting for the download instead would hold a promise open across a
   * whole play session for no reason - progress and completion already arrive as events.
   *
   * There is deliberately NO periodic re-check and no timer of any kind. One check per
   * launch is the whole policy: it needs no teardown, it cannot fire during a clip, and
   * a companion app that is restarted every play session does not need more.
   */
  async checkOnLaunch(): Promise<void> {
    if (!this.#enabled || this.#disposed) return

    let result: UpdateCheckResult | null
    try {
      result = await autoUpdater.checkForUpdates()
    } catch (error) {
      // Normally a DUPLICATE report: electron-updater emits `'error'` and *then*
      // rethrows the same failure out of `checkForUpdates()`. The `'error'` listener has
      // already recorded the state; this catch exists to stop the rejection becoming an
      // unhandled one. It still reports, under its own context, so that a future version
      // which rejects WITHOUT emitting is not silent.
      this.#onError(error, 'check')
      return
    }

    // THE AUTO-DOWNLOAD'S PROMISE. See RULE 2, ROUTE 1 in the file header: when the
    // check found something, electron-updater has ALREADY started downloading it and
    // handed the promise back here without attaching anything to it. It is `null` when
    // there was no update (and `undefined` on the older result shapes the declared type
    // still allows), so both are checked.
    const download = result?.downloadPromise
    if (download === null || download === undefined) return

    // NOT awaited, deliberately - see this method's contract above. `void` + `.catch` is
    // the whole point: the handler is attached synchronously, so the rejection can never
    // be an unhandled one, while this method still resolves as soon as the check has.
    void download.catch((error: unknown) => {
      // Duplicate of the `'error'` event exactly like the check's catch above: by the
      // time this runs, `dispatchError` has already driven the state to `error`.
      this.#onError(error, 'download')
    })
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Removes every listener this instance attached - both to the `autoUpdater` singleton
   * and to its own emitter - and stops recording state.
   *
   * Idempotent; safe to call from `before-quit`. Synchronous: there is no socket and no
   * timer to wind down.
   *
   * DOES NOT CANCEL A DOWNLOAD AND DOES NOT DISARM INSTALL-ON-QUIT, and must not. By the
   * time this runs the user is quitting, which is precisely the moment a downloaded
   * update is supposed to be applied; electron-updater's own `app.on('quit')` handler
   * does that and is entirely independent of the listeners removed here.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    for (const detach of this.#detach) {
      try {
        detach()
      } catch (error) {
        this.#onError(error, 'dispose')
      }
    }
    this.#detach.length = 0

    try {
      this.#emitter.removeAllListeners()
    } catch (error) {
      this.#onError(error, 'dispose/emitter')
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Configures the singleton and subscribes to it. Called ONLY from the constructor, and
   * ONLY when {@link enabled}.
   *
   * THE `'error'` SUBSCRIPTION IS FIRST AND MUST STAY FIRST - see RULE 2 in the file
   * header. It is also the first statement in this whole file that touches the
   * `autoUpdater` export, so the singleton is never even constructed without an error
   * listener already on it.
   *
   * EVERY LISTENER IS REGISTERED AND ITS REMOVAL RECORDED IN THE SAME BREATH. Written
   * out longhand, three lines each, rather than through a generic `#listen(channel, fn)`
   * helper: electron-updater's emitter is generic over ITS event map, and threading an
   * unresolved channel type through it needs a cast that would defeat the point. Longhand
   * costs a dozen lines and every listener's type is inferred from the library itself.
   *
   * NONE OF THESE BODIES CAN THROW, which is why none of them is individually wrapped.
   * They call only {@link readVersion} / {@link readPercent} (total for any input,
   * including a null payload), the pure helpers in `./update-state.ts`, and
   * {@link AppUpdater.#apply} / the two hooks - all of which swallow internally. That
   * matters because a throw here would land inside electron-updater's own emit loop and
   * abort the remaining listeners of that event, including its internal ones.
   */
  #attach(): void {
    // ---- 1. ERROR HANDLER. FIRST. DO NOT MOVE. -----------------------------
    const onError = (error: Error, message?: string): void => {
      this.#onError(error, 'updater-event')
      this.#apply({ type: 'error', message: describeUpdateError(error, message) })
    }
    autoUpdater.on('error', onError)
    this.#detach.push(() => {
      autoUpdater.off('error', onError)
    })

    // ---- 2. Policy ---------------------------------------------------------
    // Download automatically; install only on quit. Both are electron-updater's own
    // defaults, set explicitly because they are the two decisions this whole file is
    // about and a silent default change would be very hard to spot.
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    // Stable releases only. `allowPrerelease` otherwise turns itself on whenever the
    // CURRENT version carries a prerelease tag, which would silently opt a `0.1.0-rc.1`
    // build into a channel the user never chose - and, because that also forces
    // `allowDowngrade`, could walk them backwards.
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false

    // See the note at the end of the file header.
    autoUpdater.logger = null

    // ---- 3. State-bearing events -------------------------------------------
    const onChecking = (): void => {
      this.#apply({ type: 'checking' })
    }
    autoUpdater.on('checking-for-update', onChecking)
    this.#detach.push(() => {
      autoUpdater.off('checking-for-update', onChecking)
    })

    const onAvailable = (info: UpdateInfo): void => {
      const version = readVersion(info)
      this.#onInfo(`Update ${describeVersion(version)} available; downloading.`, 'available')
      this.#apply({ type: 'available', version })
    }
    autoUpdater.on('update-available', onAvailable)
    this.#detach.push(() => {
      autoUpdater.off('update-available', onAvailable)
    })

    const onNotAvailable = (): void => {
      this.#apply({ type: 'not-available' })
    }
    autoUpdater.on('update-not-available', onNotAvailable)
    this.#detach.push(() => {
      autoUpdater.off('update-not-available', onNotAvailable)
    })

    const onProgress = (progress: ProgressInfo): void => {
      const percent = readPercent(progress)
      // Logged before the reduce, so the diagnostic reflects what actually arrived
      // rather than only the ticks that survived de-duplication.
      this.#onInfo(formatUpdatePercent(percent), 'download')
      this.#apply({ type: 'progress', percent })
    }
    autoUpdater.on('download-progress', onProgress)
    this.#detach.push(() => {
      autoUpdater.off('download-progress', onProgress)
    })

    const onDownloaded = (event: UpdateDownloadedEvent): void => {
      const version = readVersion(event)
      this.#onInfo(
        `Update ${describeVersion(version)} downloaded; it will install on quit.`,
        'ready'
      )
      this.#apply({ type: 'downloaded', version })
    }
    autoUpdater.on('update-downloaded', onDownloaded)
    this.#detach.push(() => {
      autoUpdater.off('update-downloaded', onDownloaded)
    })

    const onCancelled = (): void => {
      this.#apply({ type: 'cancelled' })
    }
    autoUpdater.on('update-cancelled', onCancelled)
    this.#detach.push(() => {
      autoUpdater.off('update-cancelled', onCancelled)
    })
  }

  /**
   * Runs one event through the pure reducer and emits if - and only if - the state
   * actually moved.
   *
   * The reference comparison is the throttle for `download-progress`; see
   * `./update-state.ts`. The emit is wrapped because `TypedEmitter` deliberately
   * propagates listener exceptions back to the emitter (see its header), and the
   * listener on the other end is the IPC layer talking to a window that may be in the
   * middle of being destroyed.
   */
  #apply(event: UpdaterEvent): void {
    if (this.#disposed) return

    const next = reduceUpdateState(this.#state, event)
    if (next === this.#state) return
    this.#state = next

    try {
      this.#emitter.emit('state', next)
    } catch (error) {
      this.#onError(error, 'emit')
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The version off an update manifest, or `""` when there is not a usable one.
 *
 * TOTAL FOR ANY INPUT, including `null`. The declared type says `version` is always a
 * present `string`, and it usually is - but the object was parsed out of a YAML file
 * fetched from the network, and this runs inside an event loop where a `TypeError`
 * would abort electron-updater's remaining listeners. The optional chain costs nothing
 * and removes the whole question.
 */
function readVersion(info: { readonly version?: string } | null | undefined): string {
  return normalizeVersion(info?.version ?? '')
}

/**
 * The download percent off a progress payload, clamped and rounded. Total for any input.
 *
 * A missing payload becomes `NaN`, which {@link clampPercent} maps to 0 - the honest
 * "we do not know how far along this is".
 */
function readPercent(progress: { readonly percent?: number } | null | undefined): number {
  return clampPercent(progress?.percent ?? Number.NaN)
}

/** A version for a log line, naming the empty case rather than printing a blank. */
function describeVersion(version: string): string {
  return version === '' ? '(version not reported)' : version
}

/**
 * Wraps an optional diagnostic hook so that a missing one is a no-op and a throwing one
 * is swallowed.
 *
 * Generic over the first argument so the same helper serves both
 * `(error: unknown, context: string)` and `(message: string, context: string)`.
 */
function wrapHook<T>(hook: ((value: T, context: string) => void) | undefined): (
  value: T,
  context: string
) => void {
  if (hook === undefined) return (): void => undefined

  return (value: T, context: string): void => {
    try {
      hook(value, context)
    } catch {
      // A logger must never be the thing that crashes the main process.
    }
  }
}
