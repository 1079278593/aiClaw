import { WebSocket } from "ws";
import type { Client, ServerMessage } from "./protocol.js";

export function sendToClient(client: Client, data: ServerMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(data));
}
