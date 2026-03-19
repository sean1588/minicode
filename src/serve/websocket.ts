import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AgentBridge } from "./agent-bridge.js";
import type { ClientMessage, ServerMessage } from "./types.js";

export function createWebSocketServer(
  httpServer: HttpServer,
  bridge: AgentBridge,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }

      if (msg.type === "chat") {
        if (bridge.isBusy()) {
          ws.send(JSON.stringify({ type: "busy" } satisfies ServerMessage));
          return;
        }
        bridge.runTurn(msg.message).catch(() => {
          // errors already broadcast via agent-bridge
        });
      } else if (msg.type === "cancel") {
        bridge.cancel();
      }
    });
  });

  return wss;
}
