import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import http from "http";

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const devices = new Map();

function alexaResponse(text) {
  return {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text
      },
      shouldEndSession: true
    }
  };
}

function sendToPC(command) {
  const deviceId = process.env.DEFAULT_DEVICE_ID || "pc-casa";
  const ws = devices.get(deviceId);

  if (!ws || ws.readyState !== 1) return false;

  ws.send(JSON.stringify(command));
  return true;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const deviceId = url.searchParams.get("deviceId");
  const token = url.searchParams.get("token");

  if (!deviceId || token !== process.env.AGENT_TOKEN) {
    ws.close();
    return;
  }

  ws.isAlive = true;
  devices.set(deviceId, ws);

  console.log("PC conectada:", deviceId);

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("close", () => {
    devices.delete(deviceId);
    console.log("PC desconectada:", deviceId);
  });
});

setInterval(() => {
  for (const [id, ws] of devices.entries()) {
    if (!ws.isAlive) {
      ws.terminate();
      devices.delete(id);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

app.get("/", (_req, res) => {
  res.send("SERVER OK");
});

app.post("/alexa", (req, res) => {
  try {
    const body = req.body;
    const intent = body?.request?.intent?.name;

    if (body.request.type === "LaunchRequest") {
      return res.json(
        alexaResponse("Ready to control your computer.")
      );
    }

    if (intent === "OpenAppIntent") {
      const appName = body.request.intent.slots?.app?.value;

      const ok = sendToPC({
        type: "open_app",
        app: appName
      });

      return res.json(
        alexaResponse(
          ok ? `Opening ${appName}` : "Computer not connected"
        )
      );
    }

    if (intent === "OpenWebsiteIntent") {
      const site = body.request.intent.slots?.site?.value;

      const ok = sendToPC({
        type: "open_website",
        site
      });

      return res.json(
        alexaResponse(
          ok ? `Opening ${site}` : "Computer not connected"
        )
      );
    }

    if (intent === "VolumeIntent") {
      const action = body.request.intent.slots?.action?.value;

      const ok = sendToPC({
        type: "volume",
        action
      });

      return res.json(
        alexaResponse(ok ? `Volume ${action}` : "Computer not connected")
      );
    }

    if (intent === "LockComputerIntent") {
      const ok = sendToPC({ type: "lock_pc" });

      return res.json(
        alexaResponse(ok ? "Locking computer" : "Computer not connected")
      );
    }

    return res.json(alexaResponse("Command not understood"));
  } catch (e) {
    console.error(e);
    return res.json(alexaResponse("Error"));
  }
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});