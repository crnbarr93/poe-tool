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
 *
 *
 * THE PASSWORD INVARIANT - READ THIS BEFORE ADDING A CHANNEL
 * ----------------------------------------------------------
 * A password travels in exactly ONE direction: renderer -> main, and only because the
 * user just typed it (`settings:set`, `obs:test`, `streamable:test`). MAIN NEVER SENDS
 * ONE BACK. Not in a result, not in a push, not in an error message, not in a
 * diagnostic string.
 *
 * That is not a style preference. This repository is PUBLIC, the Streamable credential
 * is an ACCOUNT email + password (Streamable has no revocable upload token), and the
 * renderer is a real web page - anything that reaches it reaches devtools, a crash
 * report, and any script that ends up running there.
 *
 * Concretely:
 *  - `settings:get` and `settings:set` resolve with an `AppSettings`, whose
 *    `streamable.password` main MUST blank first via `redactSecrets` in `./settings`.
 *  - The renderer therefore always holds `''` there, which says NOTHING about whether a
 *    password is stored. {@link CredentialsStatusResult} answers that question instead.
 *  - Because the renderer holds `''` and echoes its whole settings object back as a
 *    patch, an EMPTY `streamable.password` in an incoming patch means "no change" - see
 *    the note on `settings:set` in {@link IpcInvokeContract}.
 *  - {@link StreamableTestFailure.error} is a message about the ATTEMPT. It must never
 *    quote the credential it was given.
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
  APP_VERSION: 'app:version',
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
  UPDATE_STATE: 'update:state',
  STREAMABLE_TEST: 'streamable:test',
  CREDENTIALS_STATUS: 'credentials:status',
  STATS_SESSION: 'stats:session'
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
  CLIP_UPLOAD: 'push:clip-upload',
  CHARACTER: 'push:character',
  UPDATE: 'push:update',
  STATS: 'push:stats'
} as const

/** Union of the fifteen invoke channel names. */
export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE]

/** Union of the eight push channel names. */
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
// Clip upload
// ---------------------------------------------------------------------------

/**
 * Uploading is switched off, so this clip was never a candidate.
 *
 * `settings.streamable.enabled` is false, or `autoUpload` is false. Distinct from
 * {@link UploadSkipped}, which means "we would have uploaded this one, but".
 */
export interface UploadDisabled {
  readonly state: 'disabled'
}

/** Queued. The clip is filed and an upload is going to be attempted, but has not started. */
export interface UploadPending {
  readonly state: 'pending'
}

/** Bytes are going out. */
export interface UploadUploading {
  readonly state: 'uploading'
  /**
   * Whole percent 0-100, ALREADY clamped and rounded in main (mirroring
   * {@link UpdateDownloadingState.percent}), or `null` when progress is genuinely
   * unknown - which is the normal case here, because the upload is one `fetch` of a
   * multipart body and the platform gives no per-chunk callback. A `null` means "render
   * an indeterminate bar", never "0%".
   */
  readonly percent: number | null
}

/**
 * Streamable has the file and is transcoding it.
 *
 * The video exists at `https://streamable.com/{shortcode}` from this moment, but will
 * not play until it is ready, so the UI may show the link and must say it is still
 * processing. Main polls the OFFICIAL, documented `GET /videos/{shortcode}` until the
 * status turns ready (or a cap is hit, which lands on {@link UploadFailed}).
 */
export interface UploadProcessing {
  readonly state: 'processing'
  /** Streamable's short id, e.g. `"abc123"`. The only durable handle on the video. */
  readonly shortcode: string
}

/** Ready to watch. Terminal, and the only state carrying a URL worth putting on a clipboard. */
export interface UploadDone {
  readonly state: 'done'
  readonly shortcode: string
  /** `https://streamable.com/{shortcode}`. Built in main so the renderer never assembles URLs. */
  readonly url: string
}

/**
 * We deliberately did not upload this clip. NOT an error, and NOT invisible.
 *
 * Covers the file being over `settings.streamable.maxFileBytes` (the free plan stops at
 * 250 MB), the clip not being on this machine (remote OBS), and credentials missing.
 * {@link reason} is a complete human sentence, safe to render verbatim, and must say
 * what the user could do about it.
 *
 * A skip is shown as loudly as a failure. The app's standing rule is that nothing fails
 * silently: a user who believes their deaths are being uploaded and finds out weeks
 * later that a size limit quietly dropped them is exactly the outcome this project
 * exists to avoid.
 */
export interface UploadSkipped {
  readonly state: 'skipped'
  readonly reason: string
  /**
   * Streamable's short id, WHEN THE CLIP HAD ALREADY BEEN UPLOADED before we stopped.
   *
   * Absent for the ordinary skips, which happen before anything is sent (too big, no
   * local file, no credentials, dropped from a full queue) - there is no video to point
   * at. Present for the one skip that happens AFTER a successful upload: poe-tool quit
   * while Streamable was still transcoding. See {@link url}.
   */
  readonly shortcode?: string
  /**
   * `https://streamable.com/{shortcode}`, present exactly when {@link shortcode} is.
   *
   * A REAL LINK, NOT A SENTENCE CONTAINING ONE. {@link reason} names the URL in prose too,
   * because it must read correctly on its own, but prose is not something the UI can hang
   * a "copy" button on - and a user whose upload succeeded should never have to retype a
   * URL out of a paragraph.
   */
  readonly url?: string
}

/**
 * The upload was attempted and did not work: network down, credentials rejected,
 * Streamable returned something we could not parse, processing never finished.
 *
 * {@link message} is human-readable and safe to render. It MUST NOT contain the
 * account password, and must not contain a raw stack trace. See the password invariant
 * in this file's header.
 *
 * Terminal for this clip - there is no automatic retry - so the message has to be good
 * enough to act on. The clip itself is untouched on disk either way; a failed upload
 * never means a lost clip.
 */
export interface UploadFailed {
  readonly state: 'failed'
  readonly message: string
  /**
   * Streamable's short id, WHEN THE UPLOAD ITSELF SUCCEEDED and the failure came later.
   *
   * NOT A CONTRADICTION, and the case it exists for is not rare. The upload can finish
   * perfectly and then transcoding can outlast the poll cap, or the status endpoint can
   * stop answering. The clip IS on Streamable and that link will very probably play - all
   * that failed was our watching of it. Absent for every failure that happened before or
   * during the upload, where there is genuinely nothing to link to.
   *
   * The one deliberate omission is a transcode Streamable itself reports as failed: the
   * video exists but will never play, so offering it as a link would be a false promise.
   */
  readonly shortcode?: string
  /** `https://streamable.com/{shortcode}`, present exactly when {@link shortcode} is. */
  readonly url?: string
}

/**
 * Where one clip's Streamable upload has got to. Switch on `state`.
 *
 * Discriminates on `state` like every other status union here ({@link ObsConnectionState},
 * {@link UpdateState}, `WatcherStatus`) rather than on `type`, which is reserved for
 * log-derived events.
 *
 * PROGRESSION: `disabled` alone, or
 * `pending -> uploading -> processing -> done`, with `skipped` and `failed` reachable
 * from any point before `done`. Nothing leaves `done`, `skipped` or `failed`.
 *
 * BOTH UNHAPPY ENDINGS ARE VISIBLE. `skipped` (we chose not to) and `failed` (we tried
 * and could not) are separate states because they need different words in front of the
 * user, but neither may be hidden or greyed out - see {@link UploadSkipped}.
 */
export type UploadOutcome =
  | UploadDisabled
  | UploadPending
  | UploadUploading
  | UploadProcessing
  | UploadDone
  | UploadSkipped
  | UploadFailed

/**
 * Payload of `push:clip-upload`: one clip's upload state moved.
 *
 * Carries the clip's {@link ClipRecord.id} rather than the whole record so the renderer
 * can update ONE ROW IN PLACE. Re-sending the entire `ClipRecord` would work too, but it
 * would invite a subtle bug: the record main holds may have moved on in other ways
 * (a note added, the file relocated), and a row that silently rewrites itself from a
 * stale-in-one-direction copy is worse than a row that only changes what actually
 * changed.
 *
 * An id the renderer does not know is a NORMAL occurrence, not an error: the clip may
 * have aged out of the feed, or the window may have opened after it was saved. Ignore
 * it silently.
 */
export interface ClipUploadUpdate {
  /** {@link ClipRecord.id} of the clip this update belongs to. */
  readonly clipId: string
  /** The clip's new upload state, complete - not a delta. */
  readonly upload: UploadOutcome
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
  /**
   * STABLE, OPAQUE IDENTITY for this clip, minted in main when the record is created.
   *
   * It is the address `push:clip-upload` updates are sent to (see {@link ClipUploadUpdate}),
   * and the right React key for a clip row. Unique within a session; uniqueness across
   * restarts is not promised and nothing may depend on it.
   *
   * DELIBERATELY NOT DERIVED FROM ANYTHING THAT CAN CHANGE OR COLLIDE. Not the file path
   * - the whole point of the library is that the file moves, and a remote-OBS clip never
   * had a local path to begin with. Not `savedAt` plus the path - two clips can land in
   * the same second, and a clip that was never moved keeps the OBS path it shares with
   * nothing else only by luck. Treat it as opaque: never parse it, never sort on it,
   * never show it to the user.
   */
  readonly id: string
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
  /**
   * Where this clip's Streamable upload has got to, AT THE MOMENT THIS RECORD WAS SENT.
   *
   * A SNAPSHOT, NOT A LIVE VALUE. The record is emitted as soon as the clip is filed, so
   * this is almost always `disabled` or `pending` on arrival; everything afterwards
   * arrives on `push:clip-upload` keyed by {@link id}. A renderer that only ever reads
   * this field will show every upload as permanently pending.
   *
   * NEVER `null` and never absent - "we are not uploading this" is spelled
   * `{ state: 'disabled' }` (uploading is switched off) or `{ state: 'skipped' }` (it was
   * a candidate and we declined), both of which the UI must show. An optional field
   * would have made "no upload" and "an upload nobody reported on" the same value.
   */
  readonly upload: UploadOutcome
}

// ---------------------------------------------------------------------------
// Streamable account + stored credentials
// ---------------------------------------------------------------------------

/**
 * Credentials for a one-shot `streamable:test`. Mirrors `AppSettings['streamable']`
 * minus the behaviour flags.
 *
 * RENDERER -> MAIN ONLY, and the only reason a password is allowed in this direction at
 * all: the user just typed it into the form and is asking whether it works. Nothing in
 * this shape ever travels back - see the password invariant in this file's header.
 */
export interface StreamableTestRequest {
  readonly email: string
  /**
   * The password as typed. If the form field was left blank because the renderer holds a
   * redacted `''`, main substitutes the SAVED password (the same fallback
   * `narrowObsTestRequest` already does for OBS) rather than testing an empty string.
   */
  readonly password: string
}

/** `streamable:test` succeeded: Streamable accepted these credentials. */
export interface StreamableTestSuccess {
  readonly ok: true
}

/**
 * `streamable:test` failed: wrong credentials, no network, or the unofficial endpoint
 * answered in a shape we do not recognise.
 *
 * {@link error} is a human-readable sentence, safe to render verbatim. It MUST NOT
 * contain the password it was handed, and it should distinguish "Streamable said no"
 * from "we could not reach Streamable" - one is the user's problem to fix, the other is
 * not.
 */
export interface StreamableTestFailure {
  readonly ok: false
  readonly error: string
}

/**
 * Result of `streamable:test`. A result union rather than a rejected promise, exactly
 * like {@link ObsTestResult}: a wrong password is an expected outcome of a "Test
 * credentials" button, not an exception.
 */
export type StreamableTestResult = StreamableTestSuccess | StreamableTestFailure

/**
 * WHY A STORED PASSWORD IS OR IS NOT USABLE RIGHT NOW.
 *
 * Secrets are encrypted at rest with Electron `safeStorage` (DPAPI on Windows) by
 * `src/main/settings/store.ts`. Two things can go wrong with that, and they need
 * different sentences in front of the user:
 *
 *  - `'ok'` - OS-level encryption is available and whatever was stored was read back
 *    successfully. This is ALSO the answer when nothing is stored at all: "no password
 *    saved" is not a fault. Use {@link CredentialSlotStatus.present} to tell those apart.
 *  - `'unavailable'` - the OS would not give us encryption on this machine, so poe-tool
 *    cannot protect a secret at rest. The UI must warn that a saved password may not
 *    survive a restart. WHAT THE STORE DOES ABOUT IT (refuse to persist, hold it for the
 *    session only) is the store's policy and is documented there - do not restate it
 *    here and do not infer it.
 *  - `'undecryptable'` - an encrypted blob IS on disk and could not be decrypted. This
 *    is the settings file having been copied from another machine or user profile, or
 *    Windows having rotated the DPAPI key. The password is GONE and the only fix is to
 *    type it again. It must be said out loud: without this state the field simply looks
 *    empty and the user is left to work out for themselves why uploads stopped.
 *
 * A failed decrypt never invalidates the rest of the settings file.
 */
export type CredentialStatus = 'ok' | 'unavailable' | 'undecryptable'

/** The state of one stored secret. Carries no secret - see the password invariant. */
export interface CredentialSlotStatus {
  readonly status: CredentialStatus
  /**
   * True when main currently holds a usable, non-empty secret for this slot in memory.
   *
   * This is how the renderer distinguishes "no password saved" from "a password is
   * saved, and you are holding a redacted blank" - it cannot tell from
   * `settings.streamable.password`, which is always `''` on its side.
   */
  readonly present: boolean
}

/**
 * Result of `credentials:status`: one entry per stored secret.
 *
 * Both slots are reported even though only Streamable's is a real account credential,
 * because both go through the same encryption path and a DPAPI failure hits them
 * together - and a UI that explains one while silently dropping the other is how a user
 * ends up believing OBS is misconfigured.
 */
export interface CredentialsStatusResult {
  /** The obs-websocket password (`settings.obs.password`). Frequently absent by design. */
  readonly obs: CredentialSlotStatus
  /** The Streamable account password (`settings.streamable.password`). */
  readonly streamable: CredentialSlotStatus
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

/**
 * WHAT THIS SESSION HAS ACTUALLY SEEN, counted live in main.
 *
 * Produced by `src/main/stats/session-stats.ts`, which subscribes to the same bus the
 * rest of the app runs on and increments a counter per event. Sent whole on
 * `push:stats` whenever a counter (or the character's level) moves, and readable at any
 * time over `stats:session`.
 *
 *
 * COUNTED LIVE - NOT DERIVED FROM `events:recent`
 * -----------------------------------------------
 * The obvious implementation is to count deaths in the `events:recent` ring buffer,
 * and it is wrong. That buffer is capped at 200 events against a stream dominated by
 * zone traffic, so an evening's mapping pushes the session's early deaths out of it and
 * the "Deaths" figure would quietly walk BACKWARDS while the user played - the exact
 * class of silent wrongness this app exists to avoid. These counters only ever go up.
 *
 *
 * BACKLOG IS NOT COUNTED
 * ----------------------
 * Lines that already existed in Client.txt when we attached (startup catch-up, a
 * post-rotation re-read) carry `PoeEventBase.backlog`, and none of them are counted:
 * this is "your session", not "your log file". Without that rule, PoE truncating
 * Client.txt mid-session would replay hours of history and inflate every number at once.
 *
 *
 * THERE IS DELIBERATELY NO "AVERAGE MAP TIME" FIELD
 * -------------------------------------------------
 * The design shows one. It is NOT derivable from what this build tracks: an average
 * needs per-area durations, which need an area-timer that knows when an area was left as
 * well as entered (a map exited to a hideout, a logout, an alt-tab) - none of which
 * exists yet. A plausible-looking number computed from `uptimeMs / areasEntered` would be
 * wrong in a way nobody could see, so the UI renders an em-dash and says the figure
 * arrives with area timers. Do not add the field until the timers exist.
 */
export interface SessionStatsSnapshot {
  /**
   * `Date.now()` when main started counting - i.e. when the app launched, not when the
   * window opened.
   *
   * Epoch milliseconds, so a renderer can tick a live "session length" from
   * `Date.now() - startedAt` without waiting for a push. {@link uptimeMs} is the same
   * figure as of the moment this snapshot was taken, for callers that would rather not
   * hold their own timer.
   */
  readonly startedAt: number
  /**
   * How long main has been counting, in milliseconds, AS OF THIS SNAPSHOT.
   *
   * Stale the instant it arrives - there is no push for the clock ticking, because that
   * would be a once-per-second IPC message for a value the renderer can compute. Clamped
   * at 0, so an OS clock adjustment during the session cannot produce a negative age.
   */
  readonly uptimeMs: number
  /**
   * How many areas have been entered this session, counting EVERY `zone-entered`.
   *
   * Towns and hideouts included: the line that names a zone carries nothing that
   * distinguishes them, and inventing a rule ("anything with seed 1 is not an area")
   * would make this number disagree with the event feed sitting next to it.
   */
  readonly areasEntered: number
  /**
   * Deaths of the RESOLVED ACTIVE CHARACTER this session - `DeathEvent.isSelf`.
   *
   * Party members' deaths are not counted; they are in the event feed, but they are not
   * yours. With no character resolved, `isSelf` is false for every line and this stays 0
   * - which is the same condition that leaves the clipper idle, and is why the UI shouts
   * about it elsewhere.
   *
   * INCLUDES SUICIDES. PoE's `/kill` is a real death and `src/shared/events.ts` is
   * explicit that it counts; {@link suicides} says how many of these were that, so
   * `deaths - suicides` is the number that could have produced a clip.
   */
  readonly deaths: number
  /**
   * How many of {@link deaths} were PoE's `/kill` command (`DeathCause` `'suicide'`).
   *
   * Tracked separately because those are the deaths the replay clipper deliberately
   * skips - a `/kill` is thirty seconds of nothing followed by a self-inflicted death -
   * so this is the honest answer to "why are there fewer clips than deaths".
   */
  readonly suicides: number
  /**
   * The active character's level as of the last observed level-up, or `null` when it is
   * not known.
   *
   * READ FROM THE CHARACTER TRACKER, never counted here: level-ups are sparse enough
   * that a level-98 character can play for weeks without producing one, so the tracker's
   * persisted answer is the only correct source. `null` is ordinary - an override is just
   * a name the user typed, and no level-up has ever been seen for it.
   */
  readonly characterLevel: number | null
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
  /**
   * The RUNNING APP'S VERSION, e.g. `"0.2.0"` - `app.getVersion()`, which in a packaged
   * build is the version baked into the installer and in a dev build is the one in
   * package.json.
   *
   * Exists because the window's brand block shows a version, and a version is exactly the
   * kind of thing that gets hardcoded into a layout and then quietly lies for six
   * releases. There is one source of truth and this is the channel to it.
   *
   * `''` MEANS "COULD NOT BE READ" and the UI must render nothing at all in that case -
   * not a guess, not a dash pretending to be a number. It is a display string and nothing
   * may branch on it; the auto-updater compares versions in main, where the comparison
   * belongs.
   */
  'app:version': { readonly args: readonly []; readonly result: string }
  /**
   * Current validated settings, WITH SECRETS BLANKED - main runs `redactSecrets` from
   * `./settings` over every `AppSettings` it hands out. `streamable.password` is
   * therefore always `''` here and says nothing about whether one is stored; ask
   * `credentials:status`.
   */
  'settings:get': { readonly args: readonly []; readonly result: AppSettings }
  'settings:set': {
    readonly args: readonly [patch: DeepPartial<AppSettings>]
    /**
     * The FULL validated settings after the patch - not the patch echoed back - and
     * redacted on the way out exactly like `settings:get`.
     *
     * AN EMPTY `streamable.password` IN THE PATCH MEANS "NO CHANGE", not "clear it".
     * The renderer holds a redacted `''` and `useSettingsController` sends its whole
     * settings object back, so treating `''` as a value would wipe the credential every
     * time the user edited an unrelated field. This is the same class of rule as
     * `character.detected*` being unwriteable: main's copy wins because the renderer's
     * is knowingly incomplete. `src/main/ipc-handlers.ts` enforces it in
     * `narrowSettingsPatch`.
     */
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
  /**
   * One-shot Streamable credential check. Resolves with a result union; never rejects,
   * and never echoes the password back in the failure message.
   *
   * Uploads nothing. Streamable's documented API is read-only and its upload endpoint is
   * unofficial, so exactly HOW this verifies a credential is the business of the one
   * main-process module allowed to talk to Streamable - the single place every
   * assumption about that endpoint lives - and not this contract's.
   */
  'streamable:test': {
    readonly args: readonly [params: StreamableTestRequest]
    readonly result: StreamableTestResult
  }
  /**
   * Whether each stored secret is present and usable, and if not, why.
   *
   * The companion to redaction: the renderer cannot tell from its own copy of the
   * settings whether a password exists, and must be able to say "your saved Streamable
   * password could not be decrypted on this machine - type it again" instead of showing
   * an empty field and letting uploads fail.
   *
   * CARRIES NO SECRET, only facts about one.
   */
  'credentials:status': { readonly args: readonly []; readonly result: CredentialsStatusResult }
  /**
   * What this session has seen: areas entered, deaths, suicides, the character's level
   * and how long main has been counting. A stored value read straight off the counter,
   * like `obs:status` and `update:state` - asking costs nothing and starts nothing.
   *
   * `null` MEANS "COULD NOT BE READ", and the UI must render nothing rather than zeros in
   * that state. This is the same rule `app:version`'s `''` follows and it matters more
   * here: `0` is not the absence of a number, it is the CLAIM that nothing has happened,
   * and "you have died 0 times" is exactly the kind of confident falsehood that would let
   * a broken counter pass for a quiet session.
   */
  'stats:session': { readonly args: readonly []; readonly result: SessionStatsSnapshot | null }
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
   * One clip's upload state moved. Addressed by {@link ClipRecord.id} so the UI updates
   * that row IN PLACE rather than re-rendering the feed - see {@link ClipUploadUpdate}.
   *
   * Arrives for clips the renderer may never have seen (saved before the window opened,
   * or already aged out of the feed). An unknown `clipId` is dropped silently; it is a
   * normal consequence of main outliving every window, not an error.
   */
  'push:clip-upload': ClipUploadUpdate
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
  /**
   * A session counter moved - an area was entered, a death was counted, or the character's
   * level changed.
   *
   * Carries the COMPLETE snapshot rather than a delta, mirroring `push:character`, so the
   * renderer replaces its state instead of doing arithmetic that could drift from main's.
   *
   * NOT SENT FOR THE CLOCK. `SessionStatsSnapshot.uptimeMs` is stale the moment it
   * arrives, and pushing once a second so a timer could tick would put a permanent
   * heartbeat on a channel that is otherwise silent for minutes at a time. The renderer
   * ticks its own display from `startedAt`.
   */
  'push:stats': SessionStatsSnapshot
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
  /**
   * The running app's version for display, or `''` when it could not be read - in which
   * case the UI shows nothing rather than inventing one.
   */
  readonly getAppVersion: () => Promise<string>
  /** Current validated settings, with `streamable.password` blanked. */
  readonly getSettings: () => Promise<AppSettings>
  /**
   * Apply a partial patch; resolves with the full settings after validation+clamping,
   * again with `streamable.password` blanked. Sending it back as `''` means "leave the
   * saved password alone".
   */
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
  /**
   * One-shot Streamable credential check. Resolves with a result union; does not reject
   * on bad credentials. Uploads nothing.
   */
  readonly testStreamable: (params: StreamableTestRequest) => Promise<StreamableTestResult>
  /**
   * Whether each stored password is present and usable, and why not if it is not.
   * Returns facts about secrets, never a secret.
   */
  readonly getCredentialStatus: () => Promise<CredentialsStatusResult>
  /**
   * This session's counters, or `null` when main could not answer - in which case the UI
   * shows nothing rather than zeros. See the channel's note above for why that difference
   * matters.
   */
  readonly getSessionStats: () => Promise<SessionStatsSnapshot | null>

  /** Subscribe to live parsed events. Returns an unsubscribe function. */
  readonly onEvent: (listener: (event: PoeEvent) => void) => Unsubscribe
  /** Subscribe to log watcher status changes. Returns an unsubscribe function. */
  readonly onStatus: (listener: (status: WatcherStatus) => void) => Unsubscribe
  /** Subscribe to OBS connection state changes. Returns an unsubscribe function. */
  readonly onObsStatus: (listener: (status: ObsConnectionState) => void) => Unsubscribe
  /** Subscribe to newly saved clips. Returns an unsubscribe function. */
  readonly onClip: (listener: (clip: ClipRecord) => void) => Unsubscribe
  /**
   * Subscribe to per-clip upload progress, keyed by `ClipRecord.id`. Returns an
   * unsubscribe function. Updates for clips not currently on screen are expected -
   * ignore them.
   */
  readonly onClipUpload: (listener: (update: ClipUploadUpdate) => void) => Unsubscribe
  /** Subscribe to active-character changes. Returns an unsubscribe function. */
  readonly onCharacter: (listener: (character: ActiveCharacter) => void) => Unsubscribe
  /** Subscribe to auto-update state changes. Returns an unsubscribe function. */
  readonly onUpdate: (listener: (state: UpdateState) => void) => Unsubscribe
  /**
   * Subscribe to session-counter changes. Returns an unsubscribe function.
   *
   * Fires when a counter moves, NOT on a clock tick - a live session timer is the
   * renderer's own `setInterval` over `SessionStatsSnapshot.startedAt`.
   */
  readonly onSessionStats: (listener: (stats: SessionStatsSnapshot) => void) => Unsubscribe
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
