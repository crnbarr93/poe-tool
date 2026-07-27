/**
 * src/main/events/event-bus.ts
 * ===========================
 *
 * The application event bus: a {@link TypedEmitter} over the frozen `PoeEventMap`,
 * plus the ONE piece of behaviour that does not belong in a generic emitter - the
 * fan-out rule that turns a single {@link ParseResult} into the right set of channel
 * emissions.
 *
 * RULES FOR THIS FILE:
 *  - No `electron`, no `node:*`. It runs under plain node, under vitest and inside
 *    the `tail:debug` build (`tsconfig.tools.json` includes `src/main/events/**`).
 *  - No `any`, no `@ts-ignore`.
 *
 *
 * WHY FAN-OUT LIVES HERE AND NOT ONLY IN THE WATCHER
 * --------------------------------------------------
 * `LogWatcher` can fan out by itself (its `#fanOut`), and does when no `publish`
 * override is supplied - that is what keeps the watcher unit-testable against a bare
 * `TypedEmitter`. But in the assembled app there is exactly one place that should own
 * "what does publishing an event MEAN", because more than one producer can exist:
 * the live tail, `LogWatcher.replay()` driving the debug CLI, and (later) any
 * synthetic/replayed source. `src/main/index.ts` therefore wires the watcher with
 * `publish: (result) => bus.publish(result)` so every producer goes through the same
 * code path and the ring buffer behind `events:recent` cannot see a different stream
 * than the renderer's push feed.
 *
 * The rule itself is the one documented on `PoeEventMap`:
 *  - every recognised event -> `event` AND its per-type channel;
 *  - a death additionally -> `death:self` when `isSelf`, so the replay clipper never
 *    has to know the character-name setting exists;
 *  - an unrecognised line -> `unmatched` and nowhere else.
 *
 * TWO THINGS THIS RULE DELIBERATELY DOES NOT DO, both of them about the same
 * `DeathEvent` field:
 *  - it does not filter SUICIDES off `death` or `death:self`. PoE's `/kill` is a real
 *    death and it counts; it just must never become a clip. The clipper filters on
 *    `cause` itself (see `DeathCause`), because the bus's job is to report what
 *    happened, not to decide what is interesting - and the event feed, the death
 *    count and any future stats all want the suicide.
 *  - it does not give `level-up` a `:self` variant. A level-up is the evidence that
 *    ESTABLISHES who "self" is, so filtering it on the current answer would make
 *    detection unable to bootstrap: with nothing detected yet, nothing would pass,
 *    so nothing would ever be detected.
 *
 *
 * A THROWING LISTENER MUST NOT KILL THE TAIL LOOP
 * -----------------------------------------------
 * `TypedEmitter.emit` deliberately propagates a listener's exception to the emitter
 * (see its header), and the emitter here is called from inside a `setInterval`
 * callback - where an uncaught throw takes the Electron main process down. So
 * {@link PoeEventBus.publish} and {@link PoeEventBus.safeEmit} contain the throw
 * PER CHANNEL and report it through {@link PoeEventBusOptions.onListenerError}.
 *
 * Per channel, not once around the whole fan-out: a listener that throws on `event`
 * (say, a dead renderer window) must not also rob `death:self` - and therefore the
 * clipper - of the same event.
 *
 * The RAW inherited `emit` is left untouched and still propagates, because callers
 * that are not on the critical path (tests, tools) benefit from a loud failure.
 */

import type { ParseResult, PoeEventChannel, PoeEventMap } from '../../shared/events'
import { TypedEmitter } from './typed-emitter'

/** Constructor extras. All optional; the default is silence. */
export interface PoeEventBusOptions {
  /**
   * Called with anything a listener threw during {@link PoeEventBus.publish} or
   * {@link PoeEventBus.safeEmit}, together with the channel it happened on.
   *
   * There is no `error` CHANNEL on the bus on purpose (see `PoeEventMap`), so this
   * callback is the only way a swallowed listener failure surfaces. Wire it to a
   * logger in `src/main/index.ts`; leave it out in tests that do not care.
   *
   * Purely diagnostic: a hook that itself throws is ignored, because a logger must
   * never be the reason the main process dies.
   */
  readonly onListenerError?: (error: unknown, channel: PoeEventChannel) => void
}

/**
 * The application event bus.
 *
 * ```ts
 * const bus = new PoeEventBus({ onListenerError: (e, ch) => log.error(ch, e) })
 * bus.on('death:self', (death) => clipper.handleDeath(death))
 * const watcher = new LogWatcher({ bus, getSettings, publish: (r) => bus.publish(r) })
 * ```
 *
 * Everything `TypedEmitter` offers (`on` / `once` / `off` / `emit` /
 * `removeAllListeners` / `listenerCount`) is inherited unchanged and stays fully
 * typed against `PoeEventMap`. This class adds only {@link publish} and
 * {@link safeEmit}.
 */
export class PoeEventBus extends TypedEmitter<PoeEventMap> {
  readonly #onListenerError: (error: unknown, channel: PoeEventChannel) => void

  constructor(options: PoeEventBusOptions = {}) {
    super()
    this.#onListenerError = options.onListenerError ?? ((): void => undefined)
  }

  /**
   * Fans one parse result out across the bus per the `PoeEventMap` contract.
   *
   * NEVER THROWS. Every emission is individually contained - see the file header.
   * That contract is what lets `LogWatcher` call this straight from a `setInterval`
   * callback, and nothing added to this switch may weaken it: every arm must go
   * through {@link safeEmit}, never through the inherited `emit`.
   *
   * The switch has no `default`. A new `PoeEvent` variant therefore compiles here
   * and is published on `event` but not on its own channel - which is the failure
   * this method's test file exists to catch, since TypeScript cannot: `PoeEventMap`
   * is a hand-written map and nothing structurally ties it to the event union.
   */
  publish(result: ParseResult): void {
    if (result.type === 'unmatched') {
      this.safeEmit('unmatched', result)
      return
    }

    this.safeEmit('event', result)

    switch (result.type) {
      case 'death':
        // Suicides included, on BOTH channels: `death:self` is filtered by WHOSE
        // death it is, never by whether the death is worth watching.
        this.safeEmit('death', result)
        if (result.isSelf) this.safeEmit('death:self', result)
        break
      case 'zone-entered':
        this.safeEmit('zone-entered', result)
        break
      case 'area-generated':
        this.safeEmit('area-generated', result)
        break
      case 'level-up':
        // Everyone's level-ups, ours included and unfiltered - see the file header.
        // The character tracker does NOT listen here; `LogWatcher` hands it level-ups
        // directly so that detection cannot be starved by a throwing listener and is
        // current before the next line is parsed.
        this.safeEmit('level-up', result)
        break
    }
  }

  /**
   * `emit` with a throwing listener contained and reported.
   *
   * @returns whatever `emit` returned, or `false` when a listener threw - "did
   * anyone handle this cleanly?", which is a diagnostic, never control flow.
   */
  safeEmit<K extends keyof PoeEventMap>(channel: K, ...args: PoeEventMap[K]): boolean {
    try {
      return this.emit(channel, ...args)
    } catch (error) {
      this.#report(error, channel)
      return false
    }
  }

  /** Reports a swallowed failure. Infallible by construction - it is the last resort. */
  #report(error: unknown, channel: PoeEventChannel): void {
    try {
      this.#onListenerError(error, channel)
    } catch {
      // A throwing error reporter is the end of the road. Crashing the tail loop is
      // the one outcome this whole file exists to prevent.
    }
  }
}
