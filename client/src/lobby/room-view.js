// The room screen (Lab 4, M2): who is here (roster) and the chat. Listens to a Connection;
// the only things it sends are chat lines. "Грати" and "Вийти" are decided by main.js.

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const STATUS_TEXT = {
  connecting: "З'єднуюсь із сервером…",
  open: "На зв'язку",
  reconnecting: "Зв'язок втрачено, перепідключаюсь…",
  closed: "З'єднання закрито",
};

/**
 * @param {HTMLElement} root
 * @param {{ onPlay: () => void, onLeave: () => void }} actions
 */
export function createRoomView(root, { onPlay, onLeave }) {
  const title = el("h1");
  const meta = el("p", { className: "status" });
  const roster = el("ul", { className: "roster" });
  const log = el("ol", { className: "chat-log", ariaLive: "polite" });
  const input = el("input", {
    maxLength: 280,
    placeholder: "Повідомлення…",
    ariaLabel: "Повідомлення",
  });
  const sendButton = el("button", { type: "submit", textContent: "Надіслати" });
  const form = el("form", { className: "chat-form" }, input, sendButton);
  const playButton = el("button", { className: "primary", type: "button", textContent: "Грати" });
  const leaveButton = el("button", { type: "button", textContent: "Вийти" });
  const connection = el("p", { className: "status", role: "status" });

  root.append(
    title,
    meta,
    el("h2", { textContent: "Пілоти в кімнаті" }),
    roster,
    el("h2", { textContent: "Чат" }),
    log,
    form,
    connection,
    el("div", { className: "actions" }, leaveButton, playButton),
  );

  let conn = null;
  let myId = null;
  let unsubscribe = [];
  const time = (t) =>
    new Date(t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });

  function addLine(kind, text, who) {
    const line = el("li", { className: kind });
    if (who) line.append(el("strong", { textContent: `${who}: ` }));
    line.append(text);
    log.append(line);
    while (log.children.length > 100) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !conn) return;
    conn.send({ type: "chat", text }); // queued if we are reconnecting right now
    input.value = "";
  });
  playButton.addEventListener("click", () => onPlay());
  leaveButton.addEventListener("click", () => onLeave());

  return {
    /** Binds the view to a connection for one room visit. */
    bind(newConn, room, arenaName = room.arena) {
      unsubscribe.forEach((off) => off());
      conn = newConn;
      myId = null;
      log.replaceChildren();
      roster.replaceChildren();
      title.textContent = room.name;
      meta.textContent = `${room.mode === "solo" ? "соло" : "дуель"} · арена «${arenaName}» · до ${room.maxPlayers} пілотів`;
      unsubscribe = [
        conn.on("status", ({ state, delay, code }) => {
          connection.dataset.state =
            state === "open" ? "ok" : state === "closed" ? "error" : "loading";
          connection.textContent =
            STATUS_TEXT[state] +
            (state === "reconnecting" && delay != null
              ? ` (через ${(delay / 1000).toFixed(1)} с)`
              : "") +
            (state === "closed" && code ? ` (код ${code})` : "");
          input.disabled = state === "closed";
          sendButton.disabled = state === "closed";
        }),
        conn.on("welcome", (msg) => (myId = msg.playerId)),
        conn.on("roster", (msg) => {
          roster.replaceChildren(
            ...msg.players.map((p) =>
              el("li", { textContent: p.id === myId ? `${p.name} (ви)` : p.name }),
            ),
          );
        }),
        conn.on("chat", (msg) =>
          addLine(msg.from.id === myId ? "mine" : "", msg.text, msg.from.name),
        ),
        conn.on("system", (msg) => addLine("system", `${time(msg.t)} · ${msg.text}`)),
        conn.on("error", (msg) => addLine("error", `Сервер: ${msg.message} (код ${msg.code})`)),
      ];
    },
    show() {
      root.hidden = false;
      input.focus();
    },
    hide() {
      root.hidden = true;
    },
  };
}
