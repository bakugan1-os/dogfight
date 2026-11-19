// A tiny typed `document.createElement` helper (Lab 6). The tag name decides the element type:
// el("input", { maxLength: 16 }) is an HTMLInputElement, and `maxLength: "16"` would not compile.
// HTMLElementTagNameMap is the DOM's own table "tag -> element type".

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** getElementById + a runtime check of the element's class: the result is typed, not assumed. */
export function byId<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return node;
}
