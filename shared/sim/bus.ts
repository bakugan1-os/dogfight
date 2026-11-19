// A typed event bus (Lab 6). Replaces `new EventTarget()` + `new CustomEvent(type, { detail })`:
// with EventTarget every `e.detail` is `any`; here the event NAME decides the payload TYPE.
//
//   bus.emit("hit", { target: "ship", ... })   // payload checked against the "hit" entry
//   bus.on("hit", (d) => d.target)             // d is WorldEvents["hit"], not any
//
// `K extends keyof E` says "K is one of the event names"; `E[K]` is "the payload type of that
// name". The two are linked through the same K — that is what makes the generic worth it.

type Listener<P> = (payload: P) => void;

export class Bus<E extends object> {
  #listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {};

  /** Subscribes; returns an unsubscribe function. An AbortSignal removes it too. */
  on<K extends keyof E>(type: K, fn: Listener<E[K]>, signal?: AbortSignal): () => void {
    const set = (this.#listeners[type] ??= new Set<Listener<E[K]>>());
    set.add(fn);
    const off = () => void set.delete(fn);
    signal?.addEventListener("abort", off, { once: true });
    return off;
  }

  /** Synchronous: every listener has run when this returns (like dispatchEvent). */
  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.#listeners[type];
    if (set) for (const fn of [...set]) fn(payload);
  }

  listenerCount(type: keyof E): number {
    return this.#listeners[type]?.size ?? 0;
  }
}
