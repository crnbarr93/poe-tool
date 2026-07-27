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

import type { PoeEvent, WatcherStatus } from '../../shared/events'
import type { ClipRecord, ObsConnectionState, PoeToolApi } from '../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../shared/settings'
import { applySettingsPatch } from '../../shared/settings'
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

/** OBS writes one file per save, so the source path plus the save time is unique. */
function clipIdentity(clip: ClipRecord): string {
  return `${clip.savedAt}|${clip.originalPath}`
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

/** The last `limit` clips, newest first. `clips:recent` is already newest-first. */
export function useClipFeed(api: PoeToolApi, limit: number): readonly FeedItem<ClipRecord>[] {
  const [items, setItems] = useState<readonly FeedItem<ClipRecord>[]>([])

  useEffect(() => {
    let active = true

    const unsubscribe = api.onClip((clip) => {
      if (!active) return
      setItems((prev) => mergeFeed(prev, [clip], clipIdentity, 'c', limit, 'newer'))
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
      unsubscribe()
    }
  }, [api, limit])

  return items
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

/** Field-by-field equality. `AppSettings` is a fixed, flat, primitive-only shape. */
function sameSettings(a: AppSettings | null, b: AppSettings): boolean {
  if (a === null) return false
  return (
    a.log.path === b.log.path &&
    a.log.pollIntervalMs === b.log.pollIntervalMs &&
    a.character.name === b.character.name &&
    a.obs.host === b.obs.host &&
    a.obs.port === b.obs.port &&
    a.obs.password === b.obs.password &&
    a.obs.autoConnect === b.obs.autoConnect &&
    a.clips.enabled === b.clips.enabled &&
    a.clips.libraryDir === b.clips.libraryDir &&
    a.clips.debounceMs === b.clips.debounceMs &&
    a.clips.writeSidecar === b.clips.writeSidecar
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
