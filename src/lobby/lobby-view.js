// The lobby's DOM (Lab 3, M3). Listens to a Lobby; never fetches anything itself.

const MODE_LABEL = { duel: "дуель, 2 гравці", solo: "соло" };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/**
 * @param {HTMLElement} root   an empty container
 * @param {import("./lobby.js").Lobby} lobby
 * @param {{ arenas: Record<string,{name:string}> }} options
 */
export function createLobbyView(root, lobby, { arenas }) {
  let selected = null;

  const nameInput = el("input", { id: "pilot", maxLength: 16, autocomplete: "nickname" });
  try {
    nameInput.value = localStorage.getItem("dogfight.pilot") ?? "";
  } catch {
    // storage may be blocked; the name is just a convenience
  }
  const list = el("ul", { className: "rooms" });
  const status = el("p", { className: "status", role: "status" });
  const joinButton = el("button", {
    className: "primary",
    textContent: "Приєднатися",
    disabled: true,
  });
  const refreshButton = el("button", { textContent: "Оновити зараз" });

  root.append(
    el("h1", { textContent: "Лобі" }),
    el("label", { className: "field" }, "Ім'я пілота", nameInput),
    el("h2", { textContent: "Кімнати" }),
    list,
    status,
    el("div", { className: "actions" }, refreshButton, joinButton),
  );

  function renderRooms(rooms) {
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
            textContent: `${arenas[room.arena]?.name ?? room.arena} · ${MODE_LABEL[room.mode] ?? room.mode}`,
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

  const time = (d) => d.toLocaleTimeString("uk-UA");

  lobby.addEventListener("loading", (e) => {
    status.dataset.state = "loading";
    status.textContent = `Оновлюю список… (запит #${e.detail.request})`;
  });
  lobby.addEventListener("rooms", (e) => {
    renderRooms(e.detail.rooms);
    status.dataset.state = "ok";
    status.textContent = `Оновлено о ${time(lobby.lastUpdated)} · ${Math.round(e.detail.ms)} мс · запит #${e.detail.request} · автооновлення кожні 4 с`;
  });
  lobby.addEventListener("error", (e) => {
    const { error } = e.detail;
    const reason =
      error.name === "TimeoutError"
        ? "сервер не відповів за 3 с (таймаут)"
        : error.name === "HttpError"
          ? `сервер відповів HTTP ${error.status}`
          : error.name === "TypeError"
            ? "немає з'єднання з сервером"
            : error.message;
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
    lobby.join(selected, nameInput.value);
  }
  joinButton.addEventListener("click", join);
  refreshButton.addEventListener("click", () => lobby.refresh());

  return {
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
