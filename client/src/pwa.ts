// Lab 8: install the service worker (public/sw.js) so the game can be added to a phone's home
// screen. Only in a production build served over HTTPS (or localhost): in `vite dev` a worker
// would cache modules that Vite rewrites on every save.

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("[pwa] service worker not registered:", error);
    });
  });
}
