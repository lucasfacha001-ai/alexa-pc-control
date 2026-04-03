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

function connect() {
  const wsUrl =
    `${SERVER.replace(/^https/, "wss").replace(/^http/, "ws")}` +
    `/ws?deviceId=${encodeURIComponent(DEVICE)}&token=${encodeURIComponent(TOKEN)}`;

  log("Connecting to", wsUrl.replace(TOKEN, "***"));

  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    log("Connected to server");
    retry = 2000;
  });

  ws.on("message", async (data) => {
    try {
      const cmd = JSON.parse(data.toString());
      log("Command received:", cmd);

      const result = await handleCommand(cmd);
      log("Command executed:", result);
    } catch (err) {
      log("Command error:", err.message);
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