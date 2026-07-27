/**
 * FROZEN TYPE CONTRACT - src/shared/ipc.ts
 * =========================================
 *
 * The wire protocol between the Electron main process and the renderer.
 *
 * Three parties depend on this file agreeing exactly:
 *   1. `src/main/ipc-handlers.ts`  - registers `ipcMain.handle(channel, ...)`
 *   2. `src/preload/index.ts`      - wraps `ipcRenderer.invoke/on` and exposes {@link PoeToolApi}
 *   3. `src/renderer/**`           - calls `window.poeTool.*`
 *
 * RULES FOR THIS FILE:
 *  - Type-only imports. No `electron`, no `node:*` - this is compiled by the
 *    renderer project too.
 *  - No `any`. The whole point is that a channel name typo or a payload mismatch is
 *    a compile error, not a runtime `undefined`.
 *
 * SERIALISATION: Electron IPC uses the structured clone algorithm. Everything here
 * is clone-safe: primitives, plain objects, arrays and `Date` (inside
 * `LogLineMeta.timestamp`). Do NOT add functions, class instances, `Map`/`Set`,
 * or anything holding a handle to a main-process resource.
 */

import type { ActiveCharacter, DeathCause, PoeEvent, WatcherStatus } from './events'
import type { AppSettings, DeepPartial } from './settings'

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

/**
 * Renderer -> main REQUEST/RESPONSE channels (`ipcRenderer.invoke` /
 * `ipcMain.handle`). Every one of these returns a promise.
 *
 * Always reference channels through these constants; never hand-write the string
 * literal at a call site.
 */
export const IPC_INVOKE = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  OBS_TEST: 'obs:test',
  OBS_STATUS: 'obs:status',
  LOG_AUTODETECT: 'log:autodetect',
  LOG_STATUS: 'log:status',
  EVENTS_RECENT: 'events:recent',
  CLIPS_RECENT: 'clips:recent',
  CHARACTER_ACTIVE: 'character:active',
  CHARACTER_SUGGESTIONS: 'character:suggestions',
  UPDATE_STATE: 'update:state'
} as const

/**
 * Main -> renderer PUSH channels (`webContents.send` / `ipcRenderer.on`).
 * Fire-and-forget, no response.
 *
 * The renderer is NEVER on the critical path: these exist purely to keep the
 * config UI in sync. Main must keep working correctly with zero windows open.
 */
export const IPC_PUSH = {
  EVENT: 'push:event',
  STATUS: 'push:status',
  OBS_STATUS: 'push:obs-status',
  CLIP: 'push:clip',
  CHARACTER: 'push:character',
  UPDATE: 'push:update'
} as const

/** Union of the eleven invoke channel names. */
export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE]

/** Union of the six push channel names. */
export type IpcPushChannel = (typeof IPC_PUSH)[keyof typeof IPC_PUSH]

// ---------------------------------------------------------------------------
// OBS payloads
// ---------------------------------------------------------------------------

/** Connection parameters for a one-shot `obs:test`. Mirrors `AppSettings['obs']` minus `autoConnect`. */
export interface ObsTestRequest {
  readonly host: string
  readonly port: number
  readonly password: string
}

/** `obs:test` succeeded: we connected, identified, and disconnected again. */
export interface ObsTestSuccess {
  readonly ok: true
  /** OBS Studio version string reported by `GetVersion`, e.g. `"30.2.3"`. */
  readonly obsVersion: string
  /** obs-websocket plugin version, e.g. `"5.5.4"`. */
  readonly websocketVersion: string
}

/** `obs:test` failed. `error` is a human-readable message, safe to render. */
export interface ObsTestFailure {
  readonly ok: false
  readonly error: string
}

/**
 * Result of `obs:test`. Deliberately a result union rather than a rejected promise:
 * a wrong password is an expected outcome of a "Test connection" button, not an
 * exception. The handler must never let the underlying error escape.
 */
export type ObsTestResult = ObsTestSuccess | ObsTestFailure

/**
 * Live OBS connection state. Discriminated on `state`, matching the convention used
 * by `WatcherStatus` (see the discriminant note in `./events`).
 */
export interface ObsDisconnectedState {
  readonly state: 'disconnected'
  /** `Date.now()` when this state was entered. */
  readonly since: number
}

export interface ObsConnectingState {
  readonly state: 'connecting'
  readonly host: string
  readonly port: number
  readonly since: number
  /** 1-based attempt counter; > 1 means we are retrying after a drop. */
  readonly attempt: number
}

export interface ObsConnectedState {
  readonly state: 'connected'
  readonly host: string
  readonly port: number
  readonly obsVersion: string
  readonly websocketVersion: string
  readonly since: number
  /**
   * Whether OBS reports the replay buffer as currently ACTIVE. Null when we have
   * not asked yet. If this is false, clip requests will fail - the UI should warn.
   */
  readonly replayBufferActive: boolean | null
}

export interface ObsErrorState {
  readonly state: 'error'
  readonly message: string
  readonly since: number
  /** True when the client intends to reconnect on its own. */
  readonly willRetry: boolean
}

/** Everything the OBS client can report. Switch on `state`. */
export type ObsConnectionState =
  | ObsDisconnectedState
  | ObsConnectingState
  | ObsConnectedState
  | ObsErrorState

// ---------------------------------------------------------------------------
// Log payloads
// ---------------------------------------------------------------------------

/**
 * Result of `log:autodetect`: every plausible Client.txt path that actually exists
 * on disk, most-likely first. Empty means "nothing found, ask the user to browse".
 *
 * The renderer only ever offers these as choices; it never guesses.
 */
export interface LogAutodetectResult {
  readonly candidates: readonly string[]
}

// ---------------------------------------------------------------------------
// Character payloads
// ---------------------------------------------------------------------------

/**
 * Result of `character:suggestions`: character names HARVESTED FROM THE LOG, for the
 * one-click picker the UI must offer when no character is known.
 *
 * This exists because `ActiveCharacter` with `source: 'none'` is a dead end for the
 * user - death clipping quietly does nothing and there is no obvious way to fix it.
 * Rather than make them type a name from memory, main scans Client.txt for the names
 * it has seen and offers them.
 *
 * Ordering is main's choice (most recent / most frequent first is the useful one) and
 * the renderer must NOT re-sort or de-duplicate; it presents the list as given.
 * EMPTY IS A NORMAL ANSWER - a fresh log, or a character that has never levelled -
 * and the UI still has to offer free-text entry in that case. The renderer never
 * guesses: picking a suggestion writes `settings.character.override`, explicitly.
 */
export interface CharacterSuggestionsResult {
  readonly names: readonly string[]
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/**
 * One saved replay-buffer clip plus the game context it was captured in.
 *
 * Produced by `src/main/obs/replay-clipper.ts`, persisted by `clip-library.ts`,
 * and (when `settings.clips.writeSidecar` is on) written next to the video as a
 * `.json` sidecar.
 */
export interface ClipRecord {
  /** `Date.now()` when OBS reported the clip was written. Also the sort key. */
  readonly savedAt: number
  /** Absolute path OBS wrote the file to, i.e. the OBS recording directory. */
  readonly originalPath: string
  /**
   * Absolute path inside `settings.clips.libraryDir` after we renamed/moved it.
   * `null` when the move has not happened or failed - in that case the clip still
   * exists at {@link originalPath}, so this must never be treated as "no clip".
   */
  readonly finalPath: string | null
  /** Zone display name at capture time, e.g. `"Karui Shores"`. Null if unknown. */
  readonly zoneName: string | null
  /** Internal area id at capture time, e.g. `"2_11_endgame_town"`. Null if unknown. */
  readonly areaId: string | null
  /** Area monster level at capture time. Null if unknown. */
  readonly areaLevel: number | null
  /**
   * The resolved active character at capture time - the override if there was one,
   * otherwise the detected name. `""` when neither was known.
   */
  readonly characterName: string
  /**
   * Why this clip exists: which kind of death triggered it. Purely informational
   * here - the UI shows it so a clip is never unexplained.
   *
   * In practice every record written by the replay clipper carries `'slain'`, because
   * a `'suicide'` (PoE's `/kill`) is deliberate and never clipped - see `DeathCause`
   * in `./events`. The field is still a full {@link DeathCause} rather than a
   * `'slain'` literal so that a future manual "clip that" button, or a change of mind
   * about suicides, does not have to break this contract. Consumers must handle both
   * values, and must not infer "not a suicide" from a clip existing.
   */
  readonly cause: DeathCause
  /** True once the file was successfully relocated into the library directory. */
  readonly moved: boolean
  /** Free-form note: a user annotation, or the reason the move failed. */
  readonly note: string | null
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/**
 * Auto-update is switched OFF because this is not a packaged build.
 *
 * A TERMINAL state, not a transient one: `src/main/updater.ts` decides it once from
 * `app.isPackaged` and never attaches a single electron-updater listener afterwards, so
 * nothing can move it. The renderer can therefore treat it as "there is nothing to show
 * here, ever" rather than as "not checked yet".
 *
 * In a shipped installer this value is unreachable. It exists so that a developer
 * running `electron-vite dev` sees WHY the update line is silent instead of assuming it
 * is broken.
 */
export interface UpdateDisabledState {
  readonly state: 'disabled-in-dev'
}

/** Nothing to report: no check has run yet, or the last one found no newer version. */
export interface UpdateIdleState {
  readonly state: 'idle'
}

/** A check is in flight against GitHub Releases. */
export interface UpdateCheckingState {
  readonly state: 'checking'
}

/** A newer release exists. The download starts on its own (`autoDownload`). */
export interface UpdateAvailableState {
  readonly state: 'available'
  /** Version string from the release manifest, e.g. `"0.2.0"`. `""` when unreadable. */
  readonly version: string
}

/** The installer is downloading in the background. */
export interface UpdateDownloadingState {
  readonly state: 'downloading'
  /**
   * The version being fetched, or null when the `update-available` event that would
   * have carried it was never seen (a resumed download, a listener attached late).
   */
  readonly version: string | null
  /**
   * Whole percent, ALREADY clamped to 0-100 and rounded by `src/main/update-state.ts`.
   * The renderer renders it directly and must not re-clamp or re-round.
   *
   * Rounding happens in main on purpose: `download-progress` fires far more often than
   * once per percent, and collapsing to integers is what stops this channel from
   * spraying a push per network chunk.
   */
  readonly percent: number
}

/**
 * The installer is on disk and will be applied WHEN THE USER QUITS.
 *
 * poe-tool never restarts itself to apply an update. A forced restart mid-session could
 * land in the middle of a replay-buffer save and lose the clip the app exists to
 * capture, so `autoInstallOnAppQuit` is the only install path - see `src/main/updater.ts`.
 */
export interface UpdateReadyState {
  readonly state: 'ready'
  /** Version that will be installed on quit. `""` when the manifest was unreadable. */
  readonly version: string
}

/**
 * The check or the download failed.
 *
 * EXPECTED AND UNIMPORTANT. Offline, GitHub down, rate limited, a proxy in the way -
 * all of them land here, and none of them affect the app's actual job. The UI says so
 * quietly and says nothing else; there is no retry button and no modal.
 */
export interface UpdateErrorState {
  readonly state: 'error'
  /** Human-readable, already truncated. Safe to render verbatim. */
  readonly message: string
}

/**
 * Everything the updater can report. Switch on `state`, matching the discriminant
 * convention used by {@link ObsConnectionState} and `WatcherStatus`.
 *
 * DELIBERATELY CARRIES NO `since` TIMESTAMP, unlike its two siblings. Those describe a
 * connection whose age is meaningful ("connecting for 40s" is a problem). This one
 * describes a background errand nobody is waiting on, and a per-emit timestamp would
 * make every value structurally new - defeating the change-detection in
 * `reduceUpdateState` that keeps `download-progress` from flooding `push:update`.
 */
export type UpdateState =
  | UpdateDisabledState
  | UpdateIdleState
  | UpdateCheckingState
  | UpdateAvailableState
  | UpdateDownloadingState
  | UpdateReadyState
  | UpdateErrorState

// ---------------------------------------------------------------------------
// Invoke contract
// ---------------------------------------------------------------------------

/**
 * The full request/response contract, keyed by channel name.
 *
 * `args` is the argument TUPLE the renderer sends (empty tuple = no arguments),
 * `result` is what the promise resolves to. `src/main/ipc-handlers.ts` should use
 * this to type its registration helper so a handler cannot be wired to the wrong
 * payload.
 *
 * Handlers must RESOLVE rather than reject wherever failure is an expected user
 * outcome (see {@link ObsTestResult}); a rejected invoke surfaces in the renderer as
 * an opaque `Error: Error invoking remote method ...` string.
 */
export interface IpcInvokeContract {
  'settings:get': { readonly args: readonly []; readonly result: AppSettings }
  'settings:set': {
    readonly args: readonly [patch: DeepPartial<AppSettings>]
    /** The FULL validated settings after the patch - not the patch echoed back. */
    readonly result: AppSettings
  }
  'obs:test': { readonly args: readonly [params: ObsTestRequest]; readonly result: ObsTestResult }
  'obs:status': { readonly args: readonly []; readonly result: ObsConnectionState }
  'log:autodetect': { readonly args: readonly []; readonly result: LogAutodetectResult }
  'log:status': { readonly args: readonly []; readonly result: WatcherStatus }
  /** Newest-last ring buffer of recent events, for populating the UI on mount. */
  'events:recent': { readonly args: readonly []; readonly result: readonly PoeEvent[] }
  /** Newest-first list of recent clips, for populating the UI on mount. */
  'clips:recent': { readonly args: readonly []; readonly result: readonly ClipRecord[] }
  /**
   * The RESOLVED active character (override > detected > none), not the raw settings.
   * Main owns the resolution rule; the renderer must never re-derive it from
   * `settings.character`.
   */
  'character:active': { readonly args: readonly []; readonly result: ActiveCharacter }
  /**
   * Character names harvested from the log, for the picker shown when nothing is
   * known. May be slow (it reads the log) and may legitimately resolve empty.
   */
  'character:suggestions': {
    readonly args: readonly []
    readonly result: CharacterSuggestionsResult
  }
  /**
   * Current auto-update state. A stored value in main, not a probe - asking does NOT
   * trigger a check. The only check poe-tool ever runs happens once at launch.
   */
  'update:state': { readonly args: readonly []; readonly result: UpdateState }
}

/** Argument tuple for a given invoke channel. */
export type IpcInvokeArgs<C extends IpcInvokeChannel> = IpcInvokeContract[C]['args']

/** Resolved value for a given invoke channel. */
export type IpcInvokeResult<C extends IpcInvokeChannel> = IpcInvokeContract[C]['result']

// ---------------------------------------------------------------------------
// Push contract
// ---------------------------------------------------------------------------

/**
 * Payload carried by each main -> renderer push channel. Exactly one argument per
 * channel, by convention, so preload's `on` wrappers stay uniform.
 */
export interface IpcPushContract {
  'push:event': PoeEvent
  'push:status': WatcherStatus
  'push:obs-status': ObsConnectionState
  'push:clip': ClipRecord
  /**
   * The resolved active character changed - a level-up was detected, or the override
   * was edited. Carries the complete new value (mirroring the bus's
   * `character-changed`), so the renderer replaces its state rather than patching it.
   */
  'push:character': ActiveCharacter
  /**
   * The auto-update state changed. Sent ONLY on a real change - `reduceUpdateState`
   * returns the previous value by reference when nothing moved, and main skips the send
   * in that case, which is what keeps a download from pushing once per network chunk.
   */
  'push:update': UpdateState
}

/** Payload type for a given push channel. */
export type IpcPushPayload<C extends IpcPushChannel> = IpcPushContract[C]

// ---------------------------------------------------------------------------
// Renderer-facing API
// ---------------------------------------------------------------------------

/**
 * Returned by every `on*` subscription. Call it to detach the listener - React
 * effects must return it, otherwise remounts stack duplicate listeners.
 */
export type Unsubscribe = () => void

/**
 * The surface `src/preload/index.ts` exposes via
 * `contextBridge.exposeInMainWorld(POE_TOOL_API_KEY, api)`.
 *
 * Deliberately NOT a generic `invoke(channel, ...args)` passthrough: naming each
 * operation keeps `contextIsolation` meaningful (the renderer cannot reach an
 * arbitrary channel) and keeps the renderer honest about what main actually offers.
 */
export interface PoeToolApi {
  /** Current validated settings. */
  readonly getSettings: () => Promise<AppSettings>
  /** Apply a partial patch; resolves with the full settings after validation+clamping. */
  readonly setSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>
  /** One-shot connection test. Resolves with a result union; does not reject on bad credentials. */
  readonly testObs: (params: ObsTestRequest) => Promise<ObsTestResult>
  /** Current live OBS connection state. */
  readonly getObsStatus: () => Promise<ObsConnectionState>
  /** Existing Client.txt paths found on this machine, most-likely first. */
  readonly autodetectLogPaths: () => Promise<LogAutodetectResult>
  /** Current log watcher state. */
  readonly getLogStatus: () => Promise<WatcherStatus>
  /** Recent events buffered in main, for initial render. */
  readonly getRecentEvents: () => Promise<readonly PoeEvent[]>
  /** Recent clips from the clip library, for initial render. */
  readonly getRecentClips: () => Promise<readonly ClipRecord[]>
  /** The resolved active character (override > detected > none), as decided by main. */
  readonly getActiveCharacter: () => Promise<ActiveCharacter>
  /** Character names harvested from the log, for the "nothing detected" picker. */
  readonly getCharacterSuggestions: () => Promise<CharacterSuggestionsResult>
  /** Current auto-update state. Reading it never triggers a check. */
  readonly getUpdateState: () => Promise<UpdateState>

  /** Subscribe to live parsed events. Returns an unsubscribe function. */
  readonly onEvent: (listener: (event: PoeEvent) => void) => Unsubscribe
  /** Subscribe to log watcher status changes. Returns an unsubscribe function. */
  readonly onStatus: (listener: (status: WatcherStatus) => void) => Unsubscribe
  /** Subscribe to OBS connection state changes. Returns an unsubscribe function. */
  readonly onObsStatus: (listener: (status: ObsConnectionState) => void) => Unsubscribe
  /** Subscribe to newly saved clips. Returns an unsubscribe function. */
  readonly onClip: (listener: (clip: ClipRecord) => void) => Unsubscribe
  /** Subscribe to active-character changes. Returns an unsubscribe function. */
  readonly onCharacter: (listener: (character: ActiveCharacter) => void) => Unsubscribe
  /** Subscribe to auto-update state changes. Returns an unsubscribe function. */
  readonly onUpdate: (listener: (state: UpdateState) => void) => Unsubscribe
}

/** The `window` property name the preload bridge writes {@link PoeToolApi} to. */
export const POE_TOOL_API_KEY = 'poeTool' as const

declare global {
  // Declared here (rather than in a renderer-only .d.ts) so preload and renderer
  // share one definition. Harmless in the node project, which has no DOM lib: the
  // interface simply has no other members to merge with there.
  interface Window {
    readonly poeTool: PoeToolApi
  }
}
