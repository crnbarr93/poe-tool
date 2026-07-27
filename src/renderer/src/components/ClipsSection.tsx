/**
 * src/renderer/src/components/ClipsSection.tsx
 * ============================================
 *
 * Clipping behaviour, plus the recent-clips list.
 *
 * FAILURES ARE RENDERED AS LOUDLY AS SUCCESSES - ON PURPOSE
 * ---------------------------------------------------------
 * `moveClip` never rejects and never deletes a clip it could not place: a failed move
 * comes back as a `ClipRecord` with `moved: false`, `finalPath: null` and a `note`
 * explaining why (remote OBS, cross-volume copy failed, file still locked by OBS or
 * antivirus). The file is still on disk at `originalPath`.
 *
 * A UI that quietly filtered those out - or showed them in grey small print - would
 * turn "your clip is in the OBS folder instead of your library" into "poe-tool lost my
 * clip". So an unmoved clip keeps its row, gets a coloured rail, states plainly where
 * the file actually is, and always shows its note.
 */

import type { ReactElement } from 'react'

import type { ClipRecord, PoeToolApi } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { DEBOUNCE_MS_MAX, DEBOUNCE_MS_MIN } from '../../../shared/settings'
import { fileNameOf, formatEpochDateTime } from '../format'
import { useClipFeed } from '../hooks'
import { NumberField, TextField, ToggleField } from './Fields'
import { Section } from './Section'
import { StatusBadge } from './StatusBadge'

/** How many clips the list keeps. Beyond this, the library folder is the archive. */
const MAX_CLIPS = 25

/** `Karui Shores · lvl 69` from whichever of the zone fields survived. */
function describeClipZone(clip: ClipRecord): string {
  const name = clip.zoneName ?? clip.areaId
  const level = clip.areaLevel === null ? null : `lvl ${clip.areaLevel}`

  if (name === null && level === null) return 'zone unknown'
  if (name === null) return level ?? 'zone unknown'
  if (level === null) return name
  return `${name} · ${level}`
}

/**
 * The `cause` chip.
 *
 * In practice every row says `slain`, because a `/kill` is deliberate and the clipper
 * drops it before OBS is ever asked (see `DeathCause`). Showing it anyway is what makes
 * that rule LEGIBLE rather than folklore: a user who types `/kill`, gets no clip, and
 * then reads a list where every clip is explicitly labelled `slain` can see the pattern.
 * And if a `suicide` ever does appear here - a future manual "clip that" button, a change
 * of mind - the row explains itself instead of contradicting the documentation.
 */
function CauseTag({ cause }: { readonly cause: ClipRecord['cause'] }): ReactElement {
  if (cause === 'suicide') {
    return (
      <span className="tag tag--idle" title="PoE's /kill command — deliberate, normally never clipped.">
        /kill
      </span>
    )
  }
  return (
    <span className="tag tag--bad" title="Killed by the game — the kind of death clips exist for.">
      slain
    </span>
  )
}

function ClipRow({ clip }: { readonly clip: ClipRecord }): ReactElement {
  const placed = clip.moved && clip.finalPath !== null
  const location = clip.finalPath ?? clip.originalPath

  return (
    <li className={placed ? 'clip' : 'clip clip--unplaced'}>
      <div className="clip__head">
        <span className="clip__time">{formatEpochDateTime(clip.savedAt)}</span>
        <span className={placed ? 'tag tag--ok' : 'tag tag--warn'}>
          {placed ? 'In library' : 'Left in OBS folder'}
        </span>
        <CauseTag cause={clip.cause} />
        <span className="clip__zone">{describeClipZone(clip)}</span>
        {clip.characterName !== '' && <span className="clip__character">{clip.characterName}</span>}
      </div>

      <div className="clip__path mono" title={location}>
        {fileNameOf(location)}
      </div>
      <div className="clip__dir mono" title={location}>
        {location}
      </div>

      {clip.note !== null && clip.note !== '' && (
        <p className={placed ? 'clip__note' : 'clip__note clip__note--problem'}>{clip.note}</p>
      )}
    </li>
  )
}

export interface ClipsSectionProps {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function ClipsSection({
  api,
  settings,
  update,
  commit,
  flush
}: ClipsSectionProps): ReactElement {
  const clips = useClipFeed(api, MAX_CLIPS)
  const unplacedCount = clips.filter((item) => !item.value.moved).length

  return (
    <Section
      index="4"
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
          />
        ) : (
          <StatusBadge tone="idle" label="Clipping off" detail="no replay buffer saves" />
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

      <div className="feed">
        <div className="feed__head">
          <h3 className="feed__title">Recent clips</h3>
          <span className="feed__count">{clips.length === 0 ? 'none yet' : `${clips.length} shown`}</span>
        </div>

        {clips.length === 0 ? (
          <p className="feed__empty">
            No clips yet. One appears here each time you are slain with clipping enabled and the
            OBS replay buffer running — including any that could not be filed. Deaths from{' '}
            <span className="mono">/kill</span> are deliberately never clipped, and a clip is only
            taken for the character shown in the Character section above.
          </p>
        ) : (
          <ul className="feed__list feed__list--clips">
            {clips.map((item) => (
              <ClipRow key={item.key} clip={item.value} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
