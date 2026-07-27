/**
 * src/renderer/src/App.tsx
 * ========================
 *
 * The whole config window: one page, five sections, no router.
 *
 * THIS WINDOW IS OPTIONAL
 * -----------------------
 * Tailing, parsing and clipping all live in the main process and keep running with
 * zero windows open. Nothing here is on the critical path, which is exactly why the
 * failure modes below are allowed to be as blunt as they are: if the preload bridge is
 * missing or `settings:get` fails, the honest thing is to say so and stop, rather than
 * to render a plausible-looking form that silently saves nothing.
 */

import type { ReactElement } from 'react'

import type { PoeToolApi } from '../../shared/ipc'
import { CharacterSection } from './components/CharacterSection'
import { ClipsSection } from './components/ClipsSection'
import { EventFeedSection } from './components/EventFeedSection'
import { LogSourceSection } from './components/LogSourceSection'
import { ObsSection } from './components/ObsSection'
import { UpdateStatus } from './components/UpdateStatus'
import { getBridge, useSettingsController } from './hooks'

/**
 * Shown when `window.poeTool` is absent, i.e. the preload script did not run.
 *
 * Nothing in the UI can work in that state, and every component would otherwise fail
 * with `Cannot read properties of undefined`, leaving a blank window and a console
 * message the user will never see.
 */
function BridgeUnavailable(): ReactElement {
  return (
    <div className="app app--fatal">
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

interface ConfigAppProps {
  readonly api: PoeToolApi
}

function ConfigApp({ api }: ConfigAppProps): ReactElement {
  const { settings, loading, loadError, saveError, saving, update, commit, flush, reload } =
    useSettingsController(api)

  if (settings === null) {
    return (
      <div className="app app--fatal">
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
              <button className="button" type="button" onClick={reload}>
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">poe-tool</h1>
          <p className="app__subtitle">
            Read-only Client.txt watcher and OBS replay clipper. This window is configuration
            only — capture keeps running when it is closed.
          </p>
        </div>
        <div className="app__save" role="status">
          {saveError !== null ? (
            <span className="save save--bad">Not saved: {saveError}</span>
          ) : saving ? (
            <span className="save save--busy">Saving…</span>
          ) : (
            <span className="save save--idle">Changes save automatically</span>
          )}
        </div>
      </header>

      <main className="app__main">
        <LogSourceSection
          api={api}
          settings={settings}
          update={update}
          commit={commit}
          flush={flush}
        />
        <CharacterSection
          api={api}
          settings={settings}
          update={update}
          commit={commit}
          flush={flush}
        />
        <ObsSection api={api} settings={settings} update={update} commit={commit} flush={flush} />
        <ClipsSection api={api} settings={settings} update={update} commit={commit} flush={flush} />
        <EventFeedSection api={api} />
      </main>

      {/*
        The update line lives in the footer rather than in a section of its own: it is
        not something the user configures, it has no controls, and in the steady state it
        renders nothing at all. See UpdateStatus.tsx.
      */}
      <footer className="app__footer">
        <p className="app__footer-note">
          poe-tool never reads game memory, never injects anything, and never sends input to the
          game. It reads one log file.
        </p>
        <UpdateStatus api={api} />
      </footer>
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
