/**
 * src/renderer/src/components/Panel.tsx
 * =====================================
 *
 * The card one settings tab's content sits in: a surface card at the design's panel
 * metrics (padding 22.4px, gap 16.8px, an h2 at 16px).
 *
 * WHY THIS EXISTS ALONGSIDE `Section`
 * -----------------------------------
 * `Section` is the pre-redesign card, and it carries an `index` prop - a small ordinal
 * bubble that numbered six sections on one long scrolling page. Those sections now live
 * behind a tab rail in one view and a feed in another, so the numbering describes a page
 * that no longer exists: the Settings rail would read "1, 2, 3, 5" and send the user
 * hunting for a step 4 on a different screen. `Panel` is the same card with the ordinal
 * gone and the design's metrics applied.
 *
 * `aria-labelledby` points at the heading, exactly as `Section` did, so each panel is a
 * real landmark in the document outline rather than an anonymous div - a screen-reader
 * user lands on "OBS" or "Streamable uploads" instead of walking every input to work out
 * where they are.
 *
 * `aside` is not decoration. It is where the live status badges go (watcher tailing,
 * OBS connected, character resolved, uploads configured), and those badges are the fastest
 * answer this window gives to "why am I not getting clips" - see StatusBadge.tsx.
 */

import type { ReactElement, ReactNode } from 'react'
import { useId } from 'react'

export interface PanelProps {
  readonly title: string
  /** One sentence on what the panel is for. Rendered under the heading. */
  readonly description?: string | undefined
  /** Status badge area, right-aligned in the heading row. */
  readonly aside?: ReactNode | undefined
  readonly children: ReactNode
}

export function Panel({ title, description, aside, children }: PanelProps): ReactElement {
  const headingId = useId()

  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel__head">
        <div className="panel__heading">
          <h2 className="panel__title" id={headingId}>
            {title}
          </h2>
          {description !== undefined && <p className="panel__description">{description}</p>}
        </div>
        {aside !== undefined && aside !== null && <div className="panel__aside">{aside}</div>}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  )
}
