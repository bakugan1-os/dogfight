// The asset pipeline (Lab 3, M1): manifest -> concurrent loads with retry, timeout, progress,
// and cancellation. Nothing here blocks the thread: every wait is an `await`.

import { fetchOk, fetchJson, withRetry, withTimeout } from "../net/http.js";

/**
 * The one place we wrap a CALLBACK API in a promise by hand (Theory §2): <img> reports via
 * onload/onerror. The bytes come through fetch first, so the request honours `signal` and
 * goes through the same ok-check / retry path as everything else.
 */
export async function loadImage(url, { signal, fetch } = {}) {
  const blob = await (await fetchOk(url, { signal, fetch })).blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const onAbort = () => reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      img.onload = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(img);
      };
      img.onerror = () => reject(new Error(`cannot decode image ${url}`));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** fetch -> arrayBuffer (2nd async step) -> decodeAudioData (3rd): an AudioBuffer, ready to play. */
export async function loadAudio(audioCtx, url, { signal, fetch } = {}) {
  const bytes = await (await fetchOk(url, { signal, fetch })).arrayBuffer();
  signal?.throwIfAborted();
  return audioCtx.decodeAudioData(bytes);
}

export function loadJson(url, { signal, fetch } = {}) {
  return fetchJson(url, { signal, fetch });
}

/**
 * Manifest -> flat list of items. URLs are resolved against the manifest's own URL, so the
 * manifest works under any base path.
 */
export function planItems(manifest, manifestUrl) {
  const items = [];
  const groups = [
    ["sprites", "image"],
    ["sounds", "audio"],
    ["data", "json"],
  ];
  for (const [group, type] of groups) {
    for (const [name, spec] of Object.entries(manifest[group] ?? {})) {
      const entry = typeof spec === "string" ? { url: spec } : spec;
      items.push({
        key: `${group}.${name}`,
        group,
        name,
        type,
        url: new URL(entry.url, manifestUrl).href,
        optional: Boolean(entry.optional),
        meta: entry,
      });
    }
  }
  return items;
}

/**
 * Loads every item CONCURRENTLY: all requests start in the same tick; Promise.all waits for
 * the slowest. Progress: each promise is wrapped with a `.then` that counts it (Theory §4).
 *
 * - optional item fails  -> recorded in `failures`, value `null`, the game starts without it;
 * - required item fails  -> Promise.all rejects at once; we then ABORT the rest ourselves,
 *                           because Promise.all does not cancel anything;
 * - caller aborts        -> everything in flight rejects with AbortError.
 *
 * @returns {Promise<{ sprites:object, sounds:object, data:object, failures:Array, ms:number }>}
 */
export async function loadAll(
  items,
  {
    signal,
    onProgress = () => {},
    onItem = () => {},
    audioCtx = null,
    fetch = globalThis.fetch.bind(globalThis),
    timeoutMs = 5000,
    attempts = 3,
    baseMs = 250,
    sequential = false,
    loaders = { image: loadImage, audio: loadAudio, json: loadJson },
  } = {},
) {
  const t0 = performance.now();
  const inner = new AbortController(); // our own "cancel the others" switch
  const all = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
  const failures = [];
  let done = 0;

  function loadOne(item) {
    if (item.type === "audio" && !audioCtx) {
      return Promise.reject(new Error("Web Audio is not available"));
    }
    return withRetry(
      (attempt) => {
        onItem(item, attempt === 1 ? "loading" : `retry ${attempt - 1}`);
        // A fresh timeout for EVERY attempt: AbortSignal.timeout is armed at creation.
        const options = { signal: withTimeout(all, timeoutMs), fetch };
        if (item.type === "audio") return loaders.audio(audioCtx, item.url, options);
        return loaders[item.type](item.url, options);
      },
      { attempts, baseMs, signal: all },
    );
  }

  function tracked(item) {
    return loadOne(item).then(
      (value) => {
        done++;
        onItem(item, "ok");
        onProgress(done / items.length, item);
        return value;
      },
      (error) => {
        if (all.aborted && error.name === "AbortError") {
          // Cancelled — by the player, or by us after a required item failed. Not "done".
          onItem(item, "cancelled");
          throw error;
        }
        done++;
        onItem(item, item.optional ? "skipped" : "failed", error);
        onProgress(done / items.length, item);
        if (item.optional) {
          failures.push({ item, error });
          return null; // a missing sound must not block the game
        }
        throw Object.assign(error, { item });
      },
    );
  }

  let values;
  try {
    if (sequential) {
      // The slow way, kept for the README timing: each request starts after the last ends.
      values = [];
      for (const item of items) values.push(await tracked(item));
    } else {
      values = await Promise.all(items.map(tracked));
    }
  } catch (error) {
    inner.abort(); // stop the requests Promise.all left running (reason: AbortError)
    throw error;
  }

  const result = { sprites: {}, sounds: {}, data: {}, failures, ms: performance.now() - t0 };
  items.forEach((item, i) => {
    if (values[i] == null) return;
    result[item.group][item.name] =
      item.type === "image" ? { image: values[i], ...item.meta } : values[i];
  });
  return result;
}
