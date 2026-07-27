/**
 * test/clip-namer.test.ts
 * =======================
 *
 * Pure-function tests for clip filename construction.
 *
 * Windows-specific assertions use `path.win32` EXPLICITLY, because the suite runs on
 * macOS: `path.basename` there would happily accept a `\` as an ordinary character
 * and the "is this one path segment?" checks would pass vacuously.
 */

import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyCollisionSuffix,
  buildClipBasename,
  extensionFromPath,
  MAX_FILENAME_SEGMENT_LENGTH,
  sanitizeForFilename,
  UNKNOWN_ZONE_LABEL
} from '../src/main/obs/clip-namer'

/** The nine characters Windows forbids in a path segment. */
const ILLEGAL_CHARS = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] as const

describe('sanitizeForFilename', () => {
  it('strips every Windows-illegal character', () => {
    for (const char of ILLEGAL_CHARS) {
      expect(sanitizeForFilename(`Karui${char}Shores`)).toBe('KaruiShores')
    }
  })

  it('strips all nine illegal characters at once', () => {
    expect(sanitizeForFilename(`a${ILLEGAL_CHARS.join('')}b`)).toBe('ab')
  })

  it('strips non-whitespace control characters', () => {
    expect(sanitizeForFilename('a\u0000b\u0007c\u001Fd\u007Fe')).toBe('abcde')
  })

  it('treats whitespace control characters as whitespace, not as junk', () => {
    // Tab/newline/CR are control chars AND whitespace: they must become a separator,
    // not vanish and glue two words together.
    expect(sanitizeForFilename('a\tb')).toBe('a-b')
    expect(sanitizeForFilename('a\nb')).toBe('a-b')
    expect(sanitizeForFilename('a\r\nb')).toBe('a-b')
  })

  it('collapses whitespace runs into a single dash', () => {
    expect(sanitizeForFilename('The Twilight Strand')).toBe('The-Twilight-Strand')
    expect(sanitizeForFilename('Karui    Shores')).toBe('Karui-Shores')
  })

  it('collapses the dash pile-ups that whitespace collapsing creates', () => {
    expect(sanitizeForFilename('a - b')).toBe('a-b')
    expect(sanitizeForFilename('a  --  b')).toBe('a-b')
  })

  it('trims leading and trailing dots and spaces (Windows rejects them)', () => {
    expect(sanitizeForFilename('Karui Shores.')).toBe('Karui-Shores')
    expect(sanitizeForFilename('Karui Shores...')).toBe('Karui-Shores')
    expect(sanitizeForFilename('   Karui Shores   ')).toBe('Karui-Shores')
    expect(sanitizeForFilename(' . Karui Shores . ')).toBe('Karui-Shores')
    expect(sanitizeForFilename('...')).toBe('')
    expect(sanitizeForFilename('   ')).toBe('')
  })

  it('never returns a value ending in a dot, space or dash', () => {
    const samples = ['Karui Shores.', 'Karui Shores ', 'Karui Shores-', 'a.b.', '  x  ']
    for (const sample of samples) {
      const result = sanitizeForFilename(sample)
      expect(result).not.toMatch(/[.\-\s]$/)
    }
  })

  it('keeps inner dots (they are legal and often meaningful)', () => {
    expect(sanitizeForFilename('Act 3.1 Sewers')).toBe('Act-3.1-Sewers')
  })

  it('caps the length at MAX_FILENAME_SEGMENT_LENGTH', () => {
    const result = sanitizeForFilename('A'.repeat(200))
    expect(result).toHaveLength(MAX_FILENAME_SEGMENT_LENGTH)
    expect(result).toBe('A'.repeat(MAX_FILENAME_SEGMENT_LENGTH))
  })

  it('re-trims after truncation so a cut on a dash does not leak through', () => {
    // 59 chars, then a space, then more: the cut at 60 lands exactly on the dash the
    // space became, which must then be trimmed off.
    const result = sanitizeForFilename(`${'B'.repeat(MAX_FILENAME_SEGMENT_LENGTH - 1)} tail`)
    expect(result).toBe('B'.repeat(MAX_FILENAME_SEGMENT_LENGTH - 1))
    expect(result).not.toMatch(/-$/)
  })

  it('is total: returns a string for empty and all-illegal input', () => {
    expect(sanitizeForFilename('')).toBe('')
    expect(sanitizeForFilename(':::')).toBe('')
    expect(sanitizeForFilename('<>:"/\\|?*')).toBe('')
  })
})

describe('extensionFromPath', () => {
  it('reads a Windows path even when running on POSIX', () => {
    expect(extensionFromPath('C:\\Users\\me\\Videos\\Replay 2026-07-26 19-26-31.mkv')).toBe('.mkv')
  })

  it('reads a POSIX path', () => {
    expect(extensionFromPath('/home/me/Videos/clip.mp4')).toBe('.mp4')
  })

  it('returns empty string when there is no extension', () => {
    expect(extensionFromPath('C:\\Videos\\replay')).toBe('')
    expect(extensionFromPath('/tmp/replay')).toBe('')
  })

  it('does not treat a leading dot as an extension', () => {
    expect(extensionFromPath('/tmp/.hidden')).toBe('')
  })

  it('ignores dots in parent directory names', () => {
    expect(extensionFromPath('C:\\dir.with.dots\\replay')).toBe('')
    expect(extensionFromPath('/dir.with.dots/replay')).toBe('')
  })
})

describe('buildClipBasename', () => {
  // Constructed with the local-time constructor so this is timezone-independent:
  // local-in, local-out.
  const when = new Date(2026, 6, 26, 19, 26, 31)

  it('produces a sortable, colon-free name', () => {
    expect(buildClipBasename({ when, zoneName: 'Karui Shores', extension: '.mkv' })).toBe(
      '2026-07-26_19-26-31_Karui-Shores.mkv'
    )
  })

  it('accepts an extension with or without the leading dot', () => {
    const withDot = buildClipBasename({ when, zoneName: 'Karui Shores', extension: '.mkv' })
    const withoutDot = buildClipBasename({ when, zoneName: 'Karui Shores', extension: 'mkv' })
    expect(withoutDot).toBe(withDot)
  })

  it('preserves whatever container OBS used', () => {
    expect(buildClipBasename({ when, zoneName: 'Karui Shores', extension: '.mp4' })).toBe(
      '2026-07-26_19-26-31_Karui-Shores.mp4'
    )
    expect(buildClipBasename({ when, zoneName: 'Karui Shores', extension: '.flv' })).toBe(
      '2026-07-26_19-26-31_Karui-Shores.flv'
    )
  })

  it('omits the extension entirely when there is none', () => {
    expect(buildClipBasename({ when, zoneName: 'Karui Shores', extension: '' })).toBe(
      '2026-07-26_19-26-31_Karui-Shores'
    )
  })

  it('zero-pads every component', () => {
    expect(
      buildClipBasename({ when: new Date(2026, 0, 5, 3, 4, 5), zoneName: 'Lioneye', extension: '.mkv' })
    ).toBe('2026-01-05_03-04-05_Lioneye.mkv')
  })

  it('falls back to unknown-zone for a null zone name', () => {
    expect(buildClipBasename({ when, zoneName: null, extension: '.mkv' })).toBe(
      `2026-07-26_19-26-31_${UNKNOWN_ZONE_LABEL}.mkv`
    )
  })

  it('falls back to unknown-zone when the name sanitises away to nothing', () => {
    for (const zoneName of ['', '   ', ':::', '...', '<>|?*']) {
      expect(buildClipBasename({ when, zoneName, extension: '.mkv' })).toBe(
        `2026-07-26_19-26-31_${UNKNOWN_ZONE_LABEL}.mkv`
      )
    }
  })

  it('sanitises a hostile zone name', () => {
    expect(
      buildClipBasename({ when, zoneName: 'Ancient Pyramid: Level 1 ', extension: '.mkv' })
    ).toBe('2026-07-26_19-26-31_Ancient-Pyramid-Level-1.mkv')
  })

  it('sanitises the extension too', () => {
    expect(buildClipBasename({ when, zoneName: 'Karui Shores', extension: '.mk:v' })).toBe(
      '2026-07-26_19-26-31_Karui-Shores.mkv'
    )
  })

  it('is total for an Invalid Date', () => {
    expect(
      buildClipBasename({ when: new Date(Number.NaN), zoneName: 'Karui Shores', extension: '.mkv' })
    ).toBe('0000-00-00_00-00-00_Karui-Shores.mkv')
  })

  it('sorts lexicographically in chronological order', () => {
    const names = [
      buildClipBasename({ when: new Date(2026, 6, 26, 19, 26, 31), zoneName: 'B', extension: '.mkv' }),
      buildClipBasename({ when: new Date(2026, 6, 26, 9, 5, 4), zoneName: 'A', extension: '.mkv' }),
      buildClipBasename({ when: new Date(2025, 11, 31, 23, 59, 59), zoneName: 'C', extension: '.mkv' })
    ]
    expect([...names].sort()).toEqual([names[2], names[1], names[0]])
  })

  it('is a single valid Windows path segment', () => {
    const name = buildClipBasename({
      when,
      zoneName: 'Chamber of Sins Level 2/1: "The Pit" <boss>',
      extension: '.mkv'
    })
    // Windows-specific assertions, made explicitly against win32 - this suite runs on macOS.
    expect(path.win32.basename(name)).toBe(name)
    expect(path.win32.parse(name).dir).toBe('')
    expect(path.win32.isAbsolute(name)).toBe(false)
    for (const char of ILLEGAL_CHARS) {
      expect(name).not.toContain(char)
    }
    expect(name).not.toMatch(/[.\s]$/)
  })
})

describe('applyCollisionSuffix', () => {
  it('returns the name unchanged for the first candidate', () => {
    expect(applyCollisionSuffix('clip.mkv', 1)).toBe('clip.mkv')
    expect(applyCollisionSuffix('clip.mkv', 0)).toBe('clip.mkv')
    expect(applyCollisionSuffix('clip.mkv', -3)).toBe('clip.mkv')
  })

  it('inserts the suffix before the extension', () => {
    expect(applyCollisionSuffix('2026-07-26_19-26-31_Karui-Shores.mkv', 2)).toBe(
      '2026-07-26_19-26-31_Karui-Shores-2.mkv'
    )
    expect(applyCollisionSuffix('2026-07-26_19-26-31_Karui-Shores.mkv', 3)).toBe(
      '2026-07-26_19-26-31_Karui-Shores-3.mkv'
    )
  })

  it('appends when there is no extension', () => {
    expect(applyCollisionSuffix('clip', 2)).toBe('clip-2')
  })

  it('treats a leading dot as part of the stem', () => {
    expect(applyCollisionSuffix('.hidden', 2)).toBe('.hidden-2')
  })

  it('only splits on the last dot', () => {
    expect(applyCollisionSuffix('clip.tar.gz', 2)).toBe('clip.tar-2.gz')
  })
})
