/**
 * test/changelog.test.ts
 * ======================
 *
 * The release job gates on `extractChangelogSection`: no section, no release. A wrong
 * answer either blocks a good release or publishes one carrying another version's
 * notes, and neither is obvious from a green CI run — so the parsing is pinned here.
 */

import { describe, expect, it } from 'vitest'

import { extractChangelogSection } from '../src/main/tools/changelog'

const CHANGELOG = `# Changelog

Preamble that belongs to no version.

## [Unreleased]

Nothing yet.

## [0.3.0] — 2026-07-28

### Changed

- Rebuilt the interface.

### Fixed

- The readiness pill lied about OBS.

## [0.2.0] — 2026-07-27

First published release.

## [0.1.0]

Never released.

[0.3.0]: https://github.com/crnbarr93/poe-tool/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/crnbarr93/poe-tool/releases/tag/v0.2.0
`

describe('extractChangelogSection', () => {
  it('returns the body of the requested version', () => {
    const section = extractChangelogSection(CHANGELOG, '0.3.0')

    expect(section?.version).toBe('0.3.0')
    expect(section?.notes).toContain('Rebuilt the interface.')
    expect(section?.notes).toContain('The readiness pill lied about OBS.')
  })

  it('stops at the next version heading', () => {
    // The single most damaging failure would be running past the boundary and
    // attributing an older release's notes to this one.
    const section = extractChangelogSection(CHANGELOG, '0.3.0')

    expect(section?.notes).not.toContain('First published release.')
    expect(section?.notes).not.toContain('Never released.')
  })

  it('does not leak the preamble into the first section', () => {
    const section = extractChangelogSection(CHANGELOG, '0.3.0')

    expect(section?.notes).not.toContain('Preamble that belongs to no version.')
  })

  it('drops trailing link-reference definitions', () => {
    // These sit at the end of the file and belong to no section; without filtering,
    // the last version's notes would end in a block of bare URLs.
    const section = extractChangelogSection(CHANGELOG, '0.1.0')

    expect(section?.notes).toBe('Never released.')
  })

  it('trims surrounding blank lines', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0')

    expect(section?.notes).toBe('First published release.')
  })

  it('returns null for a version with no heading', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull()
  })

  it('returns null for a heading with an empty body', () => {
    // A heading with nothing under it would publish notes consisting of whitespace,
    // which reads as a broken extractor rather than an intentional release.
    const empty = '## [1.0.0] — 2026-01-01\n\n## [0.9.0] — 2025-12-01\n\nNotes.\n'

    expect(extractChangelogSection(empty, '1.0.0')).toBeNull()
  })

  it('does not match a prerelease heading for the plain version', () => {
    // Attaching 0.3.0-rc1's notes to the real 0.3.0 release would be silent and wrong.
    const pre = '## [0.3.0-rc1] — 2026-01-01\n\nRelease candidate.\n'

    expect(extractChangelogSection(pre, '0.3.0')).toBeNull()
  })

  it('accepts a heading without brackets or a date', () => {
    const plain = '## 2.0.0\n\nPlain heading.\n'

    expect(extractChangelogSection(plain, '2.0.0')?.notes).toBe('Plain heading.')
  })

  it('handles CRLF line endings', () => {
    const crlf = CHANGELOG.replace(/\n/g, '\r\n')

    expect(extractChangelogSection(crlf, '0.2.0')?.notes).toBe('First published release.')
  })

  it('ignores the Unreleased heading when looking for a version', () => {
    expect(extractChangelogSection(CHANGELOG, 'Unreleased' as unknown as string)).toBeNull()
  })
})
