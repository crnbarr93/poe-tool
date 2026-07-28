/**
 * src/renderer/src/hooks.ts
 * =========================
 *
 * Every conversation the renderer has with the main process, in one place.
 *
 * RULES FOR THE WHOLE RENDERER, ENFORCED HERE
 * -------------------------------------------
 *  - NO `electron`, NO `node:*`. `window.poeTool` (the preload bridge) is the only
 *    door out of this process. tsconfig.web.json compiles with `types: []`, so there
 *    are not even node typings available to tempt anyone.
 *  - NO `any`.
 *  - EVERY subscription is torn down in the effect's cleanup. React StrictMode
 *    double-mounts in development specifically so that a missing `unsubscribe()`
 *    shows up as duplicated rows on the very first render instead of as a slow leak
 *    three hours into a mapping session.
 *
 *
 * THE RENDERER IS NOT ON THE CRITICAL PATH
 * ----------------------------------------
 * Nothing in this file is load-bearing for capturing a clip. Main tails the log,
 * fires the OBS save and files the clip whether or not a window exists. These hooks
 * only mirror that work for the user's benefit, which is why every failure path here
 * degrades to "show a message" rather than "retry aggressively": a broken UI must
 * never be able to disturb the capture pipeline.
 *
 *
 * THE SUBSCRIBE-THEN-FETCH ORDER MATTERS
 * --------------------------------------
 * Each live hook subscribes to its push channel FIRST and only then issues the
 * `*:recent` / `*:status` fetch. Done the other way round, an event pushed in the gap
 * between the fetch resolving and the listener attaching would be dropped forever.
 * Subscribing first can only produce the opposite (benign) problem - the same item
 * arriving twice - which the identity-keyed merge below de-duplicates.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ActiveCharacter, PoeEvent, WatcherStatus } from '../../shared/events'
import type {
  ClipRecord,
  ClipUploadUpdate,
  CredentialsStatusResult,
  ObsConnectionState,
  PoeToolApi,
  SessionStatsSnapshot,
  UpdateState
} from '../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../shared/settings'
import { applySettingsPatch } from '../../shared/settings'
import {
  dismissDetectionSwap,
  INITIAL_DETECTION_SWAP_STATE,
  reduceDetectionSwap,
  type DetectionSwap,
  type DetectionSwapState
} from './detection-swap'
import { describeError } from './format'

// ---------------------------------------------------------------------------
// The preload bridge
// ---------------------------------------------------------------------------

/** Resolved once; see {@link getBridge} for why the identity has to be stable. */
let cachedBridge: PoeToolApi | null = null

/**
 * The `window.poeTool` bridge, or `null` when it is not there.
 *
 * `Window.poeTool` is typed as always-present (see the `declare global` block in
 * `src/shared/ipc.ts`), and in a correctly built app it always is. The runtime check
 * exists for the one case the type system cannot describe: the preload script failed
 * to load or threw. Without this, every component would fail with
 * `Cannot read properties of undefined (reading 'getSettings')` and the user would
 * get a blank window with no clue why. With it, they get a sentence naming the cause.
 *
 * The result is cached so the object identity is stable for the life of the window.
 * Every hook below lists `api` in its dependency array; an identity that changed
 * between renders would tear down and re-establish all four subscriptions on every
 * keystroke.
 *
 * Deliberately a plain function, not a hook, so `App` may branch on it before
 * mounting anything that uses hooks.
 */
export function getBridge(): PoeToolApi | null {
  if (cachedBridge !== null) return cachedBridge
  if (typeof window === 'undefined') return null

  const api: PoeToolApi | undefined = window.poeTool
  if (api === undefined) return null

  cachedBridge = api
  return cachedBridge
}

// ---------------------------------------------------------------------------
// App identity
// ---------------------------------------------------------------------------

/**
 * The running app's version, e.g. `"0.2.0"`, or `null` until it is known.
 *
 * ASKED ONCE, AND NULL IS A REAL ANSWER. `null` covers both "the reply has not arrived
 * yet" and "asking failed", and the caller renders NOTHING in that state. That is
 * deliberate: the sidebar's version line exists so a user can quote the right build in a
 * bug report, and a placeholder that looks like a version - a dash, a `0.0.0`, the string
 * the design mocked up with - is worse than no line at all.
 *
 * There is no push channel for this and there should not be: the version of a running
 * process cannot change while it runs. An update that has been downloaded installs on
 * quit, and the number here stays true until then.
 */
export function useAppVersion(api: PoeToolApi): string | null {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    void api.getAppVersion().then(
      (value) => {
        // `''` is main's documented "could not be read" answer; it collapses into the same
        // "say nothing" state as a failed call rather than rendering an empty gap.
        if (active) setVersion(value === '' ? null : value)
      },
      (error: unknown) => {
        console.warn('poe-tool: app:version failed', describeError(error))
      }
    )

    return () => {
      active = false
    }
  }, [api])

  return version
}

// ---------------------------------------------------------------------------
// Feed plumbing (shared by the event feed and the clip list)
// ---------------------------------------------------------------------------

/**
 * A feed row: the value plus a React key.
 *
 * Neither `PoeEvent` nor `ClipRecord` carries an id, and both can legitimately repeat
 * (the same zone entered twice, two clips saved in the same second). Rather than
 * inventing a fragile content hash for `key`, each row is stamped with a
 * process-unique counter as it enters renderer state. React then never confuses two
 * genuinely different rows that happen to look identical.
 */
export interface FeedItem<T> {
  readonly key: string
  readonly value: T
}

let feedKeyCounter = 0

function nextFeedKey(prefix: string): string {
  feedKeyCounter += 1
  return `${prefix}${feedKeyCounter}`
}

/**
 * Merges newly arrived values into a newest-first feed, dropping ones already shown
 * and trimming to `limit`.
 *
 * De-duplication is needed because the initial `*:recent` snapshot overlaps with
 * whatever arrived on the push channel while it was in flight (see the subscribe-then-
 * fetch note at the top of this file).
 *
 * Returns `prev` BY REFERENCE when nothing new arrived, so a redundant push cannot
 * cause a re-render.
 */
function mergeFeed<T>(
  prev: readonly FeedItem<T>[],
  incoming: readonly T[],
  identity: (value: T) => string,
  keyPrefix: string,
  limit: number,
  position: 'newer' | 'older'
): readonly FeedItem<T>[] {
  const seen = new Set(prev.map((item) => identity(item.value)))
  const fresh: FeedItem<T>[] = []

  for (const value of incoming) {
    const id = identity(value)
    if (seen.has(id)) continue
    seen.add(id)
    fresh.push({ key: nextFeedKey(keyPrefix), value })
  }

  if (fresh.length === 0) return prev

  const merged = position === 'newer' ? [...fresh, ...prev] : [...prev, ...fresh]
  return merged.length > limit ? merged.slice(0, limit) : merged
}

/**
 * Identity of an event for de-duplication purposes.
 *
 * `meta.clientMs` (milliseconds since the game client started) plus the raw text is
 * unique within a client session; `detectedAt` disambiguates the same line being
 * re-read after a log rotation, which is a genuinely different occurrence and should
 * appear twice.
 */
function eventIdentity(event: PoeEvent): string {
  return `${event.detectedAt}|${event.meta.clientMs}|${event.type}|${event.meta.raw}`
}

/**
 * Identity of a clip: its id, minted in main.
 *
 * NOT `savedAt|originalPath` any more, and the difference is not cosmetic. `ClipRecord.id`
 * is the address `push:clip-upload` updates are sent to, so the value this feed
 * de-duplicates on and the value an update is matched against have to be the SAME field -
 * otherwise a clip could arrive twice under one identity while its upload updates chase
 * the other, and the second copy would sit at "queued" forever. The id is also stable
 * across a record being rewritten (an upload state folded in, a note added), which the
 * path-and-time pair was only by luck: a clip that failed to move keeps the OBS path it
 * shares with nothing else purely by accident, and a remote-OBS clip never had a local
 * path at all.
 */
function clipIdentity(clip: ClipRecord): string {
  return clip.id
}

/**
 * Applies one `push:clip-upload` update to a clip feed, in place.
 *
 * Returns `prev` BY REFERENCE when the update names a clip that is not on screen, or
 * carries a state the row already has, so a redundant push cannot re-render the list.
 *
 * AN UNKNOWN `clipId` IS NORMAL, NOT AN ERROR - the clip may have aged out of the feed,
 * or been saved before this window opened. Main outlives every window; dropping the
 * update silently is the documented behaviour, and the row's own `upload` field is
 * current anyway when it does arrive, because main keeps the `clips:recent` snapshot up
 * to date.
 */
function applyUploadUpdate(
  prev: readonly FeedItem<ClipRecord>[],
  update: ClipUploadUpdate
): readonly FeedItem<ClipRecord>[] {
  let changed = false

  const next = prev.map((item) => {
    if (item.value.id !== update.clipId) return item
    if (item.value.upload === update.upload) return item
    changed = true
    // The key is preserved deliberately: this is the same row, so React must not remount
    // it. Only `upload` moves.
    return { key: item.key, value: { ...item.value, upload: update.upload } }
  })

  return changed ? next : prev
}

// ---------------------------------------------------------------------------
// Live status hooks
// ---------------------------------------------------------------------------

/**
 * Live log-watcher status. `null` until the first status arrives.
 *
 * The seed from `log:status` is applied with `prev ?? seeded` so that a push which
 * won the race is never overwritten by the older snapshot it beat.
 */
export function useWatcherStatus(api: PoeToolApi): WatcherStatus | null {
  const [status, setStatus] = useState<WatcherStatus | null>(null)

  useEffect(() => {
    let active = true

    const unsubscribe = api.onStatus((next) => {
      if (active) setStatus(next)
    })

    void api.getLogStatus().then(
      (seeded) => {
        if (active) setStatus((prev) => prev ?? seeded)
      },
      (error: unknown) => {
        console.warn('poe-tool: log:status failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  return status
}

/**
 * The RESOLVED active character - override > detected > none, as decided by main.
 * `null` until the first answer arrives.
 *
 * NEVER RE-DERIVED HERE. The renderer holds `settings.character` and could compute this
 * itself; it must not. Main owns the rule, because it is the same rule `DeathEvent.isSelf`
 * is stamped with, and a second implementation that drifted would let this window claim
 * clipping is armed while the clipper sits idle. `source` comes along precisely so the UI
 * can say WHICH rule fired instead of guessing.
 *
 * `push:character` fires only when the resolved value actually CHANGES, so this is not a
 * poll and does not spray during a levelling session. Subscribe-then-fetch as everywhere
 * else, with `prev ?? seeded` so a push that beat the fetch is not overwritten by the
 * older snapshot it beat.
 */
export function useActiveCharacter(api: PoeToolApi): ActiveCharacter | null {
  const [character, setCharacter] = useState<ActiveCharacter | null>(null)

  useEffect(() => {
    let active = true

    const unsubscribe = api.onCharacter((next) => {
      if (active) setCharacter(next)
    })

    void api.getActiveCharacter().then(
      (seeded) => {
        if (active) setCharacter((prev) => prev ?? seeded)
      },
      (error: unknown) => {
        console.warn('poe-tool: character:active failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  return character
}

/**
 * What {@link useDetectionSwap} returns.
 *
 * NOT the component of a similar name - `components/DetectionSwapNotice.tsx` renders this.
 */
export interface DetectionSwapView {
  /** The unacknowledged swap, or `null` when there is nothing to say. */
  readonly swap: DetectionSwap | null
  /** Acknowledge it. Changes no settings - see {@link dismissDetectionSwap}. */
  readonly dismiss: () => void
}

/**
 * Watches the resolved character for AUTO-DETECTION MOVING TO A DIFFERENT CHARACTER.
 *
 * A level-2 mule's single level-up permanently displaces the level-93 character the
 * user actually plays, is persisted, and switches clipping off with no error anywhere -
 * see `./detection-swap.ts` for the verbatim log lines. This is the only thing in the
 * app that notices.
 *
 * All the logic is in the pure reducer; this hook is just the memory. It re-derives
 * nothing about WHO is active: `character` is main's answer, arriving on
 * `push:character` through {@link useActiveCharacter}.
 *
 * MOUNT IT IN THE SHELL, FOR THE LIFE OF THE WINDOW - never inside a view or a tab. The
 * reducer diffs two CONSECUTIVE values seen while this hook is mounted, so a swap that
 * lands while the component holding it is unmounted is not merely missed: the next mount
 * seeds `seen` straight to the new character and no warning is ever produced for it.
 * `App.tsx` is the only correct home. See `./detection-swap.ts`.
 */
export function useDetectionSwap(character: ActiveCharacter | null): DetectionSwapView {
  const [state, setState] = useState<DetectionSwapState>(INITIAL_DETECTION_SWAP_STATE)

  useEffect(() => {
    if (character === null) return
    setState((prev) => reduceDetectionSwap(prev, character))
  }, [character])

  const dismiss = useCallback((): void => {
    setState(dismissDetectionSwap)
  }, [])

  return { swap: state.swap, dismiss }
}

/** What {@link useCharacterSuggestions} returns. */
export interface CharacterSuggestions {
  /** Names harvested from the log, main's order. NEVER re-sorted or de-duplicated here. */
  readonly names: readonly string[]
  /** True while a fetch is in flight. */
  readonly loading: boolean
  /** True once a fetch has completed, so "no names" can be told apart from "not asked yet". */
  readonly loaded: boolean
  /** Message from a failed fetch. */
  readonly error: string | null
  /** Ask again - main re-reads the log and the session grows, so the answer improves. */
  readonly refresh: () => void
}

/**
 * Character names main has seen in the log, for the picker shown when nothing is known.
 *
 * FETCHED ON DEMAND, NOT LIVE. There is no push channel for this and there should not be:
 * it is a one-shot list the user consults at the moment they are fixing a broken
 * configuration, not state the window has to mirror. `enabled` gates the request so the
 * overwhelmingly common case - a character is already known - costs no IPC at all.
 *
 * {@link CharacterSuggestions.refresh} matters more than it looks. Main answers from a
 * bounded sweep of the END of Client.txt merged with this session's events, so the
 * answer genuinely improves while the window is open - a character whose only recent
 * appearance is a death that happens a minute from now is not in the first answer.
 *
 * An empty result is NORMAL, not an error, and the caller must still offer free-text
 * entry: there may be no log path configured yet, or the game may never have written
 * one on this machine.
 */
export function useCharacterSuggestions(api: PoeToolApi, enabled: boolean): CharacterSuggestions {
  const [names, setNames] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (!enabled) return undefined

    let active = true
    setLoading(true)

    void api.getCharacterSuggestions().then(
      (result) => {
        if (!active) return
        setNames(result.names)
        setLoading(false)
        setLoaded(true)
        setError(null)
      },
      (fetchError: unknown) => {
        if (!active) return
        setLoading(false)
        setLoaded(true)
        setError(describeError(fetchError))
      }
    )

    // `active` is what makes a StrictMode double-mount (or a `refresh` that lands while an
    // earlier request is still in flight) harmless: the stale response is dropped instead
    // of racing the fresh one into state.
    return () => {
      active = false
    }
  }, [api, enabled, token])

  const refresh = useCallback((): void => {
    setToken((current) => current + 1)
  }, [])

  return { names, loading, loaded, error, refresh }
}

/** Live OBS connection state. `null` until the first state arrives. */
export function useObsStatus(api: PoeToolApi): ObsConnectionState | null {
  const [status, setStatus] = useState<ObsConnectionState | null>(null)

  useEffect(() => {
    let active = true

    const unsubscribe = api.onObsStatus((next) => {
      if (active) setStatus(next)
    })

    void api.getObsStatus().then(
      (seeded) => {
        if (active) setStatus((prev) => prev ?? seeded)
      },
      (error: unknown) => {
        console.warn('poe-tool: obs:status failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  return status
}

/**
 * Live auto-update state. `null` until the first answer arrives.
 *
 * NOT A POLL, and asking does not start one. Main runs exactly one check, at launch, and
 * pushes every state change on `push:update`; this hook only mirrors it. There is no
 * "check now" in the IPC contract on purpose, so a config window left open overnight
 * cannot become a poller against GitHub.
 *
 * Subscribe-then-fetch with `prev ?? seeded`, like every other live hook here: the
 * download can finish in the gap between the fetch being issued and resolving, and the
 * older snapshot must not overwrite the push that beat it.
 */
export function useUpdateState(api: PoeToolApi): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let active = true

    const unsubscribe = api.onUpdate((next) => {
      if (active) setState(next)
    })

    void api.getUpdateState().then(
      (seeded) => {
        if (active) setState((prev) => prev ?? seeded)
      },
      (error: unknown) => {
        console.warn('poe-tool: update:state failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  return state
}

/**
 * This session's counters - areas entered, deaths, suicides, the character's level and
 * when main started counting. `null` until the first answer arrives, and `null` for good
 * if main could not read them.
 *
 * NULL IS NOT ZERO, AND THE CALLER MUST NOT COLLAPSE THE TWO. `stats:session` resolves
 * with `null` to mean "could not be read"; a UI that rendered that as `0` would be
 * claiming nothing has happened this session, which is exactly the confident falsehood
 * that lets a broken counter pass for a quiet evening. Render an em-dash instead - see
 * `views/ActivityView.tsx`.
 *
 * NOT A CLOCK. `SessionStatsSnapshot.uptimeMs` is stale the instant it arrives and there
 * is deliberately no push for time passing; a view that wants a ticking session length
 * runs its own interval over `startedAt`. `push:stats` fires only when a counter actually
 * moves, so this is silent for minutes at a time.
 *
 * Subscribe-then-fetch with `prev ?? seeded`, like every other live hook here: a death
 * counted in the gap between the fetch being issued and resolving must not be overwritten
 * by the older snapshot it beat.
 */
export function useSessionStats(api: PoeToolApi): SessionStatsSnapshot | null {
  const [stats, setStats] = useState<SessionStatsSnapshot | null>(null)

  useEffect(() => {
    let active = true

    const unsubscribe = api.onSessionStats((next) => {
      if (active) setStats(next)
    })

    void api.getSessionStats().then(
      (seeded) => {
        if (active) setStats((prev) => prev ?? seeded)
      },
      (error: unknown) => {
        console.warn('poe-tool: stats:session failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  return stats
}

/**
 * The last `limit` parsed events, NEWEST FIRST.
 *
 * `events:recent` is documented as a newest-LAST ring buffer, so the snapshot is
 * reversed on arrival; the feed reads top-down like a chat log.
 */
export function useEventFeed(api: PoeToolApi, limit: number): readonly FeedItem<PoeEvent>[] {
  const [items, setItems] = useState<readonly FeedItem<PoeEvent>[]>([])

  useEffect(() => {
    let active = true

    const unsubscribe = api.onEvent((event) => {
      if (!active) return
      setItems((prev) => mergeFeed(prev, [event], eventIdentity, 'e', limit, 'newer'))
    })

    void api.getRecentEvents().then(
      (recent) => {
        if (!active) return
        const newestFirst = [...recent].reverse()
        setItems((prev) => mergeFeed(prev, newestFirst, eventIdentity, 'e', limit, 'older'))
      },
      (error: unknown) => {
        console.warn('poe-tool: events:recent failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [api, limit])

  return items
}

/**
 * The last `limit` clips, newest first, WITH THEIR UPLOAD STATE KEPT LIVE.
 *
 * `clips:recent` is already newest-first.
 *
 * TWO SUBSCRIPTIONS, ONE FEED. A clip arrives once on `push:clip` and then changes
 * repeatedly on `push:clip-upload` as its upload is queued, sent, transcoded and either
 * finished or lost. Merging both here rather than tracking upload state in a separate map
 * next to the list is what keeps a row and its upload state from ever disagreeing - and
 * `ClipRecord.upload` is documented as a SNAPSHOT taken when the record was sent, so a
 * component reading only that field would show every upload as permanently pending.
 *
 * Both subscriptions are detached in the cleanup. Missing either one would leave a
 * StrictMode double-mount (or any reload) with an orphaned listener writing into dead
 * state.
 */
export function useClipFeed(api: PoeToolApi, limit: number): readonly FeedItem<ClipRecord>[] {
  const [items, setItems] = useState<readonly FeedItem<ClipRecord>[]>([])

  useEffect(() => {
    let active = true

    const unsubscribeClip = api.onClip((clip) => {
      if (!active) return
      setItems((prev) => mergeFeed(prev, [clip], clipIdentity, 'c', limit, 'newer'))
    })

    const unsubscribeUpload = api.onClipUpload((update) => {
      if (!active) return
      setItems((prev) => applyUploadUpdate(prev, update))
    })

    void api.getRecentClips().then(
      (recent) => {
        if (!active) return
        setItems((prev) => mergeFeed(prev, recent, clipIdentity, 'c', limit, 'older'))
      },
      (error: unknown) => {
        console.warn('poe-tool: clips:recent failed', describeError(error))
      }
    )

    return () => {
      active = false
      unsubscribeClip()
      unsubscribeUpload()
    }
  }, [api, limit])

  return items
}

// ---------------------------------------------------------------------------
// Stored credentials
// ---------------------------------------------------------------------------

/** What {@link useCredentialStatus} returns. */
export interface CredentialStatusView {
  /** Main's answer, or `null` until the first one arrives (or if asking failed). */
  readonly status: CredentialsStatusResult | null
  /** Message from a failed `credentials:status`. */
  readonly error: string | null
  /** Ask again. Use after anything that may have written or replaced a stored secret. */
  readonly refresh: () => void
}

/**
 * Whether each stored password is present and usable - and if it is not, why.
 *
 * THE ONLY WAY THIS WINDOW CAN KNOW. `settings.streamable.password` is `''` here at all
 * times, because main blanks it on the way out; that says nothing about whether one is
 * stored. Without this channel a user whose DPAPI-encrypted password can no longer be
 * decrypted (settings copied from another machine, Windows rotated its key) sees an empty
 * field, retypes nothing, and never finds out why their uploads stopped.
 *
 * FETCHED ON DEMAND, NOT LIVE, and deliberately so: there is no push channel for it and
 * there should not be, because the value only changes as a direct result of something the
 * user just did in this window. {@link CredentialStatusView.refresh} is how the caller
 * says "I have just saved a password" or "I have just tested one".
 *
 * A failed fetch leaves `status` at its previous value rather than blanking it - a
 * transient IPC failure should not make the UI claim a stored password has vanished.
 */
export function useCredentialStatus(api: PoeToolApi): CredentialStatusView {
  const [status, setStatus] = useState<CredentialsStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    let active = true

    void api.getCredentialStatus().then(
      (next) => {
        if (!active) return
        setStatus(next)
        setError(null)
      },
      (fetchError: unknown) => {
        if (!active) return
        setError(describeError(fetchError))
      }
    )

    // `active` drops the response of a request that a `refresh` (or a StrictMode
    // double-mount) has already superseded, so a slow answer cannot overwrite a fresh one.
    return () => {
      active = false
    }
  }, [api, token])

  const refresh = useCallback((): void => {
    setToken((current) => current + 1)
  }, [])

  return { status, error, refresh }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * How long the UI waits after the last keystroke before persisting.
 *
 * Short enough that "did that save?" never becomes a question, long enough that
 * typing a directory path is one write instead of forty.
 */
export const SETTINGS_DEBOUNCE_MS = 350

/**
 * Field-by-field equality. `AppSettings` is a fixed, flat, primitive-only shape.
 *
 * The three `detected*` fields are compared even though this window can never write them
 * (main strips them from every patch - see `narrowSettingsPatch`). They are exactly the
 * fields that change BEHIND the renderer's back, when a level-up lands in main, and this
 * comparison is what decides whether the reply to a save is adopted into local state.
 * Leaving them out would pin a stale detection in the UI until the next reload.
 *
 * `streamable.password` IS COMPARED FOR THE OPPOSITE REASON, and it is the one entry here
 * that is expected to differ on a normal round-trip. The user types a password, local
 * state holds it, main saves it and replies with `''` (every `AppSettings` leaving main
 * has its secrets blanked). That difference MUST be seen, so that the reply is adopted
 * and this window goes back to holding a blank - which is what makes the next patch it
 * sends mean "leave the stored password alone" rather than "here it is again". A missing
 * comparison here would leave the plaintext sitting in renderer state for the lifetime of
 * the window, which is exactly what the redaction exists to prevent.
 *
 * Every other `streamable` field is compared for the ordinary reason: without them a
 * toggle click would compare equal, `applyLocal` would report "nothing changed", and the
 * control would appear not to work at all.
 */
function sameSettings(a: AppSettings | null, b: AppSettings): boolean {
  if (a === null) return false
  return (
    a.log.path === b.log.path &&
    a.log.pollIntervalMs === b.log.pollIntervalMs &&
    a.character.override === b.character.override &&
    a.character.detected === b.character.detected &&
    a.character.detectedClass === b.character.detectedClass &&
    a.character.detectedLevel === b.character.detectedLevel &&
    a.obs.host === b.obs.host &&
    a.obs.port === b.obs.port &&
    a.obs.password === b.obs.password &&
    a.obs.autoConnect === b.obs.autoConnect &&
    a.clips.enabled === b.clips.enabled &&
    a.clips.libraryDir === b.clips.libraryDir &&
    a.clips.debounceMs === b.clips.debounceMs &&
    a.clips.writeSidecar === b.clips.writeSidecar &&
    a.streamable.enabled === b.streamable.enabled &&
    a.streamable.email === b.streamable.email &&
    a.streamable.password === b.streamable.password &&
    a.streamable.autoUpload === b.streamable.autoUpload &&
    a.streamable.maxFileBytes === b.streamable.maxFileBytes
  )
}

/** What {@link useSettingsController} hands to the sections. */
export interface SettingsController {
  /** Current settings, or `null` while the first `settings:get` is in flight. */
  readonly settings: AppSettings | null
  /** True while the initial load is running. */
  readonly loading: boolean
  /** Message from a failed `settings:get`. The UI offers a retry. */
  readonly loadError: string | null
  /** Message from a failed `settings:set`. */
  readonly saveError: string | null
  /** True while a `settings:set` is in flight. */
  readonly saving: boolean
  /** Apply a patch optimistically and persist it after the debounce window. */
  readonly update: (patch: DeepPartial<AppSettings>) => void
  /** Apply a patch and persist immediately - for clicks, not keystrokes. */
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  /** Persist any pending edit right now. Safe to call when nothing is pending. */
  readonly flush: () => void
  /** Re-run `settings:get`, discarding local state. */
  readonly reload: () => void
}

/**
 * Owns the settings draft and its debounced write-back.
 *
 * OPTIMISTIC LOCAL STATE, VALIDATED THE SAME WAY MAIN WILL VALIDATE IT
 * -------------------------------------------------------------------
 * A patch is applied locally with the SAME `applySettingsPatch` the main process runs
 * (it lives in `src/shared/settings.ts` precisely so both sides share one
 * implementation). The local preview is therefore already clamped and trimmed exactly
 * as the persisted value will be, so the `settings:set` response is normally
 * byte-identical to what is already on screen and reconciliation is a no-op. No
 * flicker, and no chance of the UI showing a value that main would have rejected.
 *
 * WHY THE WHOLE OBJECT IS SENT AS THE PATCH
 * -----------------------------------------
 * Debouncing means several edits collapse into one write. Accumulating a partial
 * patch across those edits is fiddly and has a nasty edge (an explicitly-`undefined`
 * key clobbering an earlier one). Since local state is always a complete, validated
 * `AppSettings`, sending it as the patch is both simpler and exactly equivalent -
 * `AppSettings` is assignable to `DeepPartial<AppSettings>`.
 *
 * STALE-RESPONSE HANDLING
 * -----------------------
 * Responses are matched against a sequence number and are ignored when a newer write
 * has started, or when the user has typed again since. Without that, a slow response
 * carrying a now-outdated value would yank the field back under the user's cursor.
 */
export function useSettingsController(api: PoeToolApi): SettingsController {
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  /**
   * Mirror of `settings` that is updated SYNCHRONOUSLY inside the change handlers.
   * `commit()` has to flush in the same tick it edits, and React state is not readable
   * that early; this ref is the value the flush actually sends.
   */
  const settingsRef = useRef<AppSettings | null>(null)
  const dirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const saveSeqRef = useRef(0)

  // --- initial load / reload ------------------------------------------------

  useEffect(() => {
    let active = true
    setLoading(true)

    void api.getSettings().then(
      (loaded) => {
        if (!active) return
        settingsRef.current = loaded
        dirtyRef.current = false
        setSettingsState(loaded)
        setLoadError(null)
        setLoading(false)
      },
      (error: unknown) => {
        if (!active) return
        setLoadError(describeError(error))
        setLoading(false)
      }
    )

    return () => {
      active = false
    }
  }, [api, reloadToken])

  // --- writing --------------------------------------------------------------

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!dirtyRef.current) return

    const pending = settingsRef.current
    if (pending === null) return

    dirtyRef.current = false
    saveSeqRef.current += 1
    const seq = saveSeqRef.current
    setSaving(true)

    void api.setSettings(pending).then(
      (persisted) => {
        if (seq !== saveSeqRef.current) return
        setSaving(false)
        setSaveError(null)
        // Adopt main's answer only when the user has not typed since. `sameSettings`
        // keeps the common case (identical result) from re-rendering every section.
        if (!dirtyRef.current && !sameSettings(settingsRef.current, persisted)) {
          settingsRef.current = persisted
          setSettingsState(persisted)
        }
      },
      (error: unknown) => {
        if (seq !== saveSeqRef.current) return
        setSaving(false)
        setSaveError(describeError(error))
      }
    )
  }, [api])

  const schedule = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      flush()
    }, SETTINGS_DEBOUNCE_MS)
  }, [flush])

  /** Applies `patch` locally. Returns true when it actually changed something. */
  const applyLocal = useCallback((patch: DeepPartial<AppSettings>): boolean => {
    const current = settingsRef.current
    if (current === null) return false

    const next = applySettingsPatch(current, patch)
    if (sameSettings(current, next)) return false

    settingsRef.current = next
    setSettingsState(next)
    dirtyRef.current = true
    return true
  }, [])

  const update = useCallback(
    (patch: DeepPartial<AppSettings>): void => {
      if (applyLocal(patch)) schedule()
    },
    [applyLocal, schedule]
  )

  const commit = useCallback(
    (patch: DeepPartial<AppSettings>): void => {
      applyLocal(patch)
      // Flush unconditionally: even a no-op patch should push out an edit that is
      // still sitting in the debounce window.
      flush()
    },
    [applyLocal, flush]
  )

  const reload = useCallback((): void => {
    dirtyRef.current = false
    setReloadToken((token) => token + 1)
  }, [])

  /**
   * Best-effort save when the window goes away.
   *
   * `flush` is stable (it only closes over `api` and refs), which matters: an unstable
   * identity would re-run this effect on every render and cancel the pending debounce
   * timer mid-typing, so edits would never be written.
   *
   * This is genuinely best-effort - `settings:set` is asynchronous and the window may
   * be destroyed before it lands. That is why every click-driven control uses
   * `commit()` rather than `update()`: only free-text typing is ever at risk, and only
   * within the last 350ms.
   */
  useEffect(() => {
    const onPageHide = (): void => {
      flush()
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [flush])

  return { settings, loading, loadError, saveError, saving, update, commit, flush, reload }
}
