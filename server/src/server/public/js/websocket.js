import { getAccessToken } from "./access-token.js";

export function createWebSocketClient({ onMessage, onStatus }) {
  let socket = null;
  let reconnectTimer = null;

  function connect() {
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const token = getAccessToken();
    const query = token ? `?access_token=${encodeURIComponent(token)}` : "";
    socket = new WebSocket(`${protocol}//${location.host}/ws${query}`);
    socket.addEventListener("open", () => onStatus(true));
    socket.addEventListener("error", () => onStatus(false));
    socket.addEventListener("close", () => {
      onStatus(false);
      reconnectTimer = setTimeout(connect, 3000);
    });
    socket.addEventListener("message", (event) => onMessage(JSON.parse(event.data)));
  }

  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  function close() {
    clearTimeout(reconnectTimer);
    socket?.close();
  }

  return { connect, send, close };
}
