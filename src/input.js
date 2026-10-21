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
]);

/**
 * @param {EventTarget} target usually `window`
 * @returns {{ isDown(code:string):boolean, justPressed(code:string):boolean,
 *             endStep():void, dispose():void }}
 */
export function createInput(target) {
  const down = new Set(); // keys held right now
  const pressed = new Set(); // keys that went up -> down since the last simulation step

  const onKeyDown = (e) => {
    // Auto-repeat fires keydown again while the key is held; only the FIRST one is an edge.
    if (!down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
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
    /** Call once after every simulation step. */
    endStep: () => pressed.clear(),
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}

/** Translates raw keys into plain-data controls for the simulation (the sim never sees keys). */
export function readControls(input) {
  return {
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    left: input.isDown("ArrowLeft") || input.isDown("KeyA"),
    right: input.isDown("ArrowRight") || input.isDown("KeyD"),
    fire: input.justPressed("Space"),
  };
}
