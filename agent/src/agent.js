import WebSocket from "ws";
import { handleCommand } from "./actions.js";

const SERVER = process.env.SERVER_URL;
const TOKEN = process.env.AGENT_TOKEN;
const DEVICE = "pc-casa";

let retry = 2000;

function connect() {
  const ws = new WebSocket(
    `${SERVER.replace("https", "wss")}/ws?deviceId=${DEVICE}&token=${TOKEN}`
  );

  ws.on("open", () => {
    console.log("Connected to server");
    retry = 2000;
  });

  ws.on("message", async (data) => {
    const cmd = JSON.parse(data);
    console.log("Command:", cmd);
    await handleCommand(cmd);
  });

  ws.on("close", () => {
    console.log("Reconnecting...");
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  });

  ws.on("error", console.error);
}

connect();