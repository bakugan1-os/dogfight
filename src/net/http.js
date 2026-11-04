// The only way this project talks HTTP. Three rules from Lab 3, Theory §5:
//   1. fetch() does NOT reject on 404/500 — check `response.ok` every time (fetchOk does).
//   2. Reading the body is a SECOND async step (headers arrive first, then the body).
//   3. Promises can't be cancelled; an AbortSignal can. Every function here accepts one.
// Platform-neutral (fetch, AbortSignal, DOMException exist in browsers and Node 22).

/** A response arrived, but with an error status. `status` decides whether a retry makes sense. */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/**
 * fetch + the `ok` check. Rejects with HttpError on 4xx/5xx, TypeError on network failure,
 * AbortError / TimeoutError when the signal fires.
 */
export async function fetchOk(url, { signal, fetch = globalThis.fetch } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}

/** fetchOk + response.json(). A corrupt body becomes a SyntaxError that names the file. */
export async function fetchJson(url, options = {}) {
  const response = await fetchOk(url, options);
  try {
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
    throw new SyntaxError(`bad JSON in ${url}: ${error.message}`, { cause: error });
  }
}

/** setTimeout as a promise that rejects with the signal's reason when aborted. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
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
export function isTransient(error) {
  if (error?.name === "TimeoutError" || error?.name === "TypeError") return true;
  if (error instanceof HttpError) return error.status >= 500;
  return false;
}

/**
 * Calls `fn(attempt)` until it succeeds, the error is not transient, or attempts run out.
 * Between attempts: exponential backoff with FULL jitter — wait random(0, base * 2^(n-1)),
 * capped at maxMs — so a thousand clients that failed together don't all retry together.
 */
export async function withRetry(
  fn,
  {
    attempts = 3,
    baseMs = 250,
    maxMs = 4000,
    signal,
    random = Math.random,
    wait = sleep,
    onRetry,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransient(error) || signal?.aborted) throw error;
      const delay = Math.round(random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
      onRetry?.({ attempt, delay, error });
      await wait(delay, signal);
    }
  }
}

/** One signal that fires when the caller aborts OR after `ms` — whichever comes first. */
export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Short human-readable reason for the UI. */
export function describeError(error) {
  if (!error) return "невідома помилка";
  if (error.name === "AbortError") return "скасовано";
  if (error.name === "TimeoutError") return "таймаут";
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error.name === "SyntaxError") return "битий JSON";
  if (error.name === "TypeError") return "немає мережі";
  return error.message;
}
