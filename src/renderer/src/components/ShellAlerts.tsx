/**
 * src/renderer/src/components/ShellAlerts.tsx
 * ===========================================
 *
 * The live faults, pinned between the header and the scrolling content, on every view.
 *
 * WHY THESE ARE NOT ON THE SETTINGS TAB THAT OWNS THEM
 * ----------------------------------------------------
 * Each of the three faults `readiness.ts` reports has a section that explains it in full -
 * the replay-buffer notice inside `ObsSection`, the watcher badge inside
 * `LogSourceSection`, the "Nothing will be clipped" alarm inside `CharacterSection`. All
 * three are two navigations away from where the user actually sits, and all three describe
 * a state in which the app LOOKS like it is working: the events table scrolls, the pill is
 * lit, and not one clip will ever be saved.
 *
 * A fault is different from an unfinished setup, which is why this strip is empty almost
 * all of the time - see `shellFaults`. When it is not empty, it is because something the
 * user cannot see from here is costing them clips right now, and it carries the button
 * that goes to the fix.
 *
 * `role="alert"` per banner rather than on the strip: each one appears independently, and
 * an assertive announcement is right for a fault that lands mid-session. The button is a
 * real button, so a keyboard user reaches the fix in one press from the banner.
 */

import type { ReactElement } from 'react'

import type { SettingsTabId } from '../settings-tabs'
import type { ShellFault } from '../readiness'

export interface ShellAlertsProps {
  readonly faults: readonly ShellFault[]
  /** Switch to the Settings view AND select the tab that fixes this fault. */
  readonly onOpenSettings: (tab: SettingsTabId) => void
}

export function ShellAlerts({ faults, onOpenSettings }: ShellAlertsProps): ReactElement | null {
  // Renders NOTHING rather than an empty container: the strip has padding, and a healthy
  // app must not carry a gap where a warning would go.
  if (faults.length === 0) return null

  return (
    <div className="alerts">
      {faults.map((fault) => (
        <div
          key={fault.id}
          className={fault.tone === 'bad' ? 'alert-bar alert-bar--bad' : 'alert-bar alert-bar--warn'}
          role="alert"
        >
          <div className="alert-bar__text">
            <p className="alert-bar__title">{fault.title}</p>
            {fault.detail !== null && <p className="alert-bar__detail mono">{fault.detail}</p>}
            <p className="alert-bar__body">{fault.body}</p>
          </div>
          <button
            className="btn btn-secondary alert-bar__action"
            type="button"
            onClick={() => {
              onOpenSettings(fault.tab)
            }}
          >
            {fault.actionLabel}
          </button>
        </div>
      ))}
    </div>
  )
}
