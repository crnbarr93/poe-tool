/**
 * src/main/tools/changelog.ts
 * ===========================
 *
 * Extracts one version's section out of CHANGELOG.md so `release.yml` can use it as
 * the GitHub Release body.
 *
 * WHY THIS IS A TESTED MODULE AND NOT A `node -e` ONE-LINER IN THE WORKFLOW
 * ------------------------------------------------------------------------
 * The release job GATES on this: a version with no changelog section fails the build
 * before anything is published. A silently-wrong extractor would therefore either
 * block a good release or, worse, publish a release whose notes belong to a different
 * version. Both are hard to notice from inside a green CI run, so the parsing lives
 * here with unit tests rather than in a shell step nobody can exercise locally.
 *
 * BUILD-TIME TOOL, NOT APP CODE. Compiled by tsconfig.tools.json alongside
 * tail-debug.ts, so it must not import electron and must not reach into src/main
 * runtime modules.
 *
 * FORMAT ASSUMED - Keep a Changelog:
 *
 *   ## [0.3.0] — 2026-07-28      <- a version heading
 *   ### Added                    <- body
 *   - ...
 *   ## [0.2.0] — 2026-07-27      <- the next version heading ends the section
 *
 * The heading matcher is deliberately loose about what follows the version: an em
 * dash, a hyphen, a date, or nothing at all. It is strict about the version itself,
 * because matching "0.3.0" against a heading for "0.3.0-rc1" would attach the wrong
 * notes to a real release.
 */

import { readFileSync } from 'node:fs'

/** A version heading: `## [1.2.3]` or `## 1.2.3`, with anything after it. */
const VERSION_HEADING = /^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\s|$)/

/** Any `## ` heading, used to find where a section stops. */
const ANY_H2 = /^##\s+/

export interface ChangelogSection {
  readonly version: string
  /** Section body with surrounding blank lines trimmed. Never empty when returned. */
  readonly notes: string
}

/**
 * Returns the section for `version`, or `null` when the file has no heading for it or
 * the heading exists but has no body.
 *
 * An empty body counts as absent ON PURPOSE: a heading with nothing under it would
 * otherwise publish a release whose notes are a single line of whitespace, which is
 * indistinguishable at a glance from the extractor having failed.
 */
export function extractChangelogSection(
  markdown: string,
  version: string
): ChangelogSection | null {
  const lines = markdown.split(/\r?\n/)

  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) continue
    const match = VERSION_HEADING.exec(line)
    if (match !== null && match[1] === version) {
      start = i + 1
      break
    }
  }
  if (start === -1) return null

  let end = lines.length
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (line !== undefined && ANY_H2.test(line)) {
      end = i
      break
    }
  }

  // Link-reference definitions ([0.3.0]: https://...) trail the file and belong to no
  // section; drop them so the last version's notes do not end with a block of URLs.
  const body = lines
    .slice(start, end)
    .filter((line) => !/^\[[^\]]+\]:\s+\S+/.test(line))
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '')

  if (body.trim() === '') return null
  return { version, notes: body }
}

/**
 * CLI: `node dist-tools/main/tools/changelog.js <version> [changelogPath]`
 *
 * Prints the section to stdout, or exits 1 with a message on stderr when there is
 * none. `release.yml` relies on both behaviours: the stdout for the release body, the
 * exit code for the gate.
 *
 * Guarded so importing this module from a test does not run the CLI.
 */
if (process.argv[1] !== undefined && /changelog\.(js|ts)$/.test(process.argv[1])) {
  const version = process.argv[2]
  const path = process.argv[3] ?? 'CHANGELOG.md'

  if (version === undefined || version === '') {
    process.stderr.write('usage: changelog <version> [changelogPath]\n')
    process.exit(2)
  }

  let markdown: string
  try {
    markdown = readFileSync(path, 'utf8')
  } catch (error) {
    process.stderr.write(`cannot read ${path}: ${String(error)}\n`)
    process.exit(1)
    throw error
  }

  const section = extractChangelogSection(markdown, version)
  if (section === null) {
    process.stderr.write(
      `${path} has no non-empty section for version ${version}.\n` +
        `Add a "## [${version}]" heading with notes under it before tagging.\n`
    )
    process.exit(1)
  } else {
    process.stdout.write(`${section.notes}\n`)
  }
}
