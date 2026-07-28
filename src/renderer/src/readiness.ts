/**
 * src/renderer/src/readiness.ts
 * =============================
 *
 * "Is poe-tool actually going to save a clip when I die?" - answered once, in one place,
 * from the four live sources that decide it.
 *
 *
 * WHY THIS IS A MODULE AND NOT FOUR BOOLEANS IN `App.tsx`
 * ------------------------------------------------------
 * The header pill claims something on every screen of this app: a count of how much of
 * the capture chain is ready, and the word "Capturing". A claim that is assembled inline
 * at the call site is a claim nobody can test, and the first version of that pill got it
 * wrong in the most dangerous possible direction - it counted OBS as ready on
 * `state === 'connected'` alone. A connected OBS with a STOPPED REPLAY BUFFER saves
 * nothing (`src/shared/ipc.ts` says so on the field itself: "If this is false, clip
 * requests will fail - the UI should warn"), so the pill read "Capturing 4 / 4" in
 * precisely the state that is the single most common way this app appears broken.
 *
 * So the rule lives here: pure, total, React-free, and pinned by `test/readiness.test.ts`.
 * The same reasoning as `./activity-derive.ts` and `./detection-swap.ts` - there is no DOM
 * test environment in this frozen dependency set, so anything that must be tested has to
 * be testable without one.
 *
 *
 * TWO OUTPUTS, ONE INPUT
 * ----------------------
 * {@link computeReadiness} answers "how ready are we, and why" - four checks, each with
 * the sentence the pill's tooltip shows. {@link shellFaults} answers a different and
 * narrower question: "is something BROKEN RIGHT NOW that the user cannot see from here?"
 *
 * The difference matters. A user who has not connected OBS yet is not ready, but nothing
 * is wrong - they are mid-setup, and a permanent red banner would train them to ignore
 * banners. A user whose replay buffer stopped, whose Client.txt vanished, or whose
 * character was never identified has a LIVE FAULT: the app looks like it is working, the
 * event feed scrolls, and no clip will ever be saved. Those three get a banner in the
 * shell, above the scroll area, on every view - because before this module existed each
 * one was only visible on a settings tab two navigations away.
 */

import type { ActiveCharacter, WatcherStatus } from '../../shared/events'
import type { ObsConnectionState } from '../../shared/ipc'
import type { SettingsTabId } from './settings-tabs'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Everything the answer depends on. Every field may be `null`, meaning main has not
 * answered yet - which is NOT the same as a negative answer and never produces a fault.
 */
export interface ReadinessInput {
  readonly watcher: WatcherStatus | null
  readonly obs: ObsConnectionState | null
  /** `settings.clips.enabled`. Local state, so never `null`. */
  readonly clipsEnabled: boolean
  readonly character: ActiveCharacter | null
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** The four things that have to be true, in the words the pill's tooltip uses. */
export type ReadinessLabel = 'Log' | 'OBS' | 'Clips' | 'Character'

export interface ReadinessCheck {
  readonly label: ReadinessLabel
  readonly ok: boolean
  /**
   * Why it is what it is - main's own message where there is one, so a `read-error`
   * reads "read error - EACCES: ..." rather than the useless "not tailing".
   */
  readonly detail: string
}

export interface Readiness {
  readonly checks: readonly ReadinessCheck[]
  /** How many of {@link checks} are `ok`. Never a constant. */
  readonly ready: number
  readonly total: number
  /**
   * The watcher is tailing RIGHT NOW - the one condition under which poe-tool is doing
   * something rather than being prepared to. Drives the live dot and the word
   * "Capturing"; the count is a separate, honest number in every state.
   */
  readonly watching: boolean
}

/**
 * The log check.
 *
 * EXHAUSTIVE over `WatcherState`, with no `default`, so a sixth state is a compile error
 * here rather than a status that silently reads "not tailing".
 *
 * Every failing state carries main's `message`. That is the whole point: 'file-missing',
 * 'read-error', 'idle with no path' and 'rotated' are four completely different problems
 * with four different fixes, and collapsing them into "not tailing" is how a user ends up
 * staring at a hollow dot after moving their PoE install.
 */
export function describeLogReadiness(status: WatcherStatus | null): ReadinessCheck {
  if (status === null) {
    return { label: 'Log', ok: false, detail: 'waiting for the background process' }
  }

  switch (status.state) {
    case 'idle':
      return {
        label: 'Log',
        ok: false,
        detail: status.path === null ? 'no Client.txt path set yet' : 'watcher stopped'
      }
    case 'tailing':
      return { label: 'Log', ok: true, detail: 'tailing Client.txt' }
    case 'file-missing':
      return { label: 'Log', ok: false, detail: `file missing — ${status.message}` }
    case 'rotated':
      // Transient and self-healing: the file was truncated and the watcher is re-reading.
      return { label: 'Log', ok: false, detail: `rotated — ${status.message}` }
    case 'read-error':
      return {
        label: 'Log',
        ok: false,
        detail:
          status.code === null
            ? `read error — ${status.message}`
            : `read error — ${status.code}: ${status.message}`
      }
  }
}

/**
 * The OBS check - and the reason this module exists.
 *
 * `connected` IS NOT ENOUGH. `ObsConnectedState.replayBufferActive === false` means OBS
 * is there, answering, healthy, and will refuse every `SaveReplayBuffer` request; a death
 * in that state produces nothing at all. So the check is
 * `connected && replayBufferActive !== false`.
 *
 * `null` (we have not managed to ask yet) counts as OK, deliberately. It is the state
 * every healthy connection passes through in its first moments, and failing the count
 * there would flash "3 / 4" at users whose setup is perfect. The tooltip says the state
 * is unknown rather than claiming the buffer is running, which is the honest version of
 * "probably fine" - and unlike `false`, it never produces a fault banner.
 */
export function describeObsReadiness(status: ObsConnectionState | null): ReadinessCheck {
  if (status === null) {
    return { label: 'OBS', ok: false, detail: 'waiting for the background process' }
  }

  switch (status.state) {
    case 'disconnected':
      return { label: 'OBS', ok: false, detail: 'not connected' }
    case 'connecting':
      return {
        label: 'OBS',
        ok: false,
        detail: `connecting to ${status.host}:${status.port} (attempt ${String(status.attempt)})`
      }
    case 'connected':
      if (status.replayBufferActive === false) {
        return {
          label: 'OBS',
          ok: false,
          detail: 'connected, REPLAY BUFFER NOT RUNNING — no clip can be saved'
        }
      }
      if (status.replayBufferActive === null) {
        return { label: 'OBS', ok: true, detail: 'connected, replay buffer state not known yet' }
      }
      return { label: 'OBS', ok: true, detail: 'connected, replay buffer running' }
    case 'error':
      return {
        label: 'OBS',
        ok: false,
        detail: status.willRetry ? `${status.message} (retrying)` : status.message
      }
  }
}

/** The clips check. Local settings state, so there is no "not answered yet". */
export function describeClipsReadiness(enabled: boolean): ReadinessCheck {
  return {
    label: 'Clips',
    ok: enabled,
    detail: enabled ? 'enabled' : 'turned off — deaths are recorded but nothing is saved'
  }
}

/**
 * The character check.
 *
 * `name === null` if and only if `source === 'none'`, and it means `DeathEvent.isSelf` is
 * false for every line in the log - so the clipper never fires for anybody.
 */
export function describeCharacterReadiness(character: ActiveCharacter | null): ReadinessCheck {
  if (character === null) {
    return { label: 'Character', ok: false, detail: 'waiting for the background process' }
  }
  if (character.name === null) {
    return {
      label: 'Character',
      ok: false,
      detail: 'nobody resolved — no death can be recognised as yours'
    }
  }
  return {
    label: 'Character',
    ok: true,
    detail:
      character.source === 'override'
        ? `${character.name} (set by hand)`
        : `${character.name} (auto-detected)`
  }
}

/**
 * All four checks plus the count, in pill order.
 *
 * `ready` is `checks.filter(ok).length` and nothing else. A hardcoded total anywhere in
 * this app would be the window telling a user their deaths are being captured while one
 * of the four is dead.
 */
export function computeReadiness(input: ReadinessInput): Readiness {
  const checks: readonly ReadinessCheck[] = [
    describeLogReadiness(input.watcher),
    describeObsReadiness(input.obs),
    describeClipsReadiness(input.clipsEnabled),
    describeCharacterReadiness(input.character)
  ]

  return {
    checks,
    ready: checks.filter((check) => check.ok).length,
    total: checks.length,
    watching: input.watcher !== null && input.watcher.state === 'tailing'
  }
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/**
 * A live fault, worth a banner in the shell on every view.
 *
 * Not the same set as "checks that are not ok" - see the module header. A fault is
 * something that is WRONG NOW and that the user would otherwise have to open a settings
 * tab to discover.
 */
export interface ShellFault {
  readonly id: 'log-missing' | 'log-error' | 'obs-replay-buffer' | 'character-none'
  /** `bad` = nothing can work. `warn` = it may well fix itself. */
  readonly tone: 'bad' | 'warn'
  readonly title: string
  /** Main's own message, verbatim, when there is one. Rendered as a separate line. */
  readonly detail: string | null
  readonly body: string
  /** Where the fix lives. The banner's button switches view AND selects this tab. */
  readonly tab: SettingsTabId
  readonly actionLabel: string
}

/**
 * The faults that are live right now, in pipeline order: nothing is parsed -> nothing is
 * recognised as yours -> nothing is saved.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 *  - `idle` / `disconnected` / `connecting` / clips switched off. Those are an
 *    unconfigured app, not a broken one, and a banner that is up from first launch until
 *    setup is finished is a banner nobody reads by the time it matters.
 *  - `rotated`. PoE truncates Client.txt on purpose and the watcher resumes by itself
 *    within a poll; a banner for it would fire during normal play.
 *  - `replayBufferActive === null`. We have not asked yet - see
 *    {@link describeObsReadiness}. Announcing a fault we have not established would be
 *    the same sin as hiding one we have.
 */
export function shellFaults(input: ReadinessInput): readonly ShellFault[] {
  const faults: ShellFault[] = []
  const { watcher, obs, character } = input

  if (watcher !== null && watcher.state === 'file-missing') {
    faults.push({
      id: 'log-missing',
      // `warn`: documented as NOT fatal. The game may simply not be running, and the
      // watcher goes back to tailing on its own the moment the file reappears.
      tone: 'warn',
      title: 'Client.txt is not there',
      detail: watcher.message,
      body:
        'Nothing is being parsed, so no death can be seen. This is normal if the game is not running — poe-tool keeps polling and picks up again by itself. If you moved or reinstalled the game, the path needs changing.',
      tab: 'log',
      actionLabel: 'Check the log path'
    })
  }

  if (watcher !== null && watcher.state === 'read-error') {
    faults.push({
      id: 'log-error',
      tone: 'bad',
      title: 'Client.txt could not be read',
      detail: watcher.code === null ? watcher.message : `${watcher.code}: ${watcher.message}`,
      body:
        'The file is there but poe-tool cannot read it — a permissions problem, a lock, or a bad path. It keeps retrying, but until it succeeds nothing is parsed and no clip can be saved.',
      tab: 'log',
      actionLabel: 'Check the log path'
    })
  }

  if (character !== null && character.source === 'none') {
    faults.push({
      id: 'character-none',
      tone: 'bad',
      title: 'Nothing will be clipped',
      detail: null,
      body:
        'poe-tool has not identified your character, so it treats every logged death as somebody else’s and never asks OBS to save. Tailing, parsing and the event list all keep working — the clipping is the part that is silently idle. Pick your name from the ones seen in your log, or type it.',
      tab: 'character',
      actionLabel: 'Choose your character'
    })
  }

  if (obs !== null && obs.state === 'connected' && obs.replayBufferActive === false) {
    faults.push({
      id: 'obs-replay-buffer',
      tone: 'bad',
      title: 'OBS replay buffer is not running',
      detail: null,
      body:
        'OBS is connected and healthy, but its replay buffer is stopped, so it has nothing to save and every clip request will fail. Start it in OBS (Controls → Start Replay Buffer).',
      tab: 'obs',
      actionLabel: 'Open OBS settings'
    })
  }

  return faults
}
