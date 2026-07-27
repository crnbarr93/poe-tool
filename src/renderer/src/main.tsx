/**
 * src/renderer/src/main.tsx
 * =========================
 *
 * Renderer entry point. Referenced by `src/renderer/index.html`.
 *
 * `StrictMode` is on deliberately. It double-invokes effects in development, so any
 * subscription that forgets to return its `unsubscribe()` shows up immediately as
 * duplicated rows in the event feed rather than as a slow leak. Every hook in
 * `./hooks` is written to survive that.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './styles.css'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('poe-tool renderer: #root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
