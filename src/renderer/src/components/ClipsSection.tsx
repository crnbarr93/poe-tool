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
 *
 * THE SAME RULE, APPLIED AGAIN TO UPLOADS
 * ---------------------------------------
 * Every row also carries its Streamable upload state, and the two unhappy endings are as
 * visible as the happy one. `skipped` (we chose not to - the file is over the free-plan
 * size cap, the clip is not on this machine, no credentials) and `failed` (we tried and
 * could not) are different sentences for different problems, and neither is greyed out or
 * hidden behind a hover. A user who believes their deaths are being uploaded and finds
 * out weeks later that a size limit quietly dropped them is the exact outcome this
 * project exists to avoid.
 *
 * The upload state on the row is LIVE: `ClipRecord.upload` is only a snapshot from when
 * the record was sent, and `useClipFeed` folds `push:clip-upload` into the row as the
 * upload progresses. See its note in `../hooks.ts`.
 *
 * AND A FAILURE CAN STILL HAVE A LINK. When the upload itself worked and only the wait for
 * transcoding ran out - the poll cap, or a quit mid-poll - main sends the shortcode and URL
 * on the `failed`/`skipped` outcome, and the row shows them exactly as `done` would. The
 * video is on Streamable; the only thing that failed was poe-tool watching it.
 */

import type { ReactElement } from 'react'

import type { ClipRecord, PoeToolApi, UploadOutcome } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { DEBOUNCE_MS_MAX, DEBOUNCE_MS_MIN } from '../../../shared/settings'
import { fileNameOf, formatEpochDateTime } from '../format'
import { useClipFeed } from '../hooks'
import { CopyButton } from './CopyButton'
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

/**
 * One clip's Streamable upload, inline on its row.
 *
 * EXHAUSTIVE over {@link UploadOutcome} - a new upload state is a compile error here
 * rather than a row that silently renders nothing.
 *
 * WHY `processing` SHOWS A SHORTCODE AND NOT A LINK
 * ------------------------------------------------
 * The video does exist at that address from the moment Streamable accepts it, but
 * `UploadProcessing` deliberately carries only the shortcode: URLs are assembled in main
 * so that there is exactly one place that knows what a Streamable URL looks like. Building
 * one here to save the user a few seconds would put a second copy of that knowledge in the
 * renderer, and the saving is a link that does not play yet anyway. `done` carries the
 * real `url` and that is what gets linked.
 */
function UploadState({ upload }: { readonly upload: UploadOutcome }): ReactElement {
  switch (upload.state) {
    case 'disabled':
      return (
        <div className="clip__upload">
          <span
            className="tag tag--idle"
            title="Streamable uploading is switched off, so this clip was never a candidate."
          >
            not uploaded
          </span>
        </div>
      )

    case 'pending':
      return (
        <div className="clip__upload">
          <span className="tag tag--info">upload queued</span>
        </div>
      )

    case 'uploading':
      return (
        <div className="clip__upload">
          <span className="tag tag--info">uploading</span>
          {/*
            `percent: null` is the NORMAL case, not a missing value: the upload is one
            fetch of a multipart body and the platform gives no per-chunk callback. Saying
            "in progress" is honest; rendering "0%" would look stuck.
          */}
          <span className="clip__upload-note">
            {upload.percent === null ? 'in progress' : `${upload.percent}%`}
          </span>
        </div>
      )

    case 'processing':
      return (
        <div className="clip__upload">
          <span className="tag tag--info">processing</span>
          <span className="clip__upload-note">
            Streamable has the file and is transcoding it — the link appears when it can be
            played.
          </span>
          <span className="mono clip__upload-code">{upload.shortcode}</span>
        </div>
      )

    case 'done':
      return (
        <div className="clip__upload">
          <span className="tag tag--ok">uploaded</span>
          {/*
            `target="_blank"` is REQUIRED, not habit. `src/main/index.ts` blocks in-page
            navigation outright (replacing this document would hand a remote origin the
            preload bridge) and routes window-open requests to `shell.openExternal`, so a
            plain same-window link would simply do nothing. `rel="noreferrer"` because
            Streamable has no business knowing where the click came from.
          */}
          <a className="clip__link" href={upload.url} target="_blank" rel="noreferrer">
            {upload.url}
          </a>
          <CopyButton text={upload.url} label="Copy link" srLabel="Streamable link" />
        </div>
      )

    case 'skipped':
      return (
        <div className="clip__upload">
          <span className="tag tag--warn">not uploaded</span>
          {/*
            `reason` is a complete sentence written in main and safe to render verbatim.
            It is shown in a block, at full contrast, because a skip is a decision the
            user is entitled to disagree with - and the clip is still on disk either way.
          */}
          <p className="clip__note clip__note--problem">{upload.reason}</p>
          <UploadedLink url={upload.url} />
        </div>
      )

    case 'failed':
      return (
        <div className="clip__upload">
          <span className="tag tag--bad">upload failed</span>
          <p className="clip__note clip__note--failed">
            {upload.message} The clip itself is untouched — a failed upload never costs you
            the file.
          </p>
          <UploadedLink url={upload.url} />
        </div>
      )
  }
}

/**
 * The link on an unhappy ending that nonetheless produced a video.
 *
 * `skipped` and `failed` carry a `url` in exactly one situation: the upload SUCCEEDED and
 * then poe-tool stopped watching the transcode - the poll cap ran out, or the app quit
 * mid-poll. The message already names the URL in prose because it has to read correctly on
 * its own, but prose is not clickable and not copyable, and a user whose clip is sitting on
 * Streamable right now should not have to retype it out of a paragraph.
 *
 * Renders nothing at all when there is no URL, which is every other skip and failure.
 */
function UploadedLink({ url }: { readonly url: string | undefined }): ReactElement | null {
  if (url === undefined || url === '') return null
  return (
    <>
      {/* `target="_blank"` for the same reason as the `done` row - see the note there. */}
      <a className="clip__link" href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      <CopyButton text={url} label="Copy link" srLabel="Streamable link" />
    </>
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

      <UploadState upload={clip.upload} />
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
