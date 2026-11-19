// The only way this project talks HTTP. Three rules from Lab 3, Theory §5:
//   1. fetch() does NOT reject on 404/500 — check `response.ok` every time (fetchOk does).
//   2. Reading the body is a SECOND async step (headers arrive first, then the body).
//   3. Promises can't be cancelled; an AbortSignal can. Every function here accepts one.
// Platform-neutral (fetch, AbortSignal, DOMException exist in browsers and Node 22).

/** A response arrived, but with an error status. `status` decides whether a retry makes sense. */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string | URL) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = String(url);
  }
}

/**
 * fetch + the `ok` check. Rejects with HttpError on 4xx/5xx, TypeError on network failure,
 * AbortError / TimeoutError when the signal fires.
 */
export type FetchOptions = { signal?: AbortSignal | undefined; fetch?: typeof fetch };

export async function fetchOk(
  url: string | URL,
  { signal, fetch = globalThis.fetch }: FetchOptions = {},
): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}

/** fetchOk + response.json(). A corrupt body becomes a SyntaxError that names the file. */
export async function fetchJson(url: string | URL, options: FetchOptions = {}): Promise<unknown> {
  const response = await fetchOk(url, options);
  try {
    const body: unknown = await response.json();
    return body;
  } catch (error: unknown) {
    if (errorName(error) === "AbortError" || errorName(error) === "TimeoutError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`bad JSON in ${String(url)}: ${message}`, { cause: error });
  }
}

/** `error.name` of whatever was thrown (anything can be thrown in JavaScript). */
export function errorName(error: unknown): string | undefined {
  return error instanceof Error || error instanceof DOMException ? error.name : undefined;
}

/** setTimeout as a promise that rejects with the signal's reason when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Worth trying again? Network errors (TypeError), timeouts and 5xx: yes — they may pass.
 * 4xx: never — a missing file stays missing, a bad request stays bad. Aborts and bad JSON: no.
 */
export function isTransient(error: unknown): boolean {
  if (errorName(error) === "TimeoutError" || errorName(error) === "TypeError") return true;
  if (error instanceof HttpError) return error.status >= 500;
  return false;
}

/**
 * Calls `fn(attempt)` until it succeeds, the error is not transient, or attempts run out.
 * Between attempts: exponential backoff with FULL jitter — wait random(0, base * 2^(n-1)),
 * capped at maxMs — so a thousand clients that failed together don't all retry together.
 */
export type RetryOptions = {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal | undefined;
  random?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 3,
    baseMs = 250,
    maxMs = 4000,
    signal,
    random = Math.random,
    wait = sleep,
    onRetry,
  }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      if (attempt >= attempts || !isTransient(error) || signal?.aborted) throw error;
      const delay = Math.round(random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
      onRetry?.({ attempt, delay, error });
      await wait(delay, signal);
    }
  }
}

/** One signal that fires when the caller aborts OR after `ms` — whichever comes first. */
export function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Short human-readable reason for the UI. */
export function describeError(error: unknown): string {
  if (!error) return "невідома помилка";
  // A wrapper that names the failed asset (loader.ts): describe what actually went wrong.
  if (error instanceof Error && error.name === "AssetError" && error.cause)
    return describeError(error.cause);
  const name = errorName(error);
  if (name === "AbortError") return "скасовано";
  if (name === "TimeoutError") return "таймаут";
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (name === "SyntaxError") return "битий JSON";
  if (name === "TypeError") return "немає мережі";
  return error instanceof Error ? error.message : String(error);
}
