/**
 * src/renderer/src/components/CopyButton.tsx
 * ==========================================
 *
 * "Copy" for a short string - in practice a `https://streamable.com/{shortcode}` link.
 *
 *
 * WHY THIS IS NOT A ONE-LINER
 * ---------------------------
 * `navigator.clipboard.writeText` is typed as always present and is nothing of the sort
 * at runtime. It is gated on a secure context, on the document being focused, and on a
 * permission the embedder can refuse; in a packaged Electron build the page is loaded
 * from `file://` and, while Chromium does treat that as trustworthy, none of the other
 * conditions are ours to guarantee. A copy that silently does nothing is worse than no
 * button at all, because the user walks away believing they have the link on their
 * clipboard and pastes something else into their friend's chat.
 *
 * So: the API is read through an explicitly optional binding (no `any`, no `as`), the
 * promise's rejection is handled, and BOTH outcomes are stated on the button itself.
 * When it fails the URL is still on screen next to it and can be selected by hand, which
 * is why failure is worth reporting rather than retrying.
 *
 * The confirmation reverts after a moment so the button does not sit there claiming
 * "Copied" over a link the user has since replaced. That timer is cleared on unmount -
 * the clip feed is a live list and rows genuinely do come and go under it.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the "Copied"/"Copy failed" confirmation stays up. */
const FLASH_MS = 1800

type CopyState = 'idle' | 'copied' | 'failed'

export interface CopyButtonProps {
  /** The exact text to put on the clipboard. */
  readonly text: string
  /** Button label in the resting state. */
  readonly label?: string | undefined
  /** Read out by screen readers in place of the visible label, when it needs context. */
  readonly srLabel?: string | undefined
}

export function CopyButton({
  text,
  label = 'Copy',
  srLabel
}: CopyButtonProps): ReactElement {
  const [state, setState] = useState<CopyState>('idle')
  const timerRef = useRef<number | null>(null)

  const flash = useCallback((next: CopyState): void => {
    setState(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setState('idle')
    }, FLASH_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  const copy = (): void => {
    // Widened to `| undefined` on purpose: the DOM typings promise a `Clipboard` here,
    // the browser does not.
    const clipboard: Clipboard | undefined = navigator.clipboard
    if (clipboard === undefined) {
      flash('failed')
      return
    }

    void clipboard.writeText(text).then(
      () => {
        flash('copied')
      },
      () => {
        // Rejected by permission policy, or because the window was not focused. Nothing
        // to retry - the user can select the link, which is right beside this button.
        flash('failed')
      }
    )
  }

  return (
    <button
      className="button button--small"
      type="button"
      onClick={copy}
      // `aria-live` on the button itself: the label IS the result, so announcing the
      // element is announcing the outcome, with no second live region to keep in sync.
      aria-live="polite"
    >
      {srLabel !== undefined && state === 'idle' && <span className="sr-only">{srLabel}: </span>}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  )
}
