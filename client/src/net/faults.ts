// Fault injection for the failure gallery (Lab 3, M1/M4). A URL can be wrapped so the server
// misbehaves on purpose:
//
//   __fault/delay/<ms>/<path>    answer after <ms> milliseconds    (slow network, timeouts)
//   __fault/status/<code>/<path> answer with HTTP <code>, no body (404, 503, ...)
//   __fault/flaky/<n>/<path>     answer 503 to the first <n> requests, then serve the file
//
// In `npm run dev` / `npm run preview` the Vite plugin in vite.config.ts does this on the
// SERVER. A static host (the hosted demo) has no server code, so `createFaultFetch` performs
// the same rules in the page, around the real fetch — same URLs, same observable behavior.

const PREFIX = "__fault/";

export type FaultKind = "delay" | "status" | "flaky";

export function faultUrl(kind: FaultKind, arg: number, path: string): string {
  return `${PREFIX}${kind}/${arg}/${path}`;
}

/** Splits ".../__fault/delay/500/assets/a.png" into { kind, arg, rest }; null if not a fault URL. */
export function parseFault(
  pathname: string,
): { kind: string; arg: number; base: string; rest: string } | null {
  const at = pathname.indexOf(`/${PREFIX}`);
  if (at === -1) return null;
  const [kind, arg, ...rest] = pathname.slice(at + PREFIX.length + 1).split("/");
  return {
    kind: kind ?? "",
    arg: Number(arg),
    base: pathname.slice(0, at + 1),
    rest: rest.join("/"),
  };
}

/** Server and shim share the counters' semantics: per path, since the page loaded. */
export function createFlakyCounter(): (key: string) => number {
  const seen = new Map<string, number>();
  return (key) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n;
  };
}

/** In-page version of the Vite fault plugin, for static hosting. */
export function createFaultFetch(
  realFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  const count = createFlakyCounter();
  return async function faultFetch(
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(String(input), globalThis.location?.href);
    const fault = parseFault(url.pathname);
    if (!fault) return realFetch(input, init);
    const target = new URL(fault.base + fault.rest + url.search, url);
    const { signal } = init;
    signal?.throwIfAborted();
    switch (fault.kind) {
      case "delay":
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), fault.arg);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return realFetch(target, init);
      case "status":
        return new Response(null, { status: fault.arg });
      case "flaky":
        if (count(fault.rest) <= fault.arg) return new Response(null, { status: 503 });
        return realFetch(target, init);
      default:
        return realFetch(target, init);
    }
  };
}
