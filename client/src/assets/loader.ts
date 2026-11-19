// The asset pipeline (Lab 3, M1): manifest -> concurrent loads with retry, timeout, progress,
// and cancellation. Nothing here blocks the thread: every wait is an `await`.
//
// Lab 6: the manifest is parsed with a zod schema (it comes over the network); the loaders are
// passed in, and loadAll is GENERIC over what they produce — HTMLImageElement/AudioBuffer in the
// browser, plain strings in the Node tests — so the result type follows the loaders.

import { z } from "zod";
import { fetchOk, fetchJson, withRetry, withTimeout, errorName } from "../net/http.ts";
import { assertNever } from "@dogfight/shared/sim/math.ts";

export type LoadOptions = { signal?: AbortSignal | undefined; fetch?: typeof fetch };
export type Loader<T> = (url: string, options: LoadOptions) => Promise<T>;

/** What each kind of asset becomes. `audio: null` = this browser has no Web Audio. */
export type Loaders<Img, Snd> = {
  image: Loader<Img>;
  audio: Loader<Snd> | null;
  json: Loader<unknown>;
};

const EntrySchema = z.union([
  z.string().transform((url) => ({ url })),
  z.looseObject({
    url: z.string(),
    optional: z.boolean().optional(),
    cell: z.number().positive().optional(),
  }),
]);
type Entry = z.output<typeof EntrySchema>;
export const ManifestSchema = z.object({
  version: z.number().optional(),
  sprites: z.record(z.string(), EntrySchema).optional(),
  sounds: z.record(z.string(), EntrySchema).optional(),
  data: z.record(z.string(), EntrySchema).optional(),
});
export type Manifest = z.output<typeof ManifestSchema>;
export type ManifestEntry = Entry;

const GROUPS = { sprites: "image", sounds: "audio", data: "json" } as const;
export type Group = keyof typeof GROUPS;
export type AssetType = (typeof GROUPS)[Group];

export type Item = {
  key: string;
  group: Group;
  name: string;
  type: AssetType;
  url: string;
  optional: boolean;
  meta: Entry;
};

export type ItemStatus = "loading" | `retry ${number}` | "ok" | "cancelled" | "skipped" | "failed";
export type Sprite<Img> = { image: Img; url: string; cell?: number | undefined };
export type Failure = { item: Item; error: unknown };
export type LoadedAssets<Img, Snd> = {
  sprites: Record<string, Sprite<Img>>;
  sounds: Record<string, Snd>;
  data: Record<string, unknown>;
  failures: Failure[];
  ms: number;
};

/** An error that remembers which item it came from (the loading screen names it). */
export class AssetError extends Error {
  readonly item: Item;
  constructor(item: Item, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AssetError";
    this.item = item;
  }
}

/**
 * The one place we wrap a CALLBACK API in a promise by hand (Theory §2): <img> reports via
 * onload/onerror. The bytes come through fetch first, so the request honours `signal` and
 * goes through the same ok-check / retry path as everything else.
 */
export async function loadImage(
  url: string,
  { signal, fetch }: LoadOptions = {},
): Promise<HTMLImageElement> {
  const blob = await (await fetchOk(url, { signal, fetch })).blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const onAbort = () => reject(signal?.reason);
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
export async function loadAudio(
  audioCtx: BaseAudioContext,
  url: string,
  { signal, fetch }: LoadOptions = {},
): Promise<AudioBuffer> {
  const bytes = await (await fetchOk(url, { signal, fetch })).arrayBuffer();
  signal?.throwIfAborted();
  return audioCtx.decodeAudioData(bytes);
}

export function loadJson(url: string, { signal, fetch }: LoadOptions = {}): Promise<unknown> {
  return fetchJson(url, { signal, fetch });
}

/** The real loaders, for the browser. */
export function browserLoaders(
  audioCtx: BaseAudioContext | null,
): Loaders<HTMLImageElement, AudioBuffer> {
  return {
    image: loadImage,
    audio: audioCtx ? (url, options) => loadAudio(audioCtx, url, options) : null,
    json: loadJson,
  };
}

/**
 * Manifest -> flat list of items. URLs are resolved against the manifest's own URL, so the
 * manifest works under any base path. The manifest is `unknown` until the schema says otherwise.
 */
export function planItems(manifest: unknown, manifestUrl: string | URL): Item[] {
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success)
    throw new TypeError(`bad manifest: ${parsed.error.issues[0]?.message ?? "?"}`);
  const items: Item[] = [];
  for (const group of ["sprites", "sounds", "data"] as const) {
    for (const [name, entry] of Object.entries(parsed.data[group] ?? {})) {
      items.push({
        key: `${group}.${name}`,
        group,
        name,
        type: GROUPS[group],
        url: new URL(entry.url, manifestUrl).href,
        optional: "optional" in entry ? Boolean(entry.optional) : false,
        meta: entry,
      });
    }
  }
  return items;
}

/** One loaded value, tagged with its type: a discriminated union instead of `any`. */
type Loaded<Img, Snd> =
  { type: "image"; value: Img } | { type: "audio"; value: Snd } | { type: "json"; value: unknown };

export type LoadAllOptions<Img, Snd> = {
  loaders: Loaders<Img, Snd>;
  signal?: AbortSignal | undefined;
  onProgress?: (fraction: number, item: Item) => void;
  onItem?: (item: Item, status: ItemStatus, error?: unknown) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  baseMs?: number;
  sequential?: boolean;
};

/**
 * Loads every item CONCURRENTLY: all requests start in the same tick; Promise.all waits for
 * the slowest. Progress: each promise is wrapped with a `.then` that counts it (Theory §4).
 *
 * - optional item fails  -> recorded in `failures`, value `null`, the game starts without it;
 * - required item fails  -> Promise.all rejects at once; we then ABORT the rest ourselves,
 *                           because Promise.all does not cancel anything;
 * - caller aborts        -> everything in flight rejects with AbortError.
 */
export async function loadAll<Img, Snd>(
  items: readonly Item[],
  {
    loaders,
    signal,
    onProgress = () => {},
    onItem = () => {},
    fetch = globalThis.fetch.bind(globalThis),
    timeoutMs = 5000,
    attempts = 3,
    baseMs = 250,
    sequential = false,
  }: LoadAllOptions<Img, Snd>,
): Promise<LoadedAssets<Img, Snd>> {
  const t0 = performance.now();
  const inner = new AbortController(); // our own "cancel the others" switch
  const all = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
  const failures: Failure[] = [];
  let done = 0;

  function loadOne(item: Item): Promise<Loaded<Img, Snd>> {
    const audio = loaders.audio;
    if (item.type === "audio" && !audio) {
      return Promise.reject(new Error("Web Audio is not available"));
    }
    return withRetry(
      async (attempt): Promise<Loaded<Img, Snd>> => {
        onItem(item, attempt === 1 ? "loading" : `retry ${attempt - 1}`);
        // A fresh timeout for EVERY attempt: AbortSignal.timeout is armed at creation.
        const options = { signal: withTimeout(all, timeoutMs), fetch };
        switch (item.type) {
          case "image":
            return { type: "image", value: await loaders.image(item.url, options) };
          case "audio":
            if (!audio) throw new Error("Web Audio is not available");
            return { type: "audio", value: await audio(item.url, options) };
          case "json":
            return { type: "json", value: await loaders.json(item.url, options) };
          default:
            return assertNever(item.type, "asset type");
        }
      },
      { attempts, baseMs, signal: all },
    );
  }

  function tracked(item: Item): Promise<Loaded<Img, Snd> | null> {
    return loadOne(item).then(
      (value) => {
        done++;
        onItem(item, "ok");
        onProgress(done / items.length, item);
        return value;
      },
      (error: unknown) => {
        if (all.aborted && errorName(error) === "AbortError") {
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
        throw new AssetError(item, error);
      },
    );
  }

  let values: Array<Loaded<Img, Snd> | null>;
  try {
    if (sequential) {
      // The slow way, kept for the README timing: each request starts after the last ends.
      values = [];
      for (const item of items) values.push(await tracked(item));
    } else {
      values = await Promise.all(items.map(tracked));
    }
  } catch (error: unknown) {
    inner.abort(); // stop the requests Promise.all left running (reason: AbortError)
    throw error;
  }

  const result: LoadedAssets<Img, Snd> = {
    sprites: {},
    sounds: {},
    data: {},
    failures,
    ms: performance.now() - t0,
  };
  items.forEach((item, i) => {
    const loaded = values[i];
    if (!loaded) return;
    switch (loaded.type) {
      case "image":
        result.sprites[item.name] = {
          ...item.meta,
          image: loaded.value,
          url: item.meta.url,
          cell: "cell" in item.meta ? item.meta.cell : undefined,
        };
        break;
      case "audio":
        result.sounds[item.name] = loaded.value;
        break;
      case "json":
        result.data[item.name] = loaded.value;
        break;
      default:
        assertNever(loaded, "loaded asset");
    }
  });
  return result;
}
