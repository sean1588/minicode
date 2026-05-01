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
      } else if (msg.type === "switch_model") {
        bridge.switchModel(msg.model);
        const changed: ServerMessage = { type: "model_changed", model: msg.model };
        // Broadcast to all clients
        for (const client of wss.clients) {
          client.send(JSON.stringify(changed));
        }
      } else if (msg.type === "permission_response") {
        bridge.resolvePermissionRequest(msg.requestId, {
          decision: msg.decision,
          rememberForSession: msg.rememberForSession ?? false,
        });
      } else if (msg.type === "set_auto_allow") {
        bridge.setAutoAllowWrites(msg.autoAllow);
      }
    });
  });

  return wss;
}
