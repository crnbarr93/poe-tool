/**
 * src/renderer/src/components/ObsSection.tsx
 * ==========================================
 *
 * obs-websocket connection settings, a one-shot connection test, and the live
 * connection badge.
 *
 * WHY THE TEST BUTTON SHOWS A RESULT INSTEAD OF THROWING
 * -----------------------------------------------------
 * `obs:test` resolves with a result union (`ObsTestResult`) rather than rejecting,
 * because a wrong password is the expected outcome of pressing "Test connection", not
 * an exception. The failure branch therefore renders main's human-readable `error`
 * verbatim - "Authentication failed", "connect ECONNREFUSED 127.0.0.1:4455" - which is
 * the difference between a user fixing it in ten seconds and filing a bug.
 *
 * THE REPLAY BUFFER WARNING IS THE POINT OF THIS SECTION
 * -----------------------------------------------------
 * A perfectly healthy connection still saves nothing if the replay buffer is not
 * running in OBS. That is the single most common way this app appears broken, so
 * `replayBufferActive === false` gets a loud inline warning next to the badge.
 */

import type { ReactElement } from 'react'
import { useState } from 'react'

import type { ObsConnectionState, ObsTestResult, PoeToolApi } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { PORT_MAX, PORT_MIN } from '../../../shared/settings'
import { describeError, formatEpochClock } from '../format'
import { useObsStatus } from '../hooks'
import { NumberField, TextField, ToggleField } from './Fields'
import { Panel } from './Panel'
import type { BadgeDescriptor } from './StatusBadge'
import { StatusBadge } from './StatusBadge'

function describeObs(status: ObsConnectionState | null): BadgeDescriptor {
  if (status === null) return { tone: 'idle', label: 'Connecting', detail: 'asking main…' }

  switch (status.state) {
    case 'disconnected':
      return { tone: 'idle', label: 'Disconnected', detail: `since ${formatEpochClock(status.since)}` }
    case 'connecting':
      return {
        tone: 'info',
        label: 'Connecting',
        detail: `${status.host}:${status.port} · attempt ${status.attempt}`
      }
    case 'connected':
      return {
        tone: 'ok',
        label: 'Connected',
        detail: `${status.host}:${status.port} · OBS ${status.obsVersion} · websocket ${status.websocketVersion}`
      }
    case 'error':
      return {
        tone: 'bad',
        label: 'Error',
        detail: status.willRetry ? `${status.message} (retrying)` : status.message
      }
  }
}

/** The replay-buffer warning, or null when there is nothing to say. */
function ReplayBufferNotice({ status }: { readonly status: ObsConnectionState | null }): ReactElement | null {
  if (status === null || status.state !== 'connected') return null

  if (status.replayBufferActive === false) {
    return (
      <p className="notice notice--bad">
        OBS is connected but its <strong>replay buffer is not running</strong>. Start it in OBS
        (Controls → Start Replay Buffer) or every clip request will fail.
      </p>
    )
  }
  if (status.replayBufferActive === null) {
    return (
      <p className="notice notice--warn">
        Replay buffer state unknown — poe-tool has not been able to ask OBS yet.
      </p>
    )
  }
  return <p className="notice notice--ok">Replay buffer is running. Clips can be saved.</p>
}

export interface ObsSectionProps {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function ObsSection({
  api,
  settings,
  update,
  commit,
  flush
}: ObsSectionProps): ReactElement {
  const status = useObsStatus(api)
  const badge = describeObs(status)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ObsTestResult | null>(null)
  const [testCrash, setTestCrash] = useState<string | null>(null)

  const runTest = (): void => {
    // Persist first: testing credentials the user can see but that were never saved
    // would be a confusing kind of lie the moment they close the window.
    flush()

    setTesting(true)
    setTestResult(null)
    setTestCrash(null)

    void api
      .testObs({
        host: settings.obs.host,
        port: settings.obs.port,
        password: settings.obs.password
      })
      .then(
        (result) => {
          setTesting(false)
          setTestResult(result)
        },
        (error: unknown) => {
          // `obs:test` is contracted never to reject; this branch means the IPC call
          // itself broke, which is worth showing rather than swallowing.
          setTesting(false)
          setTestCrash(describeError(error))
        }
      )
  }

  return (
    <Panel
      title="OBS"
      description="poe-tool asks OBS to save its replay buffer. OBS does the recording; nothing here touches the game."
      aside={<StatusBadge {...badge} srPrefix="OBS" />}
    >
      <ReplayBufferNotice status={status} />

      <div className="grid grid--obs">
        <TextField
          label="Host"
          value={settings.obs.host}
          placeholder="127.0.0.1"
          hint="127.0.0.1 when OBS runs on this PC."
          onChange={(next) => {
            update({ obs: { host: next } })
          }}
          onCommit={flush}
        />
        <NumberField
          label="Port"
          value={settings.obs.port}
          min={PORT_MIN}
          max={PORT_MAX}
          hint="4455 is the obs-websocket v5 default."
          onChange={(next) => {
            update({ obs: { port: next } })
          }}
          onCommit={flush}
        />
        <TextField
          label="Password"
          value={settings.obs.password}
          kind="password"
          hint="From OBS → Tools → WebSocket Server Settings. Leave empty if authentication is off."
          onChange={(next) => {
            update({ obs: { password: next } })
          }}
          onCommit={flush}
        />
      </div>

      <ToggleField
        label="Connect to OBS automatically on launch"
        checked={settings.obs.autoConnect}
        hint="Keeps retrying in the background, so OBS can be started before or after poe-tool."
        onChange={(next) => {
          commit({ obs: { autoConnect: next } })
        }}
      />

      <div className="row">
        <button className="btn btn-secondary" type="button" onClick={runTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <span className="row__note">Connects once, reads the version, disconnects again.</span>
      </div>

      {testCrash !== null && <p className="notice notice--bad">Test could not run: {testCrash}</p>}

      {testResult !== null && testResult.ok && (
        <p className="notice notice--ok">
          Connected to OBS {testResult.obsVersion} (obs-websocket {testResult.websocketVersion}).
        </p>
      )}

      {testResult !== null && !testResult.ok && (
        <p className="notice notice--bad">Could not connect: {testResult.error}</p>
      )}
    </Panel>
  )
}
