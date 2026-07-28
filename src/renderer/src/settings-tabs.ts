/**
 * src/renderer/src/settings-tabs.ts
 * =================================
 *
 * The Settings view's tab list, lifted out of the view itself.
 *
 * WHY THIS IS NOT JUST A CONST INSIDE `views/SettingsView.tsx`
 * -----------------------------------------------------------
 * Three things outside that view now need to NAME a tab:
 *
 *  - the shell owns which tab is selected, so that a fault banner or an empty state can
 *    deep-link into the one panel that fixes it (see `App.tsx`);
 *  - `readiness.ts` attaches a destination to every live fault it reports, and it is a
 *    pure module with no JSX, so it cannot import a `.tsx` view without dragging React
 *    into `test/readiness.test.ts`;
 *  - the Activity view's "Set Client.txt path" button has to land on Log source rather
 *    than on whatever tab happened to be open last.
 *
 * Keeping the ids here means the compiler is the thing that stops a deep-link pointing at
 * a tab that does not exist, rather than a click that silently does nothing.
 */

/** The settings destinations, in rail order. */
export type SettingsTabId =
  | 'log'
  | 'character'
  | 'obs'
  | 'streamable'
  | 'area-timers'
  | 'overlay'
  | 'notifications'
  | 'logout-macro'

export interface SettingsTab {
  readonly id: SettingsTabId
  readonly label: string
  /**
   * The panel behind this tab is a coming-soon state rather than a feature. Drives the
   * "Soon" chip only - the entry stays selectable, because the panel is where the user
   * finds out that the feature does not exist yet.
   */
  readonly soon: boolean
}

/**
 * Rail order: the four wired tabs first, in the order a user actually has to do them
 * (point at a log, say who you are, connect OBS, then optionally upload), then the four
 * unbuilt ones. The design lists Area timers before Overlay and Notifications; Streamable
 * is inserted after OBS because uploading is something that happens TO a clip.
 */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: 'log', label: 'Log source', soon: false },
  { id: 'character', label: 'Character', soon: false },
  { id: 'obs', label: 'OBS & clips', soon: false },
  { id: 'streamable', label: 'Streamable', soon: false },
  { id: 'area-timers', label: 'Area timers', soon: true },
  { id: 'overlay', label: 'Overlay', soon: true },
  { id: 'notifications', label: 'Notifications', soon: true },
  { id: 'logout-macro', label: 'Logout macro', soon: true }
]
