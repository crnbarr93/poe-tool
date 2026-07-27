/**
 * test/default-paths.test.ts
 * ==========================
 *
 * These tests run on macOS but assert Windows strings. That is the point: the module
 * uses `path.win32` unconditionally, so the exact backslash-separated paths a Windows
 * user will get are pinned here, on a dev machine that has never seen a `C:` drive.
 *
 * The environment is always a hand-built object rather than `process.env`, so the
 * suite is hermetic and a real machine's variables can never leak in.
 */

import { describe, expect, it } from 'vitest'

import {
  autodetectLogPath,
  candidateLogPaths,
  type LogPathExistsFn
} from '../src/main/log/default-paths'

/** A plausible 64-bit Windows environment. `ProgramW6432` duplicates `ProgramFiles`, as it does in real life. */
const WINDOWS_ENV: NodeJS.ProcessEnv = {
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows'
}

const STEAM_POE1 = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt'
const GGG_POE1 = 'C:\\Program Files (x86)\\Grinding Gear Games\\Path of Exile\\logs\\Client.txt'
const EPIC_POE1 = 'C:\\Program Files\\Epic Games\\PathOfExile\\logs\\Client.txt'
const STEAM_POE2 =
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt'

describe('candidateLogPaths', () => {
  it('produces the three required Windows install locations', () => {
    const candidates = candidateLogPaths(WINDOWS_ENV)

    expect(candidates).toContain(STEAM_POE1)
    expect(candidates).toContain(GGG_POE1)
    expect(candidates).toContain(EPIC_POE1)
  })

  it('includes the (untested) Path of Exile 2 Steam variant', () => {
    expect(candidateLogPaths(WINDOWS_ENV)).toContain(STEAM_POE2)
  })

  it('orders Steam PoE1 first and every PoE2 guess after every PoE1 path', () => {
    const candidates = candidateLogPaths(WINDOWS_ENV)

    expect(candidates[0]).toBe(STEAM_POE1)

    const lastPoe1 = candidates.reduce(
      (acc, candidate, index) => (candidate.includes('Path of Exile 2') ? acc : index),
      -1
    )
    const firstPoe2 = candidates.findIndex((candidate) => candidate.includes('Path of Exile 2'))

    expect(firstPoe2).toBeGreaterThan(lastPoe1)
  })

  it('builds paths from the environment rather than hardcoding a drive letter', () => {
    const candidates = candidateLogPaths({
      'ProgramFiles(x86)': 'D:\\Games\\Program Files (x86)',
      ProgramFiles: 'D:\\Games\\Program Files'
    })

    expect(candidates).toContain(
      'D:\\Games\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt'
    )
    expect(candidates.every((candidate) => candidate.startsWith('D:\\Games\\'))).toBe(true)
  })

  it('emits Windows separators even though the suite runs on macOS', () => {
    for (const candidate of candidateLogPaths(WINDOWS_ENV)) {
      expect(candidate).not.toContain('/')
      expect(candidate.endsWith('\\logs\\Client.txt')).toBe(true)
    }
  })

  it('never emits duplicates when ProgramW6432 mirrors ProgramFiles', () => {
    const candidates = candidateLogPaths(WINDOWS_ENV)
    const unique = new Set(candidates.map((candidate) => candidate.toLowerCase()))

    expect(unique.size).toBe(candidates.length)
  })

  it('returns an empty list on a machine with no Windows program directories', () => {
    // i.e. the developer's macOS box, or a Linux CI runner.
    expect(candidateLogPaths({ HOME: '/Users/dev', PATH: '/usr/bin' })).toEqual([])
    expect(candidateLogPaths({})).toEqual([])
  })

  it('still finds the Epic location when only ProgramFiles is defined', () => {
    const candidates = candidateLogPaths({ ProgramFiles: 'C:\\Program Files' })

    expect(candidates).toContain(EPIC_POE1)
    expect(candidates.some((candidate) => candidate.includes('Program Files (x86)'))).toBe(false)
  })

  it('treats empty and whitespace-only variables as undefined', () => {
    expect(candidateLogPaths({ ProgramFiles: '', 'ProgramFiles(x86)': '   ' })).toEqual([])
  })

  it('matches environment variable names case-insensitively, as Windows does', () => {
    const shouty = candidateLogPaths({
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      PROGRAMFILES: 'C:\\Program Files',
      PROGRAMW6432: 'C:\\Program Files'
    })

    expect(shouty).toEqual(candidateLogPaths(WINDOWS_ENV))
  })

  it('normalises a trailing backslash on the install root', () => {
    const candidates = candidateLogPaths({ 'ProgramFiles(x86)': 'C:\\Program Files (x86)\\' })

    expect(candidates).toContain(STEAM_POE1)
    expect(candidates.some((candidate) => candidate.includes('\\\\'))).toBe(false)
  })
})

describe('autodetectLogPath', () => {
  it('returns only the candidates the injected exists function accepts', async () => {
    const found = await autodetectLogPath(WINDOWS_ENV, (candidate) => candidate === GGG_POE1)

    expect(found).toEqual([GGG_POE1])
  })

  it('preserves the most-likely-first ordering of the surviving candidates', async () => {
    const exists = new Set([EPIC_POE1, STEAM_POE1])
    const found = await autodetectLogPath(WINDOWS_ENV, (candidate) => exists.has(candidate))

    expect(found).toEqual([STEAM_POE1, EPIC_POE1])
  })

  it('accepts an async exists function', async () => {
    const existsFn: LogPathExistsFn = async (candidate) => {
      await Promise.resolve()
      return candidate === STEAM_POE2
    }

    expect(await autodetectLogPath(WINDOWS_ENV, existsFn)).toEqual([STEAM_POE2])
  })

  it('returns an empty array when nothing exists, rather than throwing', async () => {
    expect(await autodetectLogPath(WINDOWS_ENV, () => false)).toEqual([])
  })

  it('returns an empty array when there are no candidates at all', async () => {
    let calls = 0
    const found = await autodetectLogPath({}, () => {
      calls++
      return true
    })

    expect(found).toEqual([])
    expect(calls).toBe(0)
  })

  it('treats a throwing exists check as "not found" without failing the whole scan', async () => {
    // A locked-down Program Files raises EACCES for one candidate; the rest must
    // still be reported.
    const found = await autodetectLogPath(WINDOWS_ENV, (candidate) => {
      if (candidate === STEAM_POE1) throw new Error('EACCES: permission denied')
      return candidate === GGG_POE1
    })

    expect(found).toEqual([GGG_POE1])
  })

  it('treats a rejecting async exists check the same way', async () => {
    const found = await autodetectLogPath(WINDOWS_ENV, async (candidate) => {
      if (candidate === STEAM_POE1) return Promise.reject(new Error('EPERM'))
      return candidate === EPIC_POE1
    })

    expect(found).toEqual([EPIC_POE1])
  })

  it('checks every candidate exactly once', async () => {
    const seen: string[] = []
    await autodetectLogPath(WINDOWS_ENV, (candidate) => {
      seen.push(candidate)
      return false
    })

    expect(seen).toEqual(candidateLogPaths(WINDOWS_ENV))
  })
})
