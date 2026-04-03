import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import http from "http";

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const devices = new Map();

function now() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

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

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function sendToPC(command) {
  const deviceId = process.env.DEFAULT_DEVICE_ID || "pc-casa";
  const ws = devices.get(deviceId);

  log("sendToPC called", {
    targetDeviceId: deviceId,
    command,
    hasSocket: !!ws,
    readyState: ws ? ws.readyState : null
  });

  if (!ws || ws.readyState !== 1) {
    log("sendToPC failed: computer not connected", {
      targetDeviceId: deviceId
    });
    return false;
  }

  try {
    ws.send(JSON.stringify(command));
    log("sendToPC success", { targetDeviceId: deviceId, command });
    return true;
  } catch (err) {
    log("sendToPC error", err.message);
    return false;
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const deviceId = url.searchParams.get("deviceId");
  const token = url.searchParams.get("token");
  const expectedToken = process.env.AGENT_TOKEN;

  log("WS connection attempt", {
    path: req.url,
    deviceId,
    tokenReceived: token,
    expectedToken,
    remoteAddress: req.socket?.remoteAddress || null
  });

  if (!deviceId) {
    log("WS rejected: missing deviceId");
    ws.close(1008, "missing deviceId");
    return;
  }

  if (!expectedToken) {
    log("WS rejected: server AGENT_TOKEN missing");
    ws.close(1011, "server token missing");
    return;
  }

  if (token !== expectedToken) {
    log("WS rejected: invalid token", {
      deviceId,
      tokenReceived: token,
      expectedToken
    });
    ws.close(1008, "invalid token");
    return;
  }

  ws.isAlive = true;
  devices.set(deviceId, ws);

  log("PC connected", {
    deviceId,
    totalConnectedDevices: devices.size
  });

  ws.on("pong", () => {
    ws.isAlive = true;
    log("WS pong received", { deviceId });
  });

  ws.on("message", (data) => {
    log("WS message from PC", {
      deviceId,
      data: data.toString()
    });
  });

  ws.on("close", (code, reason) => {
    devices.delete(deviceId);
    log("PC disconnected", {
      deviceId,
      code,
      reason: reason.toString(),
      totalConnectedDevices: devices.size
    });
  });

  ws.on("error", (err) => {
    log("WS error", {
      deviceId,
      message: err.message
    });
  });
});

setInterval(() => {
  for (const [id, ws] of devices.entries()) {
    if (ws.isAlive === false) {
      log("WS stale connection terminated", { deviceId: id });
      ws.terminate();
      devices.delete(id);
      continue;
    }

    ws.isAlive = false;
    log("WS ping sent", { deviceId: id });
    ws.ping();
  }
}, 30000);

app.get("/", (_req, res) => {
  log("GET /");
  res.send("SERVER OK");
});

app.get("/alexa", (_req, res) => {
  log("GET /alexa");
  res.send("ALEXA ENDPOINT OK");
});

app.post("/alexa", (req, res) => {
  try {
    log("POST /alexa received");
    log("Headers:", safeJson(req.headers));
    log("Body:", safeJson(req.body));

    const body = req.body;
    const requestType = body?.request?.type;
    const intent = body?.request?.intent?.name;

    log("Alexa parsed request", {
      requestType,
      intent
    });

    if (!body || !body.request) {
      log("Invalid Alexa request: missing body.request");
      return res.json(alexaResponse("Invalid request"));
    }

    if (requestType === "LaunchRequest") {
      log("Handling LaunchRequest");
      return res.json(
        alexaResponse("Ready to control your computer.")
      );
    }

    if (intent === "OpenAppIntent") {
      const appName = body.request.intent.slots?.app?.value || null;
      const monitor = body.request.intent.slots?.monitor?.value || null;

      log("Handling OpenAppIntent", {
        appName,
        monitor
      });

      const ok = sendToPC({
        type: "open_app",
        app: appName,
        monitor
      });

      return res.json(
        alexaResponse(
          ok ? `Opening ${appName}` : "Computer not connected"
        )
      );
    }

    if (intent === "OpenWebsiteIntent") {
      const site = body.request.intent.slots?.site?.value || null;
      const monitor = body.request.intent.slots?.monitor?.value || null;

      log("Handling OpenWebsiteIntent", {
        site,
        monitor
      });

      const ok = sendToPC({
        type: "open_website",
        site,
        monitor
      });

      return res.json(
        alexaResponse(
          ok ? `Opening ${site}` : "Computer not connected"
        )
      );
    }

    if (intent === "VolumeIntent") {
      const action = body.request.intent.slots?.action?.value || null;

      log("Handling VolumeIntent", {
        action
      });

      const ok = sendToPC({
        type: "volume",
        action
      });

      return res.json(
        alexaResponse(
          ok ? `Volume ${action}` : "Computer not connected"
        )
      );
    }

    if (intent === "LockComputerIntent") {
      log("Handling LockComputerIntent");

      const ok = sendToPC({
        type: "lock_pc"
      });

      return res.json(
        alexaResponse(
          ok ? "Locking computer" : "Computer not connected"
        )
      );
    }

    if (intent === "SleepComputerIntent") {
      log("Handling SleepComputerIntent");

      const ok = sendToPC({
        type: "sleep_pc"
      });

      return res.json(
        alexaResponse(
          ok ? "Putting computer to sleep" : "Computer not connected"
        )
      );
    }

    if (intent === "ShutdownComputerIntent") {
      log("Handling ShutdownComputerIntent");

      const ok = sendToPC({
        type: "shutdown_pc"
      });

      return res.json(
        alexaResponse(
          ok ? "Shutting down computer" : "Computer not connected"
        )
      );
    }

    log("Unhandled intent", { intent });
    return res.json(alexaResponse("Command not understood"));
  } catch (e) {
    log("POST /alexa error", {
      message: e.message,
      stack: e.stack
    });
    return res.json(alexaResponse("Error"));
  }
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  log("Server running", {
    port: PORT,
    defaultDeviceId: process.env.DEFAULT_DEVICE_ID || "pc-casa",
    hasAgentToken: !!process.env.AGENT_TOKEN
  });
});