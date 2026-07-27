/**
 * src/renderer/src/env.d.ts
 * =========================
 *
 * Ambient declarations for the renderer project (`tsconfig.web.json`).
 *
 * `window.poeTool` is whatever `src/preload/index.ts` handed to
 * `contextBridge.exposeInMainWorld` - a real object at runtime, but invisible to the
 * type system, because the preload script is a separate compilation unit that the
 * renderer never imports. This file is the bridge between the two: it re-states the
 * frozen {@link PoeToolApi} contract as a global, so a component calling
 * `window.poeTool.getSettings()` is checked against the same interface the preload is
 * checked against, with no `any` and no `as` at the call site.
 *
 * The declaration intentionally mirrors the one in `src/shared/ipc.ts` (which the
 * renderer project also compiles). Interface declaration merging accepts identical
 * members, and BOTH are wanted: the shared one keeps preload and renderer honest
 * about the same definition, this one makes the renderer project self-describing even
 * if the shared file's `declare global` block is ever narrowed to the node project.
 *
 * `vite/client` supplies `import.meta.env`, `import.meta.hot` and the asset-import
 * module declarations. `tsconfig.web.json` sets `"types": []` (so the renderer cannot
 * accidentally reach for `@types/node`), which suppresses automatic inclusion - hence
 * the explicit reference.
 */

/// <reference types="vite/client" />

import type { PoeToolApi } from '../../shared/ipc'

declare global {
  interface Window {
    /**
     * The narrow, typed main-process surface exposed by the preload bridge.
     *
     * `readonly` because the bridge object is frozen by `contextBridge` - assigning to
     * it from renderer code fails silently at runtime, so it should fail loudly at
     * compile time.
     *
     * ALWAYS present in a correctly-booted app: the preload script runs before any
     * renderer code, and if `exposeInMainWorld` failed the app is broken in a way no
     * optional-chaining check could paper over.
     */
    readonly poeTool: PoeToolApi
  }
}
