/**
 * src/renderer/src/components/LogSourceSection.tsx
 * ================================================
 *
 * Where `Client.txt` is and how often it is polled, plus the live watcher badge.
 *
 * AUTODETECT ONLY EVER OFFERS A CHOICE. `log:autodetect` returns paths that were
 * confirmed to exist, most-likely-first, and this component lists them for the user to
 * pick. It never silently applies one - guessing wrong means tailing the wrong
 * install's log and wondering for an hour why nothing fires. It also cannot find a
 * Steam library on a second drive (see `src/main/log/default-paths.ts`), so an empty
 * result is a normal outcome and the empty state says exactly that.
 */

import type { ReactElement } from 'react'
import { useState } from 'react'

import type { WatcherStatus } from '../../../shared/events'
import type { PoeToolApi } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { POLL_INTERVAL_MS_MAX, POLL_INTERVAL_MS_MIN } from '../../../shared/settings'
import { describeError, formatBytes, formatCount, formatEpochClock } from '../format'
import { useWatcherStatus } from '../hooks'
import { NumberField, TextField } from './Fields'
import { Section } from './Section'
import type { BadgeDescriptor } from './StatusBadge'
import { StatusBadge } from './StatusBadge'

/**
 * Maps the watcher union onto a badge.
 *
 * The switch is exhaustive and the return type excludes `undefined`, so adding a sixth
 * `WatcherState` is a compile error here rather than a silently blank badge.
 */
function describeWatcher(status: WatcherStatus | null): BadgeDescriptor {
  if (status === null) return { tone: 'idle', label: 'Connecting', detail: 'asking main…' }

  switch (status.state) {
    case 'idle':
      return {
        tone: 'idle',
        label: 'Idle',
        detail: status.path === null ? 'no log path configured' : 'watcher stopped'
      }
    case 'tailing':
      return {
        tone: 'ok',
        label: 'Tailing',
        detail:
          `${formatCount(status.linesRead)} lines · ${formatBytes(status.offset)}` +
          (status.lastLineAt === null
            ? ' · no lines yet'
            : ` · last ${formatEpochClock(status.lastLineAt)}`)
      }
    case 'file-missing':
      return { tone: 'warn', label: 'File missing', detail: status.message }
    case 'rotated':
      return { tone: 'info', label: 'Rotated', detail: status.message }
    case 'read-error':
      return {
        tone: 'bad',
        label: 'Read error',
        detail: status.code === null ? status.message : `${status.code}: ${status.message}`
      }
  }
}

export interface LogSourceSectionProps {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function LogSourceSection({
  api,
  settings,
  update,
  commit,
  flush
}: LogSourceSectionProps): ReactElement {
  const status = useWatcherStatus(api)
  const badge = describeWatcher(status)

  const [candidates, setCandidates] = useState<readonly string[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  const runAutodetect = (): void => {
    setDetecting(true)
    setDetectError(null)
    void api.autodetectLogPaths().then(
      (result) => {
        setDetecting(false)
        setCandidates(result.candidates)
      },
      (error: unknown) => {
        setDetecting(false)
        setCandidates(null)
        setDetectError(describeError(error))
      }
    )
  }

  const chooseCandidate = (candidate: string): void => {
    commit({ log: { path: candidate } })
    setCandidates(null)
  }

  return (
    <Section
      index="1"
      title="Log source"
      description="poe-tool only ever READS this file. It never writes to the game, reads its memory, or sends it input."
      aside={<StatusBadge {...badge} srPrefix="Log watcher" />}
    >
      <div className="current-value">
        <span className="current-value__label">Currently watching</span>
        <span className={settings.log.path === null ? 'current-value__empty' : 'current-value__path'}>
          {settings.log.path ?? 'Nothing yet — auto-detect or paste a path below.'}
        </span>
      </div>

      <div className="row">
        <button className="button" type="button" onClick={runAutodetect} disabled={detecting}>
          {detecting ? 'Searching…' : 'Auto-detect Client.txt'}
        </button>
        <span className="row__note">Checks the usual Steam, standalone and Epic install folders.</span>
      </div>

      {detectError !== null && <p className="notice notice--bad">Auto-detect failed: {detectError}</p>}

      {candidates !== null && candidates.length === 0 && (
        <p className="notice notice--warn">
          No Client.txt found in the standard install folders. A Steam library on a second drive
          cannot be detected — open the game&apos;s install folder and paste the path to
          <span className="mono"> logs\Client.txt</span> below.
        </p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div className="candidates">
          <p className="candidates__title">
            Found {candidates.length} log file{candidates.length === 1 ? '' : 's'} — pick one:
          </p>
          <ul className="candidates__list">
            {candidates.map((candidate) => (
              <li key={candidate}>
                <button
                  className="candidate"
                  type="button"
                  onClick={() => {
                    chooseCandidate(candidate)
                  }}
                >
                  <span className="candidate__path">{candidate}</span>
                  <span className="candidate__action">
                    {candidate === settings.log.path ? 'in use' : 'use this'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid--split">
        <TextField
          label="Client.txt path"
          value={settings.log.path ?? ''}
          mono
          placeholder="C:\Program Files (x86)\Steam\steamapps\common\Path of Exile\logs\Client.txt"
          hint="Leave empty to stop watching. The watcher picks up a new path without a restart."
          onChange={(next) => {
            update({ log: { path: next } })
          }}
          onCommit={flush}
        />
        <NumberField
          label="Poll interval"
          value={settings.log.pollIntervalMs}
          min={POLL_INTERVAL_MS_MIN}
          max={POLL_INTERVAL_MS_MAX}
          unit="ms"
          hint={`How often the file is checked for new lines. ${POLL_INTERVAL_MS_MIN}–${POLL_INTERVAL_MS_MAX}; 500 is a good default. Slower means a death clip risks falling outside the replay buffer.`}
          onChange={(next) => {
            update({ log: { pollIntervalMs: next } })
          }}
          onCommit={flush}
        />
      </div>
    </Section>
  )
}
