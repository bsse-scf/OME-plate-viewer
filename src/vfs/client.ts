/**
 * Page-side half of the virtual filesystem: registers the service worker and
 * builds the URLs it answers.
 */
import { namespacePrefix, ZARR_SEGMENT, type PortalMessage } from './protocol';

export class ServiceWorkerUnavailableError extends Error {}

let registration: Promise<ServiceWorkerRegistration> | null = null;
let basePath: string | null = null;

/**
 * The path the site is deployed under, always with a trailing slash — `/`
 * locally, `/<repo>/` on a GitHub Pages project site.
 *
 * Once the worker is registered this is its scope, which is authoritative:
 * URLs built from any other value would not be intercepted. Before that, fall
 * back to the landing page's own directory, which is the same thing.
 */
export function getBasePath(): string {
  return basePath ?? new URL('./', location.href).pathname;
}

/**
 * Register the worker and resolve once it actually controls this page.
 *
 * Controlling matters: an uncontrolled page's `_zarr/` requests would fall
 * through to the network and 404. The worker calls `clients.claim()` on
 * activation, so a first-visit page becomes controlled without a reload.
 */
export function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (registration) return registration;

  registration = (async () => {
    if (!('serviceWorker' in navigator)) {
      throw new ServiceWorkerUnavailableError(
        'This browser has no Service Worker support, which the viewer needs to expose local files.',
      );
    }
    if (!window.isSecureContext) {
      throw new ServiceWorkerUnavailableError(
        'Service Workers require a secure context. Use http://localhost or an https:// origin.',
      );
    }

    // Registered relative to this page, which lives at the deployment root.
    // That resolves to `/sw.js` locally and `/<repo>/sw.js` on GitHub Pages,
    // and the default scope is the worker's own directory in both cases — so
    // no build-time knowledge of the deployment path is needed. In dev, a Vite
    // middleware serves the transformed worker at the same URL.
    const reg = await navigator.serviceWorker.register(
      new URL('./sw.js', new URL('./', location.href)),
      { type: 'module' },
    );
    basePath = new URL(reg.scope).pathname;
    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    return reg;
  })();

  registration.catch(() => {
    // Allow a later retry rather than caching the failure forever.
    registration = null;
  });

  return registration;
}

/** Tell the worker to forget cached handles for a dataset (or all of them). */
export function flushWorker(datasetId?: string): void {
  const message: PortalMessage = { type: 'flush', datasetId };
  navigator.serviceWorker?.controller?.postMessage(message);
}

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * Absolute URL of a well's virtual OME-Zarr image, with a trailing slash —
 * the form Zarr data sources expect.
 */
export function wellUrl(datasetId: string, wellId: string): string {
  const prefix = namespacePrefix(getBasePath(), ZARR_SEGMENT);
  return new URL(
    `${prefix}${encodeURIComponent(datasetId)}/${encodePath(wellId)}/`,
    location.origin,
  ).href;
}

/** Absolute URL for a page shipped alongside this one, e.g. `neuroglancer/`. */
export function siteUrl(relativePath: string): string {
  return new URL(`${getBasePath()}${relativePath}`, location.origin).href;
}
