/**
 * src/renderer/src/components/DetectionSwapNotice.tsx
 * ===================================================
 *
 * "poe-tool now thinks you are playing X."
 *
 * WHY THIS LIVES IN THE SHELL AND NOT IN `CharacterSection`
 * --------------------------------------------------------
 * It used to be rendered by `CharacterSection`, which mounts only while Settings ›
 * Character is the selected tab - and the default view is Activity. `useDetectionSwap`
 * diffs two CONSECUTIVE `character:active` values observed WHILE THE HOOK IS MOUNTED, so
 * a swap that happened while the user was anywhere else was never observed at all: by the
 * time they opened the tab, the hook seeded straight to the new character, reported
 * nothing, and the badge read "Auto-detected" in green for the wrong name.
 *
 * That is the exact failure `../detection-swap.ts` was written for - a level-2 mule's
 * single level-up displacing the level-93 character being played, persisted across
 * restarts, with every subsequent death reading as somebody else's and no clip ever saved.
 * So the hook is mounted in `App.tsx`, which lives for the whole window, and the notice is
 * rendered in the shell where it is seen from whichever view the user is actually on.
 *
 * The remaining limit is unchanged and deliberate: a swap that lands with no window open
 * is not re-announced, because main pushes a current value rather than a history.
 *
 *
 * WHY BOTH BUTTONS LOOK THE SAME
 * ------------------------------
 * poe-tool does not know which answer is right. A user who just rolled an alt and a user
 * whose mule levelled once see the identical notice, so neither answer is styled as the
 * recommended one. "No — keep X" writes the OVERRIDE rather than re-detecting, because an
 * override is the only thing that out-ranks the next level-up that mule happens to get.
 */

import type { ReactElement } from 'react'

import type { DetectionSwap } from '../detection-swap'

/** `level 2` / `level unknown`, for a name whose level may never have been seen. */
function levelPhrase(level: number | null): string {
  return level === null ? 'level unknown' : `level ${String(level)}`
}

export interface DetectionSwapNoticeProps {
  readonly swap: DetectionSwap
  /** Write the displaced name as a manual override. */
  readonly onUsePrevious: () => void
  /** "That is me" - acknowledge, change nothing. */
  readonly onDismiss: () => void
}

export function DetectionSwapNotice({
  swap,
  onUsePrevious,
  onDismiss
}: DetectionSwapNoticeProps): ReactElement {
  return (
    <div className="notice notice--warn notice--actions" role="alert">
      <p>
        poe-tool now thinks you are playing <strong>{swap.toName}</strong> (
        {levelPhrase(swap.toLevel)}) — it just levelled up, which replaced{' '}
        <strong>{swap.fromName}</strong> ({levelPhrase(swap.fromLevel)}). Only{' '}
        {swap.toName}&apos;s deaths will be clipped from now on.
      </p>
      {swap.suspicious && (
        <p>
          That is a big drop in level. A mule or a throwaway character levelling once is
          enough to cause this, and the change is remembered across restarts.
        </p>
      )}
      <div className="row">
        <button className="btn btn-secondary" type="button" onClick={onUsePrevious}>
          No — keep {swap.fromName}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onDismiss}>
          That is me
        </button>
      </div>
    </div>
  )
}
