/**
 * src/preload/index.ts
 * ====================
 *
 * The context bridge. Runs in an isolated world with node integration OFF and
 * `contextIsolation` ON, and is the ONLY thing the renderer can reach the main
 * process through.
 *
 *
 * WHY THERE IS NO GENERIC `invoke(channel, ...args)` ON THE BRIDGE
 * ----------------------------------------------------------------
 * Exposing `ipcRenderer` - or a passthrough that forwards an arbitrary channel name -
 * would make `contextIsolation` decorative. Any script that ends up running in the
 * renderer (a supply-chain compromise in a dev dependency, a stray CDN tag, devtools)
 * could then reach EVERY channel electron has registered, including internal ones.
 * So {@link PoeToolApi} names each operation, the internal {@link invoke} helper is
 * module-private, and the channel constants never leave this file.
 *
 * The functions handed across the bridge are the only capability the renderer gets.
 * That is also why the renderer never receives a "send arbitrary IPC" primitive even
 * for push channels: it subscribes, it does not emit.
 *
 *
 * WHY EVERY SUBSCRIBE RETURNS AN UNSUBSCRIBE
 * ------------------------------------------
 * React 19 in StrictMode mounts every component, unmounts it, and mounts it again in
 * development. An effect that calls `window.poeTool.onEvent(...)` therefore runs
 * twice, and without a matching removal the second registration is permanently
 * orphaned - the listener is unreachable but still fires, so the feed shows every
 * event twice and the leak compounds on every hot reload. Each subscriber here closes
 * over the exact handler it registered and removes THAT reference, so unsubscribing
 * one subscription can never detach another component's.
 *
 *
 * THE ONE TYPE ASSERTION IN THIS FILE
 * -----------------------------------
 * `ipcRenderer.invoke` is typed `Promise<any>`. Its result is captured as `unknown`
 * (so no `any` escapes into the renderer's types) and asserted to the contract's
 * result type exactly once, in {@link invoke}. That assertion is a statement of trust
 * in the MAIN process, which is the correct direction: main validates everything the
 * renderer sends, the renderer trusts what main returns. The reverse - runtime-
 * validating main's replies here - would need a schema library, which the frozen
 * dependency set does not include, to defend against a threat (a compromised main
 * process) that already owns the whole application.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  IPC_INVOKE,
  IPC_PUSH,
  POE_TOOL_API_KEY,
  type IpcInvokeArgs,
  type IpcInvokeChannel,
  type IpcInvokeResult,
  type IpcPushChannel,
  type IpcPushPayload,
  type PoeToolApi,
  type Unsubscribe
} from '../shared/ipc'

// ---------------------------------------------------------------------------
// Internal plumbing - never exposed
// ---------------------------------------------------------------------------

/**
 * Typed wrapper over `ipcRenderer.invoke`.
 *
 * Generic over the channel, so the argument tuple and the resolved type both come
 * from {@link IpcInvokeContract}: passing the wrong payload, or forgetting one, is a
 * compile error here rather than an `undefined` in a main-process handler.
 */
async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeArgs<C>
): Promise<IpcInvokeResult<C>> {
  // Captured as `unknown` first: `invoke` returns `Promise<any>`, and letting that
  // `any` flow into the return position would silently disable checking at every
  // renderer call site.
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  return result as IpcInvokeResult<C>
}

/**
 * Subscribes to a push channel and returns the matching detach function.
 *
 * The wrapper drops the `IpcRendererEvent` first argument deliberately: it carries
 * `sender`, `ports` and `senderId`, none of which the renderer has any business
 * touching, and forwarding it would widen the bridge for no benefit.
 *
 * The `detached` latch makes a double-unsubscribe a no-op. `removeListener` matches
 * by reference and each call to this function allocates a fresh `handler`, so a
 * second removal could not detach someone else's listener anyway - but a React effect
 * cleanup that runs twice should cost nothing, and the latch says so explicitly.
 */
function subscribe<C extends IpcPushChannel>(
  channel: C,
  listener: (payload: IpcPushPayload<C>) => void
): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: IpcPushPayload<C>): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, handler)

  let detached = false
  return (): void => {
    if (detached) return
    detached = true
    ipcRenderer.removeListener(channel, handler)
  }
}

// ---------------------------------------------------------------------------
// The exposed surface
// ---------------------------------------------------------------------------

/**
 * The object the renderer sees as `window.poeTool`.
 *
 * Annotated as {@link PoeToolApi} rather than inferred, so that a channel whose
 * contract changes breaks HERE - at the bridge - instead of at whichever component
 * happens to consume it.
 *
 * Everything crossing the bridge is structured-clone safe. `PoeEvent.meta.timestamp`
 * is a real `Date` and survives both the bridge and IPC; a `Map`, a class instance or
 * a function inside a payload would not, which is why `src/shared/ipc.ts` forbids
 * them.
 */
const api: PoeToolApi = {
  getSettings: () => invoke(IPC_INVOKE.SETTINGS_GET),
  setSettings: (patch) => invoke(IPC_INVOKE.SETTINGS_SET, patch),
  testObs: (params) => invoke(IPC_INVOKE.OBS_TEST, params),
  getObsStatus: () => invoke(IPC_INVOKE.OBS_STATUS),
  autodetectLogPaths: () => invoke(IPC_INVOKE.LOG_AUTODETECT),
  getLogStatus: () => invoke(IPC_INVOKE.LOG_STATUS),
  getRecentEvents: () => invoke(IPC_INVOKE.EVENTS_RECENT),
  getRecentClips: () => invoke(IPC_INVOKE.CLIPS_RECENT),
  getActiveCharacter: () => invoke(IPC_INVOKE.CHARACTER_ACTIVE),
  getCharacterSuggestions: () => invoke(IPC_INVOKE.CHARACTER_SUGGESTIONS),

  onEvent: (listener) => subscribe(IPC_PUSH.EVENT, listener),
  onStatus: (listener) => subscribe(IPC_PUSH.STATUS, listener),
  onObsStatus: (listener) => subscribe(IPC_PUSH.OBS_STATUS, listener),
  onClip: (listener) => subscribe(IPC_PUSH.CLIP, listener),
  onCharacter: (listener) => subscribe(IPC_PUSH.CHARACTER, listener)
}

// Not wrapped in a try/catch: `exposeInMainWorld` only throws when
// `contextIsolation` is off, which is a bootstrap misconfiguration in
// `src/main/index.ts`. Swallowing it would turn a loud, immediately diagnosable
// preload error into a renderer that silently sees `window.poeTool === undefined`.
contextBridge.exposeInMainWorld(POE_TOOL_API_KEY, api)
