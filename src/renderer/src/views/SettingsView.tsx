/**
 * src/renderer/src/views/SettingsView.tsx
 * =======================================
 *
 * The Settings view: a sticky tab rail on the left, one panel at a time on the right.
 *
 * The four wired tabs (Log source, Character, OBS & clips, Streamable) are the existing,
 * working sections, re-homed into the design's panel shell. Nothing about what they DO
 * changed here - same fields, same validation bounds, same debounce, same warnings, same
 * labels. This file only decides which one is on screen.
 *
 *
 * "STREAMABLE" IS NOT IN THE DESIGN, AND HAS TO BE
 * ------------------------------------------------
 * The design predates automatic clip upload. Leaving the tab out would leave a shipped
 * feature - one that takes a real account password - with no way to configure it, and
 * worse, with no way to READ the warnings that section exists to carry: the endpoint is
 * undocumented and unsupported, the credential is the account password rather than a
 * revocable token, and free Streamable accounts delete videos after 90 days. Those are the
 * whole point of the section, so it gets a tab.
 *
 *
 * FOUR TABS DESCRIBE FEATURES THAT DO NOT EXIST
 * ---------------------------------------------
 * Area timers, Overlay, Notifications and Logout macro are all unbuilt. Every one of them
 * renders {@link ComingSoon} - no controls, not even disabled ones, and no values. A
 * settings screen is exactly where a user goes to check whether a protection is switched
 * on, so a panel here that looked configurable would be read as configured. The logout
 * macro is the one that matters most: a player who believes a macro will disconnect them
 * takes the fight.
 *
 * The tabs are still LISTED and still reachable, which is the deliberate reading of
 * "disable rather than hide" that {@link App}'s nav also takes: what is disabled is the
 * FEATURE, and the entry has to stay walkable or the panel explaining it is unreachable.
 * The "Soon" chip is what stops the entry from looking like working chrome.
 *
 *
 * IT IS A REAL TAB WIDGET
 * -----------------------
 * `role="tablist"` / `role="tab"` / `role="tabpanel"` with a roving tabindex: one Tab
 * press reaches the rail, arrow keys walk it, Home/End jump to the ends. Eight buttons
 * that each grabbed their own tab stop would put seven presses between the user and the
 * form they are trying to fill in.
 *
 *
 * THE SELECTION IS THE SHELL'S, NOT THIS VIEW'S
 * ---------------------------------------------
 * `tab` / `onSelectTab` are controlled props rather than internal state, because things
 * OUTSIDE this view have to be able to send the user to a particular panel: the fault
 * banners above the content ("OBS replay buffer is not running" -> OBS & clips; "Nothing
 * will be clipped" -> Character), and the Activity view's empty state -> Log source. Held
 * internally, every one of those would arrive on whatever tab was open last and leave the
 * user to hunt for the fix, which is exactly the dead end the banners exist to end. The
 * rail's own arrow-key handling is unchanged; it just reports upwards.
 */

import type { KeyboardEvent, ReactElement } from 'react'
import { useId, useRef } from 'react'

import type { PoeToolApi } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { CharacterSection } from '../components/CharacterSection'
import { ClipSettingsSection } from '../components/ClipSettingsSection'
import { ComingSoon } from '../components/ComingSoon'
import { LogSourceSection } from '../components/LogSourceSection'
import { ObsSection } from '../components/ObsSection'
import { StreamableSection } from '../components/StreamableSection'
import { SETTINGS_TABS } from '../settings-tabs'
import type { SettingsTabId } from '../settings-tabs'

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** What every settings-editing section needs, threaded through from the shell. */
export interface SettingsPlumbing {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export interface SettingsViewProps extends SettingsPlumbing {
  /** The selected tab. Owned by the shell - see the header. */
  readonly tab: SettingsTabId
  readonly onSelectTab: (tab: SettingsTabId) => void
}

/**
 * The panel for one tab.
 *
 * Exhaustive over {@link SettingsTabId} with no `default`, so adding a tab to the rail
 * without giving it a panel is a compile error rather than an empty column.
 */
function SettingsPanel({
  tab,
  api,
  settings,
  update,
  commit,
  flush
}: SettingsPlumbing & { readonly tab: SettingsTabId }): ReactElement {
  switch (tab) {
    case 'log':
      return (
        <LogSourceSection
          api={api}
          settings={settings}
          update={update}
          commit={commit}
          flush={flush}
        />
      )

    case 'character':
      return (
        <CharacterSection
          api={api}
          settings={settings}
          update={update}
          commit={commit}
          flush={flush}
        />
      )

    case 'obs':
      // Two panels, one tab: the connection and what is done with it. They are separated
      // because a healthy connection with clipping switched off is a real and confusing
      // state, and one card saying both things at once hides it.
      return (
        <>
          <ObsSection
            api={api}
            settings={settings}
            update={update}
            commit={commit}
            flush={flush}
          />
          <ClipSettingsSection
            api={api}
            settings={settings}
            update={update}
            commit={commit}
            flush={flush}
          />
        </>
      )

    case 'streamable':
      return (
        <StreamableSection
          api={api}
          settings={settings}
          update={update}
          commit={commit}
          flush={flush}
        />
      )

    case 'area-timers':
      return (
        <ComingSoon
          title="Area timers"
          description="How long each area took, measured from the log poe-tool already reads. Today it knows which area you are in and when you entered it; it does not yet keep the durations, which is why the Activity view shows an em-dash for average map time instead of a number."
          bullets={[
            'Time spent in the current area, and the time each finished area took',
            'Averages across the session, split so that town and hideout time does not flatter your map times',
            'A per-area record on each death, so a clip can say how far into the map it happened',
            'Nothing new is read: the same zone and area lines already in the event feed'
          ]}
        />
      )

    case 'overlay':
      return (
        <ComingSoon
          title="Overlay"
          description="Settings for the always-on-top layer over the game window — where it sits, what it shows, and how to get rid of it. There is no overlay yet, so there is nothing here to configure."
          bullets={[
            'Which monitor and corner it sits in, and how transparent it is',
            'Whether it is click-through, so it can never swallow a click meant for the game',
            'Which of the area timer, the last death and the clip confirmation it shows',
            'A key to hide it outright — and the overlay stays a separate always-on-top window that draws over the game, never anything injected into it'
          ]}
        />
      )

    case 'notifications':
      return (
        <ComingSoon
          title="Notifications"
          description="Whether poe-tool says anything when something happens — a clip saved, an upload finished, OBS dropping its connection mid-session. Today it says nothing at all: the only place any of that is reported is this window."
          bullets={[
            'A brief on-screen confirmation when a clip is saved, so you know it worked without alt-tabbing',
            'A warning when OBS disconnects or its replay buffer stops, which is the one failure that silently costs you clips',
            'The upload result, once Streamable has finished with a clip',
            'Per-event switches, because a toast during a boss fight is worse than no toast at all'
          ]}
        />
      )

    case 'logout-macro':
      return (
        <ComingSoon
          title="Logout macro"
          description="A hotkey that will drop the game's connection so your character leaves the instance at once, instead of standing there for the log-out timer. It does not exist yet: nothing in poe-tool currently closes a connection, and no hotkey is registered."
          bullets={[
            'A key you choose, closing the TCP connection the game client already has open, from outside the game',
            'A clear armed/not-armed state, so it is never ambiguous whether you are covered',
            'It will never send input to the game, read its memory, or automate play — the same rule the rest of poe-tool follows',
            'Until it ships, assume you have no logout protection at all'
          ]}
        />
      )
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function SettingsView({
  api,
  settings,
  update,
  commit,
  flush,
  tab: active,
  onSelectTab
}: SettingsViewProps): ReactElement {
  const baseId = useId()

  /**
   * One entry per tab button, so the arrow keys can move focus as well as selection.
   * A tab widget that changed the selection without moving focus would leave the user's
   * focus on a tab that is no longer the selected one.
   */
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selectAt = (index: number): void => {
    const count = SETTINGS_TABS.length
    // Wraps in both directions - `%` alone gives a negative index going up from the first.
    const wrapped = ((index % count) + count) % count
    const tab = SETTINGS_TABS[wrapped]
    if (tab === undefined) return
    onSelectTab(tab.id)
    tabRefs.current[wrapped]?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      // Both axes: the rail is vertical, but it wraps to a horizontal row on a narrow
      // window and the keys should not change meaning underneath the user.
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault()
        selectAt(index + 1)
        return
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault()
        selectAt(index - 1)
        return
      case 'Home':
        event.preventDefault()
        selectAt(0)
        return
      case 'End':
        event.preventDefault()
        selectAt(SETTINGS_TABS.length - 1)
        return
      default:
        return
    }
  }

  return (
    <div className="settings">
      <div
        className="settings__rail"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
      >
        {SETTINGS_TABS.map((tab, index) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              className={selected ? 'settings__tab settings__tab--on' : 'settings__tab'}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              // Every tab points at the SAME panel element, because there is only one:
              // the panel's contents are swapped rather than eight panels being shown and
              // hidden. A per-tab id would leave seven `aria-controls` dangling at
              // elements that are not in the document.
              aria-controls={`${baseId}-panel`}
              // Roving tabindex: the rail is one tab stop, not eight.
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onSelectTab(tab.id)
              }}
              onKeyDown={(event) => {
                onTabKeyDown(event, index)
              }}
            >
              <span className="settings__tab-label">{tab.label}</span>
              {tab.soon && <span className="settings__tab-soon">Soon</span>}
            </button>
          )
        })}
      </div>

      <div className="settings__content">
        {/*
          Focusable on purpose. The coming-soon panels contain no controls at all - that is
          the rule the component is built on - so without a tabindex here a keyboard user
          arrowing onto "Logout macro" would have no way to reach the paragraph explaining
          that the feature does not exist.
        */}
        <div
          className="settings__panels"
          role="tabpanel"
          id={`${baseId}-panel`}
          // Named by whichever tab is currently selected, so the panel announces itself as
          // "Character" or "Streamable" rather than as an unlabelled region.
          aria-labelledby={`${baseId}-tab-${active}`}
          tabIndex={0}
        >
          <SettingsPanel
            tab={active}
            api={api}
            settings={settings}
            update={update}
            commit={commit}
            flush={flush}
          />
        </div>

        {/*
          True on every tab, which is why it sits outside the panel: this app reads one log
          file and does nothing else to the game.
        */}
        <p className="card-meta">
          poe-tool never reads game memory, never injects anything, and never sends input to
          the game. It reads one log file.
        </p>
      </div>
    </div>
  )
}
