/**
 * Same-origin Neuroglancer client.
 *
 * This is stock Neuroglancer: `setupDefaultViewer` installs the upstream
 * `UrlHashBinding`, so the viewer state is driven entirely by the `#!{...}`
 * fragment the landing page builds (see `src/integrations/neuroglancer.ts`),
 * with `zarr://` sources pointing at the service worker's `_zarr/` namespace.
 *
 * Because this page is served from the site's own origin, those virtual URLs
 * are same-origin and need no CORS handling and no upstream patch.
 */
// Upstream's entry point. This is what registers the layer types, the data
// sources (`zarr://`) and the key-value stores (`http://`) — `setupDefaultViewer`
// builds the UI but registers none of them. Without this import every source
// fails with "Unsupported scheme: zarr:".
import 'neuroglancer';
import 'neuroglancer/unstable/ui/default_viewer.css';
import { setupDefaultViewer } from 'neuroglancer/unstable/ui/default_viewer_setup.js';

function start(): void {
  setupDefaultViewer({
    target: document.getElementById('neuroglancer-container') ?? undefined,
    // Hide the layer bar — the row of layer-name tabs above the panels. The
    // page decides what is open before the viewer starts, and a plate's layers
    // are one per channel with fixed names, so the bar only repeats what the
    // page already said and takes vertical space from the image. Layers stay
    // reachable through the layer-list button in the top bar.
    showLayerPanel: false,
  });
}

// Module scripts are deferred, so the container normally exists by now; the
// readyState check covers the case where this module is loaded later.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
