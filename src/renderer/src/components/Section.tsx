/**
 * src/renderer/src/components/Section.tsx
 * =======================================
 *
 * The card each configuration area lives in.
 *
 * `aria-labelledby` points at the heading so the sections form a real document
 * outline: a screen reader user can jump between "Log source", "OBS", "Clips" instead
 * of walking through every input in the window.
 */

import type { ReactNode } from 'react'
import type { ReactElement } from 'react'
import { useId } from 'react'

export interface SectionProps {
  readonly title: string
  /** Small ordinal shown in the heading, e.g. `"1"`. Purely a wayfinding aid. */
  readonly index: string
  readonly description?: string | undefined
  /** Status badge area, rendered right-aligned in the heading row. */
  readonly aside?: ReactNode | undefined
  readonly children: ReactNode
}

export function Section({
  title,
  index,
  description,
  aside,
  children
}: SectionProps): ReactElement {
  const headingId = useId()

  return (
    <section className="section" aria-labelledby={headingId}>
      <div className="section__head">
        <div className="section__title">
          <span className="section__index" aria-hidden="true">
            {index}
          </span>
          <h2 className="section__heading" id={headingId}>
            {title}
          </h2>
        </div>
        {aside !== undefined && aside !== null && <div className="section__aside">{aside}</div>}
      </div>
      {description !== undefined && <p className="section__description">{description}</p>}
      <div className="section__body">{children}</div>
    </section>
  )
}
