import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('./', import.meta.url));
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Serve the service worker at `/sw.js` during development.
 *
 * A worker may only claim a scope at or below its own script path, and a
 * browser will not widen that scope without a `Service-Worker-Allowed` header.
 * Serving the transformed worker from the site root in dev — exactly where the
 * build emits it — means the registration code is identical in both modes.
 */
function devServiceWorker(): Plugin {
  return {
    name: 'cq3000:dev-service-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/sw.js') return next();
        server
          .transformRequest('/src/vfs/sw.ts')
          .then((result) => {
            if (!result) return next();
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-store');
            res.end(result.code);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  root,
  // Relative base so one build works at an origin root and at a GitHub Pages
  // project subpath (`https://<user>.github.io/<repo>/`). Everything that needs
  // an absolute path derives it at runtime from the service worker's scope.
  base: './',
  // Multi-page: the landing page and the Neuroglancer client are separate
  // documents on the same origin, so both reach the virtual filesystem with no
  // cross-origin machinery.
  appType: 'mpa',
  plugins: [devServiceWorker()],
  build: {
    // Neuroglancer ships modern syntax and relies on module workers.
    target: 'esnext',
    rollupOptions: {
      input: {
        portal: at('index.html'),
        neuroglancer: at('neuroglancer/index.html'),
        sw: at('src/vfs/sw.ts'),
      },
      output: {
        // The worker must sit at the deployment root to claim the whole site.
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // Neuroglancer's sources use Vite-specific `?raw` asset imports and the
    // package `imports` field; esbuild pre-bundling cannot handle either.
    exclude: ['neuroglancer'],
    // Excluding the package also excludes its dependencies, and Neuroglancer
    // pulls in a handful of CommonJS ones. Left unbundled they reach the
    // browser as CJS and its `default` import fails, which breaks `npm run dev`
    // — and only dev, since the production build converts them. Naming them
    // through their importer is Vite's hook for exactly this case.
    include: [
      'neuroglancer > codemirror',
      'neuroglancer > codemirror/addon/fold/brace-fold.js',
      'neuroglancer > codemirror/addon/fold/foldcode.js',
      'neuroglancer > codemirror/addon/fold/foldgutter.js',
      'neuroglancer > codemirror/addon/lint/lint.js',
      'neuroglancer > codemirror/mode/javascript/javascript.js',
      'neuroglancer > core-js/actual/symbol/dispose.js',
      'neuroglancer > core-js/actual/symbol/async-dispose.js',
      'neuroglancer > crc-32',
      'neuroglancer > msgpackr',
      'neuroglancer > nifti-reader-js',
    ],
  },
  server: {
    watch: { ignored: ['**/.nfs*'] },
  },
});
