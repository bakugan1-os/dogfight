// The lobby's DOM (Lab 3, M3). Listens to a Lobby; never fetches anything itself.
// Lab 4: a "new room" form (POST /api/rooms through Lobby.create) and notice() for messages
// such as "the room is full" coming back from the server.

import { el } from "../dom.ts";
import { errorName, HttpError } from "../net/http.ts";
import {
  ArenaIdSchema,
  ModeSchema,
  type Mode,
  type RoomSummary,
} from "@dogfight/shared/protocol/control.ts";
import type { Lobby } from "./lobby.ts";
import type { ArenaTable } from "../arenas.ts";

const MODE_LABEL: Record<Mode, string> = { duel: "дуель, 2 гравці", solo: "соло" };

export type LobbyView = { notice(text: string): void; show(): void; hide(): void };

/** @param root an empty container */
export function createLobbyView(
  root: HTMLElement,
  lobby: Lobby,
  { arenas }: { arenas: ArenaTable },
): LobbyView {
  let selected: string | null = null;

  const nameInput = el("input", { id: "pilot", maxLength: 16 });
  nameInput.setAttribute("autocomplete", "nickname"); // valid HTML, missing from lib.dom's AutoFill type
  try {
    nameInput.value = localStorage.getItem("dogfight.pilot") ?? "";
  } catch {
    // storage may be blocked; the name is just a convenience
  }
  const list = el("ul", { className: "rooms" });
  const status = el("p", { className: "status", role: "status" });
  // Lab 8: messages from OUTSIDE the lobby ("the server restarted") get their own line — the
  // status line is rewritten by every poll and would erase them within a second.
  const noticeLine = el("p", { className: "notice", role: "alert", hidden: true });
  const joinButton = el("button", {
    className: "primary",
    textContent: "Приєднатися",
    disabled: true,
  });
  const refreshButton = el("button", { textContent: "Оновити зараз" });

  // ---- Lab 4: create a room on the server
  const newName = el("input", { maxLength: 40, placeholder: "Назва кімнати" });
  const newArena = el(
    "select",
    { ariaLabel: "Арена" },
    ...Object.entries(arenas).map(([id, a]) => el("option", { value: id, textContent: a.name })),
  );
  const newMode = el(
    "select",
    { ariaLabel: "Режим" },
    el("option", { value: "duel", textContent: "дуель" }),
    el("option", { value: "solo", textContent: "соло" }),
  );
  const createButton = el("button", { type: "submit", textContent: "Створити" });
  const createForm = el(
    "form",
    { className: "create-room" },
    newName,
    newArena,
    newMode,
    createButton,
  );

  root.append(
    el("h1", { textContent: "Лобі" }),
    noticeLine,
    el("label", { className: "field" }, "Ім'я пілота", nameInput),
    el("h2", { textContent: "Кімнати" }),
    list,
    status,
    el("div", { className: "actions" }, refreshButton, joinButton),
    el("h2", { textContent: "Нова кімната" }),
    createForm,
  );

  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void createRoom();
  });

  async function createRoom(): Promise<void> {
    createButton.disabled = true;
    try {
      // <select> values are strings; parse them into the protocol's literal types.
      const room = await lobby.create({
        name: newName.value,
        arena: ArenaIdSchema.parse(newArena.value),
        mode: ModeSchema.parse(newMode.value),
      });
      selected = room.id;
      newName.value = "";
      renderRooms(lobby.rooms);
      joinButton.disabled = false;
      status.dataset.state = "ok";
      status.textContent = `Кімнату «${room.name}» створено. Порожня кімната зникне через хвилину.`;
    } catch (error: unknown) {
      status.dataset.state = "error";
      status.textContent = `Не вдалося створити кімнату: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      createButton.disabled = false;
    }
  }

  function renderRooms(rooms: readonly RoomSummary[]): void {
    if (!rooms.length) {
      list.replaceChildren(
        el("li", { className: "empty", textContent: "Список кімнат ще не отримано." }),
      );
      joinButton.disabled = true;
      return;
    }
    list.replaceChildren(
      ...rooms.map((room) => {
        const full = room.players >= room.maxPlayers;
        const button = el(
          "button",
          { className: "room", disabled: full, type: "button" },
          el("strong", { textContent: room.name }),
          el("span", {
            textContent: `${arenas[room.arena]?.name ?? room.arena} · ${MODE_LABEL[room.mode]}`,
          }),
          el("span", {
            className: "count",
            textContent: full ? "повна" : `${room.players}/${room.maxPlayers}`,
          }),
        );
        button.setAttribute("aria-pressed", String(room.id === selected));
        button.addEventListener("click", () => {
          selected = room.id;
          joinButton.disabled = false;
          renderRooms(lobby.rooms);
        });
        button.addEventListener("dblclick", join);
        return el("li", {}, button);
      }),
    );
    if (!rooms.some((r) => r.id === selected && r.players < r.maxPlayers)) {
      selected = null;
      joinButton.disabled = true;
    }
  }

  const time = (d: Date | null) => d?.toLocaleTimeString("uk-UA") ?? "—";

  lobby.on("loading", ({ request }) => {
    status.dataset.state = "loading";
    status.textContent = `Оновлюю список… (запит #${request})`;
  });
  lobby.on("rooms", ({ rooms, ms, request }) => {
    renderRooms(rooms);
    status.dataset.state = "ok";
    status.textContent = `Оновлено о ${time(lobby.lastUpdated)} · ${Math.round(ms)} мс · запит #${request} · автооновлення кожні 4 с`;
  });
  lobby.on("error", ({ error }) => {
    const name = errorName(error);
    const reason =
      name === "TimeoutError"
        ? "сервер не відповів за 3 с (таймаут)"
        : error instanceof HttpError
          ? `сервер відповів HTTP ${error.status}`
          : name === "TypeError"
            ? "немає з'єднання з сервером"
            : error instanceof Error
              ? error.message
              : String(error);
    status.dataset.state = "error";
    status.textContent = `Не вдалося оновити: ${reason}. ${
      lobby.rooms.length ? "Показую попередній список. " : ""
    }Наступна спроба за 4 с.`;
  });

  function join() {
    if (!selected) return;
    try {
      localStorage.setItem("dogfight.pilot", nameInput.value);
    } catch {
      // ignore
    }
    noticeLine.hidden = true;
    lobby.join(selected, nameInput.value);
  }
  joinButton.addEventListener("click", join);
  refreshButton.addEventListener("click", () => void lobby.refresh());

  return {
    /** A message from outside the lobby, e.g. the server refused to let us into a room. */
    notice(text) {
      noticeLine.textContent = text;
      noticeLine.hidden = false;
    },
    show() {
      root.hidden = false;
      renderRooms(lobby.rooms);
      lobby.start(); // polling only while visible
      nameInput.focus();
    },
    hide() {
      root.hidden = true;
      lobby.stop(); // abort-on-leave
    },
  };
}
