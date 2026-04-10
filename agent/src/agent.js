import WebSocket from "ws";
import { handleCommand } from "./actions.js";

const SERVER = process.env.SERVER_URL;
const TOKEN = process.env.AGENT_TOKEN;
const DEVICE = process.env.DEVICE_ID || "pc-casa";

if (!SERVER) {
  throw new Error("Missing SERVER_URL");
}

if (!TOKEN) {
  throw new Error("Missing AGENT_TOKEN");
}

let retry = 2000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function buildWsUrl() {
  return (
    `${SERVER.replace(/^https/, "wss").replace(/^http/, "ws")}` +
    `/ws?deviceId=${encodeURIComponent(DEVICE)}&token=${encodeURIComponent(TOKEN)}`
  );
}

function sendJson(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (err) {
    log("Send JSON error:", err.message);
  }
}

function withRequestId(payload, cmd) {
  if (!payload || typeof payload !== "object") return payload;
  if (cmd?.requestId && !payload.requestId) {
    return {
      ...payload,
      requestId: cmd.requestId
    };
  }
  return payload;
}

function buildCapabilities() {
  return [
    "open_app",
    "open_website",
    "volume",
    "lock_pc",
    "sleep_pc",
    "shutdown_pc",
    "open_whatsapp",
    "send_whatsapp_message",
    "reply_whatsapp_message",
    "read_unread_whatsapp",
    "read_latest_whatsapp",
    "show_centinelas_objective",
    "show_centinelas_guard",
    "get_centinelas_present_guards"
  ];
}

function connect() {
  const wsUrl = buildWsUrl();

  log("Connecting to", wsUrl.replace(TOKEN, "***"));

  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    log("Connected to server");
    retry = 2000;

    sendJson(ws, {
      type: "agent_hello",
      deviceId: DEVICE,
      timestamp: new Date().toISOString(),
      capabilities: buildCapabilities()
    });
  });

  ws.on("message", async (data) => {
    let cmd = null;

    try {
      cmd = JSON.parse(data.toString());
      log("Command received:", cmd);
    } catch (err) {
      log("Invalid JSON command:", err.message);
      sendJson(ws, {
        type: "agent_error",
        deviceId: DEVICE,
        error: "Invalid JSON command",
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      const rawResult = await handleCommand(cmd);
      const result = withRequestId(rawResult, cmd);

      log("Command executed:", result);

      sendJson(ws, {
        type: "command_result",
        deviceId: DEVICE,
        commandType: cmd.type,
        ok: true,
        requestId: cmd?.requestId || null,
        result,
        timestamp: new Date().toISOString()
      });

      if (result && typeof result === "object" && result.type) {
        sendJson(ws, {
          ...result,
          deviceId: DEVICE,
          requestId: result.requestId || cmd?.requestId || null,
          timestamp: new Date().toISOString()
        });
      }
    } catch (err) {
      log("Command error:", err.message);

      sendJson(ws, {
        type: "command_result",
        deviceId: DEVICE,
        commandType: cmd.type,
        ok: false,
        requestId: cmd?.requestId || null,
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  ws.on("close", (code, reason) => {
    log("Socket closed", {
      code,
      reason: reason.toString()
    });

    log(`Reconnecting in ${retry / 1000}s`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err.message);
  });
}

connect();
