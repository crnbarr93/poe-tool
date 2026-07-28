/**
 * src/renderer/src/components/ClipSettingsSection.tsx
 * ===================================================
 *
 * The CONFIGURATION half of clipping: the on/off switch, where clips are filed, the
 * minimum gap between saves, and the sidecar toggle.
 *
 * WHY THE SETTINGS AND THE CLIP LIST ARE NOW TWO COMPONENTS
 * ---------------------------------------------------------
 * `ClipsSection` did both jobs because both used to be on the same scrolling page. In the
 * redesign they are in different views: the clip LIST belongs to Activity (it is the
 * record of what happened), and these four controls belong to Settings, on the "OBS &
 * clips" tab beside the connection they depend on. Splitting them is what lets each land
 * in its own place without one of them being rendered twice.
 *
 * Every control here is byte-for-byte the one it replaces - same fields, same validation
 * bounds, same hints, same `commit`-for-clicks / `update`-for-keystrokes split. Nothing
 * about clipping behaviour changed.
 *
 * THE BADGE STILL COUNTS UNFILED CLIPS
 * ------------------------------------
 * `moveClip` never deletes a clip it could not place: a failed move comes back as a
 * `ClipRecord` with `moved: false` and a note, and the file is still on disk where OBS
 * wrote it. That is not an error the user gets told about anywhere else in this tab, so
 * the badge keeps saying how many recent clips are in that state. It costs one live
 * subscription that main fans out to for free, and it is the difference between "your
 * clip is in the OBS folder" and "poe-tool lost my clip".
 */

import type { ReactElement } from 'react'

import type { PoeToolApi } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { DEBOUNCE_MS_MAX, DEBOUNCE_MS_MIN } from '../../../shared/settings'
import { useClipFeed } from '../hooks'
import { NumberField, TextField, ToggleField } from './Fields'
import { Panel } from './Panel'
import { StatusBadge } from './StatusBadge'

/**
 * How many recent clips the badge's count is drawn from. The same bound the clip list
 * uses; beyond it, the library folder is the archive.
 */
const MAX_CLIPS = 25

export interface ClipSettingsSectionProps {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function ClipSettingsSection({
  api,
  settings,
  update,
  commit,
  flush
}: ClipSettingsSectionProps): ReactElement {
  const clips = useClipFeed(api, MAX_CLIPS)
  const unplacedCount = clips.filter((item) => !item.value.moved).length

  return (
    <Panel
      title="Clips"
      description="What happens after one of your deaths is detected."
      aside={
        settings.clips.enabled ? (
          <StatusBadge
            tone={unplacedCount > 0 ? 'warn' : 'ok'}
            label="Clipping on"
            detail={
              unplacedCount > 0
                ? `${unplacedCount} clip${unplacedCount === 1 ? '' : 's'} not filed`
                : `${clips.length} recent`
            }
            srPrefix="Clipping"
          />
        ) : (
          <StatusBadge
            tone="idle"
            label="Clipping off"
            detail="no replay buffer saves"
            srPrefix="Clipping"
          />
        )
      }
    >
      <ToggleField
        label="Save a clip when I die"
        checked={settings.clips.enabled}
        hint="Off means poe-tool still tails the log and shows events, but never asks OBS to save."
        onChange={(next) => {
          commit({ clips: { enabled: next } })
        }}
      />

      <TextField
        label="Clip library folder"
        value={settings.clips.libraryDir}
        mono
        placeholder="C:\Users\you\Videos\poe-tool"
        hint="Clips are moved here from wherever OBS wrote them, and renamed with the time, zone and character."
        problem={
          settings.clips.libraryDir === ''
            ? 'Not resolved yet — poe-tool will fall back to your Videos folder.'
            : undefined
        }
        onChange={(next) => {
          update({ clips: { libraryDir: next } })
        }}
        onCommit={flush}
      />

      <div className="grid grid--split">
        <NumberField
          label="Minimum gap between clips"
          value={settings.clips.debounceMs}
          min={DEBOUNCE_MS_MIN}
          max={DEBOUNCE_MS_MAX}
          unit="ms"
          hint="A party wipe or a death during a zone transition can log several deaths at once. 5000 is a good default; 0 disables the gap."
          onChange={(next) => {
            update({ clips: { debounceMs: next } })
          }}
          onCommit={flush}
        />
        <ToggleField
          label="Write a .json sidecar next to each clip"
          checked={settings.clips.writeSidecar}
          hint="Records the zone, area level and character alongside the video, for later sorting."
          onChange={(next) => {
            commit({ clips: { writeSidecar: next } })
          }}
        />
      </div>

      <p className="card-meta">
        Saved clips, including any that could not be filed and any whose upload failed, are
        listed in the Activity view.
      </p>
    </Panel>
  )
}
