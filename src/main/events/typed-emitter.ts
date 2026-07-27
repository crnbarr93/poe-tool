/**
 * FROZEN TYPE CONTRACT - src/main/events/typed-emitter.ts
 * ========================================================
 *
 * A zero-dependency, fully typed EventEmitter. Base class for
 * `src/main/events/event-bus.ts`.
 *
 * NO IMPORTS AT ALL - not even `node:events`. This file must run under plain node
 * and under vitest, and must never reach for `electron`.
 *
 *
 * WHY HAND-ROLLED RATHER THAN `extends EventEmitter<T>` FROM @types/node
 * ---------------------------------------------------------------------
 * The installed @types/node (26.x) does ship a generic `EventEmitter<T>`, but it
 * was rejected after actually compiling both options. Three findings:
 *
 * 1. CONSTRAINT INCOMPATIBILITY. Node types it as
 *    `EventEmitter<T extends EventMap<T>>` with `EventMap<T> = Record<keyof T, any[]>`
 *    - note the MUTABLE `any[]`. Our required constraint uses `readonly unknown[]`,
 *    and a readonly tuple is not assignable to `any[]`, so
 *    `class X<M extends Record<string, readonly unknown[]>> extends EventEmitter<M>`
 *    fails with:
 *      TS2344: Type 'M' does not satisfy the constraint 'EventMap<M>'.
 *
 * 2. IT DOES NOT REJECT UNKNOWN CHANNELS. Node's `EventNames<T, E>` includes the
 *    inferred `E` itself, so `emitter.on('totallyBogusChannel', (a, b) => {})`
 *    compiles clean and types `a`/`b` as `any`. That is exactly the class of bug
 *    this project's "no `any` in event types" rule exists to prevent - a typo'd
 *    channel name would silently never fire.
 *
 * 3. THE `'error'` LANDMINE. Node's EventEmitter THROWS the emitted value when
 *    `'error'` is emitted with no listeners attached. Emitting from inside the tail
 *    loop would then crash the main process. `PoeEventMap` deliberately has no
 *    `error` channel, and this implementation has no special-cased channel at all,
 *    so the hazard cannot be reintroduced by accident.
 *
 *
 * A NOTE ON THE GENERIC CONSTRAINT
 * --------------------------------
 * The constraint is `M extends EventArgsMap<M>` (i.e. `Record<keyof M, readonly unknown[]>`),
 * NOT `Record<string, readonly unknown[]>`. This is forced, not a preference:
 * TypeScript only grants implicit index signatures to type ALIASES, never to
 * interfaces, so `TypedEmitter<PoeEventMap>` against a plain `Record<string, ...>`
 * constraint fails with:
 *   TS2344: Index signature for type 'string' is missing in type 'PoeEventMap'.
 * The self-referential form accepts both interfaces and index-signature aliases, so
 * it is a strict superset. (This is the same technique @types/node uses.)
 */

/**
 * Shape of an event map: channel name -> the argument tuple emitted on it.
 *
 * Self-referential by design - see the note in the file header.
 */
export type EventArgsMap<M> = Record<keyof M, readonly unknown[]>

/** A listener for one channel, with arguments inferred from the map. */
export type EventListener<M extends EventArgsMap<M>, K extends keyof M> = (...args: M[K]) => void

/**
 * One registration. `once` entries are removed immediately before being invoked.
 *
 * ON THE `unknown` STORAGE TYPE: one list has to hold listeners for every channel
 * at once, so the per-channel signature must be erased somewhere. `unknown` is the
 * cheapest honest choice - every concrete listener widens into it with NO cast, and
 * `unknown` is the one type TypeScript lets you narrow back out of with a single
 * `as` instead of an `as unknown as` double-cast. (The tempting alternative,
 * `(...args: never[]) => void`, does NOT work here: under an unresolved generic,
 * `never[]` is not assignable to a tuple type like `M[K]`, so assignment fails in
 * both directions.) `any` would erase the signature too, but would also silently
 * disable checking at the call site - which this class exists to provide.
 */
interface ListenerEntry {
  /**
   * The ORIGINAL function as passed to `on`/`once` - never a wrapper. Storing the
   * original is what makes `off(channel, fn)` work for `once` listeners too, and
   * what makes reference equality the removal key.
   */
  readonly fn: unknown
  readonly once: boolean
}

/**
 * Typed event emitter.
 *
 * ```ts
 * const bus = new TypedEmitter<PoeEventMap>()
 * bus.on('death:self', (event) => { ... })   // event: DeathEvent, inferred
 * bus.emit('death:self', deathEvent)         // arity + types checked
 * bus.on('deth:self', () => {})              // compile error: not a channel
 * ```
 *
 * SEMANTICS (deliberately Node-like, so this stays unsurprising):
 *  - Listeners fire synchronously, in registration order.
 *  - Duplicate registrations of the same function are kept and fire multiple times;
 *    each `off` removes ONE registration.
 *  - The listener list is snapshotted before dispatch, so adding or removing
 *    listeners from inside a listener does not affect the in-flight emit.
 *  - A THROWING LISTENER PROPAGATES to the `emit` caller and later listeners are
 *    skipped. Callers on the critical path (the tail loop) must therefore wrap
 *    `emit` in try/catch, or the bus must be fed from a scheduled callback.
 *
 * NOT thread-safe/reentrancy-magic beyond the snapshot above; the main process is
 * single threaded, that is enough.
 */
export class TypedEmitter<M extends EventArgsMap<M>> {
  /**
   * channel -> registrations, in insertion order. An array (not a Set) because
   * order matters and duplicates are legal. Keys with an empty array are deleted
   * so `listenerCount` and cleanup stay trivial.
   */
  readonly #listeners = new Map<keyof M, ListenerEntry[]>()

  /** Registers `listener` for `channel`. Returns `this` for chaining. */
  on<K extends keyof M>(channel: K, listener: EventListener<M, K>): this {
    return this.#add(channel, listener, false)
  }

  /** Registers `listener` for `channel`, to be removed after its first invocation. */
  once<K extends keyof M>(channel: K, listener: EventListener<M, K>): this {
    return this.#add(channel, listener, true)
  }

  /**
   * Removes ONE registration of `listener` from `channel`, matching Node's
   * `removeListener`: the MOST RECENTLY added match is removed, and removing a
   * listener that was never registered is a silent no-op.
   */
  off<K extends keyof M>(channel: K, listener: EventListener<M, K>): this {
    const entries = this.#listeners.get(channel)
    if (entries === undefined) return this
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.fn === listener) {
        entries.splice(i, 1)
        break
      }
    }
    if (entries.length === 0) this.#listeners.delete(channel)
    return this
  }

  /**
   * Synchronously invokes every listener on `channel` with `args`.
   *
   * @returns true if the channel had at least one listener - useful for
   * "did anyone care?" diagnostics, never for control flow.
   */
  emit<K extends keyof M>(channel: K, ...args: M[K]): boolean {
    const entries = this.#listeners.get(channel)
    if (entries === undefined || entries.length === 0) return false

    // Snapshot: a listener may call on()/off()/removeAllListeners() on this same
    // channel, and that must not disturb the current dispatch.
    const snapshot = entries.slice()
    for (const entry of snapshot) {
      // Detach `once` listeners BEFORE invoking, so a listener that re-emits the
      // same channel cannot re-enter itself, and so a throwing listener is still
      // removed.
      if (entry.once) this.#remove(channel, entry)
      // Re-narrow the erased storage type. Safe by construction: #add is the only
      // writer, and it only ever stores an `EventListener<M, K>` under key `K`.
      const typed = entry.fn as EventListener<M, K>
      typed(...args)
    }
    return true
  }

  /**
   * Removes every listener on `channel`, or - when `channel` is omitted - every
   * listener on every channel.
   */
  removeAllListeners<K extends keyof M>(channel?: K): this {
    if (channel === undefined) {
      this.#listeners.clear()
    } else {
      this.#listeners.delete(channel)
    }
    return this
  }

  /**
   * Number of registrations on `channel`. When `listener` is supplied, counts only
   * registrations of that exact function (mirrors Node 19+).
   */
  listenerCount<K extends keyof M>(channel: K, listener?: EventListener<M, K>): number {
    const entries = this.#listeners.get(channel)
    if (entries === undefined) return 0
    if (listener === undefined) return entries.length
    let count = 0
    for (const entry of entries) {
      if (entry.fn === listener) count++
    }
    return count
  }

  /** Shared registration path for {@link on} and {@link once}. */
  #add<K extends keyof M>(channel: K, listener: EventListener<M, K>, once: boolean): this {
    // Widening into the erased storage type needs no cast - everything is `unknown`.
    const entry: ListenerEntry = { fn: listener, once }
    const entries = this.#listeners.get(channel)
    if (entries === undefined) {
      this.#listeners.set(channel, [entry])
    } else {
      entries.push(entry)
    }
    return this
  }

  /** Removes one entry by identity. Used by {@link emit} to detach `once` listeners. */
  #remove(channel: keyof M, entry: ListenerEntry): void {
    const entries = this.#listeners.get(channel)
    if (entries === undefined) return
    const index = entries.indexOf(entry)
    if (index !== -1) entries.splice(index, 1)
    if (entries.length === 0) this.#listeners.delete(channel)
  }
}
