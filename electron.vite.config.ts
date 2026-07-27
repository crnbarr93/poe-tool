import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * DEFAULT-IMPORT INTEROP FOR EXTERNALISED CJS DEPENDENCIES
 * =======================================================
 * `externalizeDepsPlugin()` leaves `obs-websocket-js` as a bare `require()` in the
 * bundle. Rollup 4's DEFAULT `output.interop` is `"default"`, which assumes
 * `require('x')` returns the default export itself. That is wrong for this package:
 * its CJS build sets `__esModule: true` and puts the class on `.default`, so
 * `import OBSWebSocket from 'obs-websocket-js'` compiled down to
 * `const OBSWebSocket = require('obs-websocket-js')` and `new OBSWebSocket()` threw
 *
 *   TypeError: OBSWebSocket is not a constructor
 *
 * at the first connect attempt - in the PACKAGED BUILD ONLY. Neither `tsc` (which
 * has `esModuleInterop: true`) nor vitest (which resolves the package's `import`
 * condition to real ESM) can see this, which is exactly why it survived to runtime.
 *
 * `"auto"` restores the `__esModule`-aware unwrapping that TypeScript and Babel
 * emit, so a package works the same whether it is CJS, ESM or dual-published.
 */
const interop = 'auto' as const

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: { interop }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: { interop }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
