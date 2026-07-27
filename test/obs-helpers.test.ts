/**
 * test/obs-helpers.test.ts
 * ========================
 *
 * Covers the PURE helpers exported by `src/main/obs/obs-client.ts`: URL building,
 * host parsing, `isLocalHost`, failure classification/description, request-failure
 * mapping and the reconnect backoff curve.
 *
 * The live socket is deliberately NOT tested here - that needs a real OBS. Everything
 * in this file is a total function over plain values, which is exactly why those
 * decisions were pulled out of the class in the first place.
 *
 * A note on the error fixtures: `classifyObsFailure` and friends DUCK-TYPE the
 * `{ code, message }` shape rather than using `instanceof OBSWebSocketError`, so the
 * plain objects below are faithful stand-ins for what obs-websocket-js throws.
 */

import { describe, expect, it } from 'vitest'

import {
  backoffDelayMs,
  buildObsUrl,
  classifyObsFailure,
  DEFAULT_BACKOFF,
  DEFAULT_OBS_HOST,
  DEFAULT_OBS_PORT,
  describeObsFailure,
  isLocalHost,
  mapRequestFailure,
  obsErrorCode,
  obsErrorMessage,
  OBS_RPC_VERSION,
  parseObsHost
} from '../src/main/obs/obs-client'

/** Builds the `{ code, message }` shape obs-websocket-js throws. */
function obsError(code: number, message: string): { code: number; message: string } {
  return { code, message }
}

// ---------------------------------------------------------------------------
// parseObsHost
// ---------------------------------------------------------------------------

describe('parseObsHost', () => {
  it('passes a bare hostname through, lower-cased and trimmed', () => {
    expect(parseObsHost('  LocalHost  ')).toEqual({ secure: false, hostname: 'localhost', port: null })
  })

  it('extracts an explicit port', () => {
    expect(parseObsHost('192.168.0.5:4456')).toEqual({ secure: false, hostname: '192.168.0.5', port: 4456 })
  })

  it('recognises ws:// and wss:// schemes', () => {
    expect(parseObsHost('ws://127.0.0.1')).toEqual({ secure: false, hostname: '127.0.0.1', port: null })
    expect(parseObsHost('wss://obs.example.com')).toEqual({ secure: true, hostname: 'obs.example.com', port: null })
  })

  it('treats http/https as the ws/wss equivalents', () => {
    expect(parseObsHost('http://127.0.0.1:4455').secure).toBe(false)
    expect(parseObsHost('https://127.0.0.1:4455').secure).toBe(true)
  })

  it('drops paths, queries and fragments', () => {
    expect(parseObsHost('ws://127.0.0.1:4455/')).toEqual({ secure: false, hostname: '127.0.0.1', port: 4455 })
    expect(parseObsHost('ws://127.0.0.1:4455/socket?token=abc')).toEqual({
      secure: false,
      hostname: '127.0.0.1',
      port: 4455
    })
  })

  it('drops embedded credentials without mistaking the password colon for a port', () => {
    expect(parseObsHost('ws://user:s3cret@127.0.0.1:4455')).toEqual({
      secure: false,
      hostname: '127.0.0.1',
      port: 4455
    })
  })

  it('keeps a bare IPv6 literal whole rather than reading its last group as a port', () => {
    expect(parseObsHost('::1')).toEqual({ secure: false, hostname: '::1', port: null })
    expect(parseObsHost('fe80::1234:5678')).toEqual({ secure: false, hostname: 'fe80::1234:5678', port: null })
  })

  it('unwraps a bracketed IPv6 literal and reads the port after the bracket', () => {
    expect(parseObsHost('[::1]:4455')).toEqual({ secure: false, hostname: '::1', port: 4455 })
    expect(parseObsHost('ws://[::1]')).toEqual({ secure: false, hostname: '::1', port: null })
  })

  it('strips the DNS root label so "localhost." is still localhost', () => {
    expect(parseObsHost('localhost.').hostname).toBe('localhost')
  })

  it('rejects out-of-range and non-numeric ports rather than inventing one', () => {
    expect(parseObsHost('127.0.0.1:0').port).toBeNull()
    expect(parseObsHost('127.0.0.1:65536').port).toBeNull()
    expect(parseObsHost('127.0.0.1:abc').port).toBeNull()
    expect(parseObsHost('127.0.0.1:').port).toBeNull()
  })

  it('is total: never throws on blank or garbage input', () => {
    expect(parseObsHost('')).toEqual({ secure: false, hostname: '', port: null })
    expect(parseObsHost('   ')).toEqual({ secure: false, hostname: '', port: null })
    expect(() => parseObsHost('://:::@@@///')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildObsUrl
// ---------------------------------------------------------------------------

describe('buildObsUrl', () => {
  it('builds the ordinary ws://host:port', () => {
    expect(buildObsUrl('127.0.0.1', 4455)).toBe('ws://127.0.0.1:4455')
    expect(buildObsUrl('obs-pc', 4455)).toBe('ws://obs-pc:4455')
  })

  it('trims the host', () => {
    expect(buildObsUrl('  127.0.0.1  ', 4455)).toBe('ws://127.0.0.1:4455')
  })

  it('substitutes the default host when the field is blank', () => {
    expect(buildObsUrl('', 4455)).toBe(`ws://${DEFAULT_OBS_HOST}:4455`)
    expect(buildObsUrl('   ', 4455)).toBe(`ws://${DEFAULT_OBS_HOST}:4455`)
  })

  it('brackets a bare IPv6 literal, and does not double-bracket one that already is', () => {
    expect(buildObsUrl('::1', 4455)).toBe('ws://[::1]:4455')
    expect(buildObsUrl('[::1]', 4455)).toBe('ws://[::1]:4455')
  })

  it('honours a scheme the user pasted', () => {
    expect(buildObsUrl('ws://192.168.0.5', 4455)).toBe('ws://192.168.0.5:4455')
    expect(buildObsUrl('wss://obs.example.com', 4455)).toBe('wss://obs.example.com:4455')
    // https implies TLS, so it must not silently downgrade to plain ws.
    expect(buildObsUrl('https://obs.example.com', 4455)).toBe('wss://obs.example.com:4455')
  })

  it('lets a port inside the host win over the port argument', () => {
    expect(buildObsUrl('192.168.0.5:4456', 4455)).toBe('ws://192.168.0.5:4456')
    expect(buildObsUrl('ws://192.168.0.5:4456', 4455)).toBe('ws://192.168.0.5:4456')
  })

  it('falls back to the default port for out-of-range or non-integer ports', () => {
    expect(buildObsUrl('127.0.0.1', 0)).toBe(`ws://127.0.0.1:${DEFAULT_OBS_PORT}`)
    expect(buildObsUrl('127.0.0.1', 65_536)).toBe(`ws://127.0.0.1:${DEFAULT_OBS_PORT}`)
    expect(buildObsUrl('127.0.0.1', Number.NaN)).toBe(`ws://127.0.0.1:${DEFAULT_OBS_PORT}`)
    expect(buildObsUrl('127.0.0.1', 4455.5)).toBe(`ws://127.0.0.1:${DEFAULT_OBS_PORT}`)
  })

  it('always produces something a WebSocket constructor accepts', () => {
    const hosts = ['', '127.0.0.1', 'localhost', '::1', '[::1]:4455', 'ws://obs-pc:4460', 'wss://obs.example.com/']
    for (const host of hosts) {
      const url = buildObsUrl(host, 4455)
      expect(url).toMatch(/^wss?:\/\/[^\s]+:\d+$/)
      expect(() => new URL(url)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// isLocalHost
// ---------------------------------------------------------------------------

describe('isLocalHost', () => {
  it('accepts the three canonical loopback spellings', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('127.0.0.1')).toBe(true)
    expect(isLocalHost('::1')).toBe(true)
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(isLocalHost('  LOCALHOST  ')).toBe(true)
    expect(isLocalHost('LocalHost.')).toBe(true)
  })

  it('accepts the whole 127.0.0.0/8 loopback block', () => {
    expect(isLocalHost('127.0.0.2')).toBe(true)
    expect(isLocalHost('127.1.2.3')).toBe(true)
  })

  it('accepts the expanded and IPv4-mapped IPv6 loopback forms', () => {
    expect(isLocalHost('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isLocalHost('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true)
    expect(isLocalHost('::ffff:127.0.0.1')).toBe(true)
  })

  it('treats a blank host as local, because blank means "use the default"', () => {
    expect(isLocalHost('')).toBe(true)
    expect(isLocalHost('   ')).toBe(true)
    expect(isLocalHost(DEFAULT_OBS_HOST)).toBe(true)
  })

  it('sees through a scheme, a port and brackets', () => {
    expect(isLocalHost('ws://127.0.0.1:4455')).toBe(true)
    expect(isLocalHost('[::1]:4455')).toBe(true)
    expect(isLocalHost('ws://192.168.0.5:4455')).toBe(false)
  })

  it('calls anything non-loopback remote, including this machine’s own LAN address', () => {
    // Conservative on purpose: a false positive here makes clip-library resolve a
    // remote path against the local filesystem and rename the wrong file.
    expect(isLocalHost('192.168.0.5')).toBe(false)
    expect(isLocalHost('10.0.0.7')).toBe(false)
    expect(isLocalHost('obs-pc')).toBe(false)
    expect(isLocalHost('obs.example.com')).toBe(false)
  })

  it('does not mistake near-miss addresses for loopback', () => {
    expect(isLocalHost('128.0.0.1')).toBe(false)
    expect(isLocalHost('27.0.0.1')).toBe(false)
    expect(isLocalHost('1270.0.1')).toBe(false)
    expect(isLocalHost('127.0.0.1.example.com')).toBe(false)
    expect(isLocalHost('mylocalhost')).toBe(false)
    expect(isLocalHost('localhost.evil.com')).toBe(false)
    expect(isLocalHost('0.0.0.0')).toBe(false)
    expect(isLocalHost('::2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// obsErrorCode / obsErrorMessage
// ---------------------------------------------------------------------------

describe('obsErrorCode', () => {
  it('reads the code off an obs-websocket error', () => {
    expect(obsErrorCode(obsError(4009, 'Authentication failed.'))).toBe(4009)
    expect(obsErrorCode(obsError(-1, 'connect ECONNREFUSED'))).toBe(-1)
  })

  it('returns null for anything without a finite numeric code', () => {
    expect(obsErrorCode(new Error('boom'))).toBeNull()
    expect(obsErrorCode({ code: 'ECONNREFUSED' })).toBeNull()
    expect(obsErrorCode({ code: Number.NaN })).toBeNull()
    expect(obsErrorCode(null)).toBeNull()
    expect(obsErrorCode(undefined)).toBeNull()
    expect(obsErrorCode('nope')).toBeNull()
    expect(obsErrorCode(42)).toBeNull()
  })
})

describe('obsErrorMessage', () => {
  it('reads Error.message, a bare string, or falls back to empty', () => {
    expect(obsErrorMessage(new Error('  boom  '))).toBe('boom')
    expect(obsErrorMessage(obsError(4009, 'Authentication failed.'))).toBe('Authentication failed.')
    expect(obsErrorMessage('plain string')).toBe('plain string')
    expect(obsErrorMessage({})).toBe('')
    expect(obsErrorMessage(null)).toBe('')
    expect(obsErrorMessage(undefined)).toBe('')
    expect(obsErrorMessage({ message: 123 })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// classifyObsFailure
// ---------------------------------------------------------------------------

describe('classifyObsFailure', () => {
  it('maps close code 4009 to auth-failed, whatever the reason string says', () => {
    expect(classifyObsFailure(obsError(4009, 'Authentication failed.'))).toBe('auth-failed')
    expect(classifyObsFailure(obsError(4009, ''))).toBe('auth-failed')
    // The close code is authoritative: a misleading reason must not win.
    expect(classifyObsFailure(obsError(4009, 'connect ECONNREFUSED 127.0.0.1:4455'))).toBe('auth-failed')
  })

  it('maps close code 4010 to unsupported-rpc-version', () => {
    expect(classifyObsFailure(obsError(4010, 'Unsupported RPC version'))).toBe('unsupported-rpc-version')
  })

  it('maps clean and server-initiated closes to closed-by-obs', () => {
    expect(classifyObsFailure(obsError(1000, ''))).toBe('closed-by-obs')
    expect(classifyObsFailure(obsError(1001, 'going away'))).toBe('closed-by-obs')
    expect(classifyObsFailure(obsError(4011, 'Session invalidated'))).toBe('closed-by-obs')
  })

  it('detects a refused connection from the node error code', () => {
    // What ws surfaces when OBS is not running or the websocket server is disabled.
    expect(classifyObsFailure(obsError(-1, 'connect ECONNREFUSED 127.0.0.1:4455'))).toBe('connection-refused')
    expect(classifyObsFailure(new Error('connect ECONNREFUSED ::1:4455'))).toBe('connection-refused')
  })

  it('detects an abnormal close with no reason as a refused connection', () => {
    // 1006 with an empty reason is what both `ws` and browsers produce when the TCP
    // connection never came up at all.
    expect(classifyObsFailure(obsError(1006, ''))).toBe('connection-refused')
  })

  it('detects timeouts', () => {
    expect(classifyObsFailure(obsError(-1, 'connect ETIMEDOUT 192.168.0.5:4455'))).toBe('timeout')
    expect(classifyObsFailure(new Error('ETIMEDOUT'))).toBe('timeout')
    expect(classifyObsFailure(new Error('The operation timed out'))).toBe('timeout')
  })

  it('detects unreachable and unresolvable hosts', () => {
    expect(classifyObsFailure(new Error('getaddrinfo ENOTFOUND obs-pc'))).toBe('host-unreachable')
    expect(classifyObsFailure(new Error('connect EHOSTUNREACH 192.168.0.5:4455'))).toBe('host-unreachable')
    expect(classifyObsFailure(new Error('getaddrinfo EAI_AGAIN obs-pc'))).toBe('host-unreachable')
  })

  it('treats a reset socket as a close rather than a refusal', () => {
    expect(classifyObsFailure(new Error('read ECONNRESET'))).toBe('closed-by-obs')
  })

  it('falls back to unknown, and never throws for hostile input', () => {
    expect(classifyObsFailure(obsError(-1, 'Server sent an invalid subprotocol'))).toBe('unknown')
    expect(classifyObsFailure(null)).toBe('unknown')
    expect(classifyObsFailure(undefined)).toBe('unknown')
    expect(classifyObsFailure({})).toBe('unknown')
    expect(classifyObsFailure(Symbol('x'))).toBe('unknown')
  })

  it('does not match an error code that is merely a substring of another word', () => {
    // Whole-word matching: "PRECONNECTED" must not read as ECONNREFUSED-ish.
    expect(classifyObsFailure(new Error('WEBSOCKETIMEDOUTX'))).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// describeObsFailure
// ---------------------------------------------------------------------------

describe('describeObsFailure', () => {
  it('tells the user OBS may not be running when the connection is refused', () => {
    const message = describeObsFailure(obsError(-1, 'connect ECONNREFUSED 127.0.0.1:4455'), '127.0.0.1', 4455)
    expect(message).toContain('127.0.0.1:4455')
    expect(message).toContain('OBS Studio is running')
    expect(message).toContain('WebSocket Server Settings')
  })

  it('names the password as the problem on an auth failure, and never echoes it', () => {
    const message = describeObsFailure(obsError(4009, 'Authentication failed.'), '127.0.0.1', 4455)
    expect(message).toContain('password')
    expect(message).not.toContain('hunter2')
  })

  it('says "timed out" for a timeout', () => {
    const message = describeObsFailure(new Error('connect ETIMEDOUT 192.168.0.5:4455'), '192.168.0.5', 4455)
    expect(message).toContain('Timed out')
    expect(message).toContain('192.168.0.5:4455')
  })

  it('distinguishes the three cases the task calls out', () => {
    const refused = describeObsFailure(obsError(-1, 'connect ECONNREFUSED 127.0.0.1:4455'), '127.0.0.1', 4455)
    const auth = describeObsFailure(obsError(4009, 'Authentication failed.'), '127.0.0.1', 4455)
    const timeout = describeObsFailure(new Error('ETIMEDOUT'), '127.0.0.1', 4455)
    expect(new Set([refused, auth, timeout]).size).toBe(3)
  })

  it('mentions the required RPC version when OBS is too old', () => {
    const message = describeObsFailure(obsError(4010, 'Unsupported RPC version'), '127.0.0.1', 4455)
    expect(message).toContain(String(OBS_RPC_VERSION))
    expect(message).toContain('Update OBS Studio')
  })

  it('explains a close as OBS having gone away', () => {
    expect(describeObsFailure(obsError(1000, ''), '127.0.0.1', 4455)).toContain('closed the connection')
  })

  it('substitutes the default host when the configured one is blank', () => {
    expect(describeObsFailure(obsError(1006, ''), '', 4455)).toContain(`${DEFAULT_OBS_HOST}:4455`)
  })

  it('is total: always returns a non-empty sentence, even with no detail at all', () => {
    for (const error of [null, undefined, {}, new Error(''), 'x']) {
      const message = describeObsFailure(error, '127.0.0.1', 4455)
      expect(message.length).toBeGreaterThan(0)
      expect(message).toContain('127.0.0.1:4455')
    }
    expect(describeObsFailure(new Error(''), '127.0.0.1', 4455)).toContain('no reason given')
  })
})

// ---------------------------------------------------------------------------
// mapRequestFailure
// ---------------------------------------------------------------------------

describe('mapRequestFailure', () => {
  it('maps RequestStatus 501 on a replay-buffer request to buffer-inactive', () => {
    const error = mapRequestFailure('SaveReplayBuffer', obsError(501, 'Output not running'))
    expect(error.kind).toBe('buffer-inactive')
    expect(error.message).toContain('replay buffer is not running')
  })

  it('maps 501 on GetReplayBufferStatus to buffer-inactive too', () => {
    expect(mapRequestFailure('GetReplayBufferStatus', obsError(501, '')).kind).toBe('buffer-inactive')
  })

  it('does NOT claim buffer-inactive for a 501 on an unrelated request', () => {
    // 501 means "that output is not running"; only a replay-buffer request lets us
    // conclude anything about the replay buffer.
    const error = mapRequestFailure('StopRecord', obsError(501, 'Output not running'))
    expect(error.kind).toBe('request-failed')
  })

  it('maps close code 4009 to auth-failed', () => {
    expect(mapRequestFailure('GetVersion', obsError(4009, 'Authentication failed.')).kind).toBe('auth-failed')
  })

  it('falls back to request-failed, carrying the code and the request name', () => {
    const error = mapRequestFailure('SaveReplayBuffer', obsError(205, 'Generic error'))
    expect(error).toMatchObject({ kind: 'request-failed', code: 205, requestType: 'SaveReplayBuffer' })
    expect(error.message).toContain('SaveReplayBuffer')
    expect(error.message).toContain('205')
    expect(error.message).toContain('Generic error')
  })

  it('handles an error with no code and no message', () => {
    const error = mapRequestFailure('SaveReplayBuffer', {})
    expect(error).toMatchObject({ kind: 'request-failed', code: null, requestType: 'SaveReplayBuffer' })
    expect(error.message).toContain('SaveReplayBuffer')
  })

  it('is total: never throws for hostile input', () => {
    for (const value of [null, undefined, 0, 'boom', Symbol('x'), []]) {
      expect(() => mapRequestFailure('SaveReplayBuffer', value)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// backoffDelayMs
// ---------------------------------------------------------------------------

describe('backoffDelayMs', () => {
  it('doubles from the base and then holds at the cap', () => {
    expect(backoffDelayMs(1)).toBe(1_000)
    expect(backoffDelayMs(2)).toBe(2_000)
    expect(backoffDelayMs(3)).toBe(4_000)
    expect(backoffDelayMs(4)).toBe(8_000)
    expect(backoffDelayMs(5)).toBe(16_000)
    expect(backoffDelayMs(6)).toBe(DEFAULT_BACKOFF.maxMs)
    expect(backoffDelayMs(7)).toBe(DEFAULT_BACKOFF.maxMs)
  })

  it('never exceeds the cap, however many attempts have failed', () => {
    for (const attempt of [8, 20, 100, 1_000, 100_000]) {
      expect(backoffDelayMs(attempt)).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs)
    }
  })

  it('does not overflow to Infinity when the exponent gets large', () => {
    // 2 ** 5000 is Infinity; the result must still be a finite, capped delay.
    const delay = backoffDelayMs(5_000)
    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBe(DEFAULT_BACKOFF.maxMs)
  })

  it('treats attempt 0 and negatives as the first attempt', () => {
    expect(backoffDelayMs(0)).toBe(1_000)
    expect(backoffDelayMs(-5)).toBe(1_000)
  })

  it('honours a custom curve', () => {
    const curve = { baseMs: 250, factor: 3, maxMs: 5_000 }
    expect(backoffDelayMs(1, curve)).toBe(250)
    expect(backoffDelayMs(2, curve)).toBe(750)
    expect(backoffDelayMs(3, curve)).toBe(2_250)
    expect(backoffDelayMs(4, curve)).toBe(5_000)
  })

  it('never returns more than the cap even when the base already exceeds it', () => {
    expect(backoffDelayMs(1, { baseMs: 9_000, factor: 2, maxMs: 1_000 })).toBe(1_000)
  })

  it('is total: falls back to sane values for NaN, Infinity and nonsense curves', () => {
    expect(Number.isFinite(backoffDelayMs(Number.NaN))).toBe(true)
    expect(Number.isFinite(backoffDelayMs(Number.POSITIVE_INFINITY))).toBe(true)
    expect(Number.isFinite(backoffDelayMs(3, { baseMs: Number.NaN, factor: 2, maxMs: 10_000 }))).toBe(true)
    expect(Number.isFinite(backoffDelayMs(3, { baseMs: 1_000, factor: Number.NaN, maxMs: 10_000 }))).toBe(true)
    expect(Number.isFinite(backoffDelayMs(3, { baseMs: 1_000, factor: 2, maxMs: Number.NaN }))).toBe(true)
    // factor < 1 would shrink the delay; it is pinned to 1 (constant retry interval).
    expect(backoffDelayMs(5, { baseMs: 1_000, factor: 0.5, maxMs: 10_000 })).toBe(1_000)
  })

  it('always returns a non-negative integer', () => {
    for (let attempt = 0; attempt <= 12; attempt++) {
      const delay = backoffDelayMs(attempt)
      expect(Number.isInteger(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(0)
    }
  })
})
