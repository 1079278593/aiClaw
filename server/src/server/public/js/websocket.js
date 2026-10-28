import { getAccessToken } from "./access-token.js";

export function createWebSocketClient({ onMessage, onStatus }) {
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;

  function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      const token = getAccessToken();
      if (token) socket.send(JSON.stringify({ type: "auth", token }));
    });
    socket.addEventListener("error", () => onStatus(false));
    socket.addEventListener("close", () => {
      onStatus(false);
      if (!stopped) reconnectTimer = setTimeout(connect, 3000);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "connected") onStatus(true);
      onMessage(message);
    });
  }

  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  }

  return { connect, send, stop };
}
