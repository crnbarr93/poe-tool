/**
 * src/renderer/src/App.tsx
 * ========================
 *
 * The app shell: a fixed sidebar, a header, and a content area that swaps between three
 * views. No router library - the frozen dependency set has no room for one, and three
 * mutually exclusive views are a `useState` and a `switch`.
 *
 * THIS WINDOW IS OPTIONAL
 * -----------------------
 * Tailing, parsing, clipping and uploading all live in the main process and keep running
 * with zero windows open. Nothing here is on the critical path, which is exactly why the
 * failure modes below are allowed to be as blunt as they are: if the preload bridge is
 * missing or `settings:get` fails, the honest thing is to say so and stop, rather than to
 * render a plausible-looking form that silently saves nothing.
 *
 *
 * WHAT IS REAL AND WHAT IS NOT
 * ----------------------------
 * The layout comes from a Claude Design project that draws several features this build
 * does NOT have: a logout macro, an in-game overlay, area timers, overlay notifications.
 * Every one of those renders through {@link ComingSoon} - a calm, clearly-labelled state
 * that names what the feature will do and shows no controls and no values. The reason is
 * specific rather than stylistic: a sidebar card reading "Armed - TCP kill" beside a
 * hotkey would tell a player they have a protection they do not have, and they would take
 * a fight on the strength of it. Nothing in this window may assert a capability the app
 * does not possess.
 *
 * Everything else on screen is wired to live data: the readiness pill counts four real
 * booleans, the version comes over IPC from `app.getVersion()`, and the sections in the
 * views below are the existing, working ones.
 *
 *
 * THE SHELL IS WHERE THE ALARMS LIVE, NOT THE TAB THAT OWNS THEM
 * -------------------------------------------------------------
 * Three states cost the user every clip while looking exactly like a working app: the
 * replay buffer stopped, Client.txt gone, and no character resolved. Each has a full
 * explanation inside the settings section that owns it - and each of those sections is two
 * navigations from the view this window opens on. So the faults are computed here, from
 * the same live values the pill counts (`./readiness.ts`), and rendered above the content
 * on EVERY view with a button that goes to the tab that fixes them. That is also why this
 * component, rather than `SettingsView`, owns which settings tab is selected.
 *
 * The same reasoning moved `useDetectionSwap` up here: it diffs two consecutive
 * `character:active` values seen while it is MOUNTED, and mounting it inside
 * `CharacterSection` meant a mule's level-up that landed while the user was on Activity -
 * the default view - was silently never noticed. See `components/DetectionSwapNotice.tsx`.
 *
 *
 * WHERE THE THREE VIEWS LIVE
 * --------------------------
 * All three are in `./views/`, and the shell does nothing but choose between them:
 *  - `ActivityView`  - the stat strip, the events table and the clip grid, on live feeds;
 *  - `OverlayView`   - a coming-soon state, because there is no overlay;
 *  - `SettingsView`  - the designed sticky tab rail, one panel per tab, including the
 *    coming-soon tabs for area timers / overlay / notifications / logout macro.
 */

import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'

import type { PoeToolApi } from '../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../shared/settings'
import { ComingSoon } from './components/ComingSoon'
import { DetectionSwapNotice } from './components/DetectionSwapNotice'
import { ShellAlerts } from './components/ShellAlerts'
import { StatusPill } from './components/StatusPill'
import { UpdateStatus } from './components/UpdateStatus'
import { computeReadiness, shellFaults } from './readiness'
import type { ReadinessInput } from './readiness'
import type { SettingsTabId } from './settings-tabs'
import { ActivityView } from './views/ActivityView'
import { OverlayView } from './views/OverlayView'
import { SettingsView } from './views/SettingsView'
import {
  getBridge,
  useActiveCharacter,
  useAppVersion,
  useDetectionSwap,
  useObsStatus,
  useSessionStats,
  useSettingsController,
  useWatcherStatus
} from './hooks'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The three top-level destinations. Exported so the views can type their own props. */
export type ViewId = 'activity' | 'overlay' | 'settings'

interface ViewMeta {
  readonly title: string
  readonly subtitle: string
}

/** Header copy, straight from the design. One entry per {@link ViewId}, exhaustively. */
const VIEW_META: Record<ViewId, ViewMeta> = {
  activity: { title: 'Activity', subtitle: 'Deaths, areas and clips from this session' },
  overlay: { title: 'Overlay', subtitle: 'What sits on top of the game' },
  settings: { title: 'Settings', subtitle: 'Capture keeps running while this is open' }
}

interface NavItem {
  readonly id: ViewId
  readonly label: string
  /**
   * The destination is a coming-soon state rather than a feature.
   *
   * The entry is still rendered and still reachable, and that is a deliberate reading of
   * "disable rather than hide": what is disabled is the FEATURE, and the signpost has to
   * stay walkable or the panel explaining what the feature will do is unreachable. The
   * "Soon" chip is what stops it from looking like working chrome.
   */
  readonly soon: boolean
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'activity', label: 'Activity', soon: false },
  { id: 'overlay', label: 'Overlay', soon: true },
  { id: 'settings', label: 'Settings', soon: false }
]

/**
 * The 15px nav glyphs, inline rather than from an icon package - there are three of them
 * and the dependency set is frozen. Paths are the design's, verbatim.
 */
function NavIcon({ view }: { readonly view: ViewId }): ReactElement {
  const common = {
    className: 'nav__icon',
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }

  switch (view) {
    case 'activity':
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      )
    case 'overlay':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <rect x="13" y="7" width="5" height="5" rx="1" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 3.5v2.2M12 18.3v2.2M4.6 7.8l1.9 1.1M17.5 15.1l1.9 1.1M4.6 16.2l1.9-1.1M17.5 8.9l1.9-1.1" />
        </svg>
      )
  }
}

// ---------------------------------------------------------------------------
// Failure screens
// ---------------------------------------------------------------------------

/**
 * Shown when `window.poeTool` is absent, i.e. the preload script did not run.
 *
 * Nothing in the UI can work in that state, and every component would otherwise fail
 * with `Cannot read properties of undefined`, leaving a blank window and a console
 * message the user will never see.
 */
function BridgeUnavailable(): ReactElement {
  return (
    <div className="app--fatal">
      <div className="fatal">
        <h1 className="fatal__title">Bridge not available</h1>
        <p>
          The preload script did not load, so this window cannot talk to the background
          process. Capturing may still be running — this is a problem with the config window
          only.
        </p>
        <p className="fatal__hint">Restart poe-tool; if it persists the app build is incomplete.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** What every settings-editing section needs. Threaded straight through the views. */
interface SectionPlumbing {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

// The activity view lives in `./views/ActivityView.tsx`. It owns its own feeds (events,
// clips, the resolved character) and needs none of the settings plumbing above: the clip
// SETTINGS moved to the Settings view's "OBS & clips" tab, and what is left here is a
// report on what happened, not a form.

// The overlay view lives in `./views/OverlayView.tsx` - there is no overlay in this
// build, and the whole view is a coming-soon state. Its file header explains why none of
// the design's screenshot, layout grid, toasts or hotkey pill may be reproduced here.

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

interface ConfigAppProps {
  readonly api: PoeToolApi
}

function ConfigApp({ api }: ConfigAppProps): ReactElement {
  const { settings, loading, loadError, saveError, saving, update, commit, flush, reload } =
    useSettingsController(api)

  const [view, setView] = useState<ViewId>('activity')

  /*
   * WHICH SETTINGS TAB IS SELECTED IS THE SHELL'S, not `SettingsView`'s.
   *
   * Three places outside that view need to send the user to a specific panel: the Activity
   * empty state ("Set Client.txt path"), and each fault banner's button. Left as internal
   * state, every one of those would land on whatever tab happened to be open and the user
   * would have to find the fix themselves - which is the situation the banners exist to
   * end.
   */
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('log')

  /** Go to the one panel that fixes a thing. Stable, so the views can hold onto it. */
  const openSettings = useCallback((tab: SettingsTabId): void => {
    setSettingsTab(tab)
    setView('settings')
  }, [])

  // The four live sources the readiness pill counts. All are subscribe-then-fetch hooks
  // that cost one listener each; the sections below subscribe independently, which is
  // fine - main fans out to every listener and nothing here is on the critical path.
  const version = useAppVersion(api)
  const watcher = useWatcherStatus(api)
  const obs = useObsStatus(api)
  const character = useActiveCharacter(api)

  /*
   * Mounted HERE, for the life of the window, and not inside `CharacterSection`.
   *
   * The reducer behind it diffs two consecutive resolved characters; it can only report a
   * swap it was mounted to see. Inside a settings tab that meant the one failure it exists
   * for - a mule's level-up quietly displacing the character being played - went
   * unreported whenever the user was not sitting on that exact tab, which is nearly always.
   */
  const detectionSwap = useDetectionSwap(character)

  /*
   * This session's counters, held HERE rather than inside the Activity view so that the
   * subscription survives a trip to Settings and back - `push:stats` only fires when a
   * counter moves, so a view that resubscribed on every mount would sit at whatever the
   * `stats:session` fetch happened to return and look frozen until the next death.
   *
   * `null` means "not arrived, or could not be read", and the view renders em-dashes for
   * it. It never renders zeros: `0` is a claim, not an absence.
   */
  const stats = useSessionStats(api)

  if (settings === null) {
    return (
      <div className="app--fatal">
        <div className="fatal">
          {loadError === null ? (
            <>
              <h1 className="fatal__title">Loading configuration…</h1>
              {!loading && <p>Waiting for the background process to answer.</p>}
            </>
          ) : (
            <>
              <h1 className="fatal__title">Could not read your settings</h1>
              <p className="mono">{loadError}</p>
              <button className="btn btn-primary" type="button" onClick={reload}>
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const meta = VIEW_META[view]
  const plumbing: SectionPlumbing = { api, settings, update, commit, flush }

  /*
   * One input, two answers: the pill's count and the fault banners. Both come from
   * `./readiness.ts` so the header and the banners can never disagree - the pill saying
   * "4 / 4" while a banner says the replay buffer is stopped would be worse than either
   * alone.
   */
  const readinessInput: ReadinessInput = {
    watcher,
    obs,
    clipsEnabled: settings.clips.enabled,
    character
  }
  const readiness = computeReadiness(readinessInput)
  const faults = shellFaults(readinessInput)

  const swap = detectionSwap.swap

  return (
    <div className="shell">
      <aside className="aside">
        <div className="brand">
          <h1 className="brand__name">poe-tool</h1>
          {/*
            The REAL version, over IPC from `app.getVersion()`. Rendered only once it is
            known: a hardcoded or placeholder version sends a bug report to the wrong
            release. See `useAppVersion`.
          */}
          {version !== null && <p className="brand__version">v{version}</p>}
        </div>

        {/*
          Radio inputs rather than buttons, matching the design's segmented control - and
          arrow keys walk the group for free, which a row of buttons would not give.
        */}
        <nav className="nav" aria-label="Views">
          {NAV_ITEMS.map((item) => (
            <label className="seg-opt" key={item.id}>
              <input
                type="radio"
                name="poe-tool-view"
                value={item.id}
                checked={view === item.id}
                onChange={() => {
                  setView(item.id)
                }}
              />
              <NavIcon view={item.id} />
              <span className="nav__label">{item.label}</span>
              {item.soon && <span className="nav__soon">Soon</span>}
            </label>
          ))}
        </nav>

        <div className="aside__foot">
          {/*
            The design puts a live logout-macro card here: a hotkey in the accent colour
            and an "Armed" status line. THAT FEATURE DOES NOT EXIST, and of everything in
            this window it is the one whose fake version could actually get a character
            killed - a player who believes a macro will disconnect them takes the fight.
            So it is a coming-soon card with no hotkey and no status.
          */}
          <ComingSoon
            compact
            kicker="Logout macro"
            title="Instant logout"
            description="A hotkey that will drop the game's connection so your character leaves the instance at once, instead of standing there for the log-out timer."
          />

          {/*
            Not in the design, and not optional: "your edit did not save" is exactly the
            kind of silent failure this app refuses to ship. Pinned to the rail so it is
            never scrolled out of view.
          */}
          <p className="save" role="status">
            {saveError !== null ? (
              <span className="save--bad">Not saved: {saveError}</span>
            ) : saving ? (
              <span className="save--busy">Saving…</span>
            ) : (
              <span>Changes save automatically</span>
            )}
          </p>

          {/*
            The auto-update line. Renders NOTHING in the steady state - see UpdateStatus.tsx
            - so the rail's foot is normally just the card and the save line.
          */}
          <UpdateStatus api={api} />
        </div>
      </aside>

      <main className="main">
        <header className="view-head">
          <div>
            <h2 className="view-head__title">{meta.title}</h2>
            <p className="view-head__subtitle">{meta.subtitle}</p>
          </div>
          {/*
            Four real checks, counted honestly - never a hardcoded "4 / 4", and never
            "connected" standing in for "will actually save a clip". The rule is in
            ./readiness.ts, where it is unit-tested.
          */}
          <StatusPill readiness={readiness} />
        </header>

        {/*
          Above the scroll area on purpose: a user scrolled to the bottom of the events
          table while their replay buffer is stopped must still be able to see that no
          clip is being saved. Renders nothing at all when there is no fault.
        */}
        <ShellAlerts faults={faults} onOpenSettings={openSettings} />

        {swap !== null && (
          <div className="alerts">
            <DetectionSwapNotice
              swap={swap}
              // Writes the OVERRIDE, exactly as the picker in CharacterSection does: the
              // user correcting the app is a manual choice, and only a manual choice can
              // out-rank the next level-up that mule happens to get.
              onUsePrevious={() => {
                commit({ character: { override: swap.fromName } })
              }}
              onDismiss={detectionSwap.dismiss}
            />
          </div>
        )}

        <div className="content">
          {view === 'activity' && (
            <ActivityView
              api={api}
              stats={stats}
              onOpenSettings={() => {
                openSettings('log')
              }}
            />
          )}
          {view === 'overlay' && <OverlayView />}
          {view === 'settings' && (
            <SettingsView {...plumbing} tab={settingsTab} onSelectTab={setSettingsTab} />
          )}
        </div>
      </main>
    </div>
  )
}

export function App(): ReactElement {
  // Not a hook, so branching on it before mounting the tree is safe: `ConfigApp` and
  // its hooks simply never mount when the bridge is missing.
  const api = getBridge()
  if (api === null) return <BridgeUnavailable />
  return <ConfigApp api={api} />
}
