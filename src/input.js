// Keyboard input as a closure: the key state lives in two private Sets that nothing outside
// this function can reach. The returned object IS the API.

const GAME_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Enter",
]);

/**
 * @param {EventTarget} target usually `window`
 * @returns {{ isDown(code:string):boolean, justPressed(code:string):boolean,
 *             onPress(code:string, callback:Function):Function, endStep():void, dispose():void }}
 */
export function createInput(target) {
  const down = new Set(); // keys held right now
  const pressed = new Set(); // keys that went up -> down since the last simulation step
  const listeners = new Map(); // code -> Set<callback>, for UI actions (pause, restart, ...)

  const onKeyDown = (e) => {
    // Auto-repeat fires keydown again while the key is held; only the FIRST one is an edge.
    const isEdge = !down.has(e.code);
    if (isEdge) pressed.add(e.code);
    down.add(e.code);
    if (isEdge) {
      // Plain call `callback(e)`: default binding -> `this` is undefined inside a method
      // passed here by reference. That's the Lab 2 `this` bug — pass arrows, not methods.
      for (const callback of listeners.get(e.code) ?? []) callback(e);
    }
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // no page scrolling on arrows / space
  };
  const onKeyUp = (e) => {
    down.delete(e.code);
  };
  // Releasing a key while the window is unfocused never delivers keyup — the ship would
  // thrust forever. Forget everything on blur.
  const onBlur = () => {
    down.clear();
    pressed.clear();
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return {
    isDown: (code) => down.has(code),
    /**
     * Edge-triggered: true for exactly ONE simulation step after the key went down —
     * even if the key was pressed and released between two steps (a quick tap still counts).
     * Edges are consumed per STEP, not per frame: at 144 Hz there are frames with zero steps,
     * and at 30 Hz frames with two; clearing per frame would lose or duplicate presses.
     */
    justPressed: (code) => pressed.has(code),
    /**
     * Event-driven callback for UI actions that are NOT part of the simulation.
     * Returns an unsubscribe function.
     */
    onPress(code, callback) {
      if (!listeners.has(code)) listeners.set(code, new Set());
      listeners.get(code).add(callback);
      return () => listeners.get(code).delete(callback);
    },
    /** Call once after every simulation step. */
    endStep: () => pressed.clear(),
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
      listeners.clear();
    },
  };
}

/** Key bindings for hot-seat play on one keyboard. */
export const BINDINGS = Object.freeze({
  1: { thrust: ["KeyW"], left: ["KeyA"], right: ["KeyD"], fire: ["Space"] },
  2: { thrust: ["ArrowUp"], left: ["ArrowLeft"], right: ["ArrowRight"], fire: ["Enter"] },
});

/**
 * Translates raw keys into plain-data controls for the simulation (the sim never sees keys).
 * `fire` = held (auto-fire at the cooldown rate); `firePressed` = edge, so a tap shorter than one
 * step still fires.
 */
export function readControls(input, binding = BINDINGS[1]) {
  const any = (codes, fn) => codes.some((code) => fn(code));
  return {
    thrust: any(binding.thrust, input.isDown),
    left: any(binding.left, input.isDown),
    right: any(binding.right, input.isDown),
    fire: any(binding.fire, input.isDown),
    firePressed: any(binding.fire, input.justPressed),
  };
}
