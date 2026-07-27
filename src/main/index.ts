/**
 * src/main/index.ts
 * =================
 *
 * The bootstrap. Creates the window, constructs every service in dependency order,
 * wires them to each other and to the IPC layer, and tears the whole thing down
 * exactly once on quit.
 *
 * This is one of exactly four files allowed to import `electron` (the others being
 * `src/main/ipc-handlers.ts`, `src/main/updater.ts` and - only through an injected
 * directory path - `src/main/settings/store.ts`). Everything it assembles is
 * electron-free and therefore unit-testable on its own; this file is the seam where the
 * OS-specific facts (userData directory, Videos directory, renderer URL) enter the graph.
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
 *                  └──► ObsClient ────┴──► ReplayClipper ◄───────────┘  (death:self)
 *                                                │
 *                       registerIpcHandlers ◄────┴── clips + bus + obs + watcher
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
 *  - `registerIpcHandlers` must run BEFORE `watcher.start()`, because it owns the
 *    `events:recent` ring buffer and anything published before it subscribes is lost
 *    to a window that opens later.
 *
 *
 * WHY SO MANY LITTLE ADAPTER OBJECTS
 * ----------------------------------
 * `ipc-handlers.ts` depends on structural PORTS, not on these classes (see its
 * header). Most of them are satisfied as-is - `SettingsStore` already IS a
 * `SettingsPort`. The two that are not get a three-line adapter here, which is
 * exactly where that adaptation belongs: this file owns the wiring, and smearing it
 * through the handlers would couple them to concrete classes.
 *
 * The clip library gets one for a second reason: `ClipLibrary` is constructed with a
 * directory, but `settings.clips.libraryDir` can change at runtime. {@link makeClipTarget}
 * re-creates it when the setting moves, so a user who repoints their clips folder does
 * not have to restart the app.
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

import { app, BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'

import type { WatcherStatus } from '../shared/events'
import type { ClipRecord } from '../shared/ipc'
import { PoeEventBus } from './events/event-bus'
import { registerIpcHandlers } from './ipc-handlers'
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
import { SettingsStore } from './settings/store'
import { AppUpdater } from './updater'

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
  readonly updater: AppUpdater
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

/**
 * Constructs and wires every service. Performs no I/O beyond reading `settings.json`
 * and does NOT start the watcher - {@link start} does that, after the IPC layer is
 * listening.
 */
function createServices(getWindow: () => BrowserWindow | null): Services {
  // 1. Settings first: everything else reads from it. `load()` never throws - a
  //    corrupt or missing file resolves to defaults, because a user who mangled their
  //    settings needs a working settings UI to fix them in.
  const settings = new SettingsStore({
    dir: app.getPath('userData'),
    defaultLibraryDir: defaultClipsDir()
  })
  settings.load()

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
    getWindow,
    onError: (error, context) => {
      log(`ipc/${context}`, error)
    }
  })

  return { settings, bus, zones, characters, watcher, obs, clipper, updater, disposeIpc }
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
