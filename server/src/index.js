import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import http from "http";

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const devices = new Map();
const deviceState = new Map();

function now() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

function alexaResponse(text, shouldEndSession = true) {
  const response = {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text: String(text || "")
      },
      shouldEndSession
    }
  };

  if (!shouldEndSession) {
    response.response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: "Dime qué quieres hacer."
      }
    };
  }

  return response;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function normalizeVolumeAction(action) {
  const value = (action || "").toLowerCase();

  if (["sube", "subir", "aumenta", "aumentar"].includes(value)) return "up";
  if (["baja", "bajar", "reduce", "reducir"].includes(value)) return "down";
  if (["silencia", "silenciar", "mutea", "mutear", "mudo"].includes(value)) return "mute";

  return value;
}

function resolveSlotValue(slot) {
  if (!slot) return null;

  const resolved =
    slot?.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name;

  return resolved || slot?.value || null;
}

function getDefaultDeviceId() {
  return process.env.DEFAULT_DEVICE_ID || "pc-casa";
}

function getDevice(deviceId = getDefaultDeviceId()) {
  return devices.get(deviceId);
}

function getDeviceState(deviceId = getDefaultDeviceId()) {
  return deviceState.get(deviceId) || {};
}

function sendToPC(command, deviceId = getDefaultDeviceId()) {
  const ws = getDevice(deviceId);

  log("sendToPC", {
    targetDeviceId: deviceId,
    command,
    hasSocket: !!ws,
    readyState: ws ? ws.readyState : null
  });

  if (!ws || ws.readyState !== 1) {
    log("PC NO CONECTADA");
    return false;
  }

  try {
    ws.send(JSON.stringify(command));
    log("sendToPC éxito", {
      targetDeviceId: deviceId,
      command
    });
    return true;
  } catch (err) {
    log("ERROR enviando a PC:", err.message);
    return false;
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const deviceId = url.searchParams.get("deviceId");
  const token = url.searchParams.get("token");

  log("Intento conexión WS", {
    path: req.url,
    deviceId,
    tokenReceived: token,
    hasExpectedToken: !!process.env.AGENT_TOKEN
  });

  if (!deviceId) {
    ws.close(1008, "missing deviceId");
    return;
  }

  if (token !== process.env.AGENT_TOKEN) {
    ws.close(1008, "invalid token");
    return;
  }

  ws.isAlive = true;
  devices.set(deviceId, ws);
  deviceState.set(deviceId, {
    lastSeen: now(),
    lastMessage: null
  });

  log("PC conectada:", deviceId);

  ws.on("pong", () => {
    ws.isAlive = true;
    const current = getDeviceState(deviceId);
    deviceState.set(deviceId, {
      ...current,
      lastSeen: now()
    });
  });

  ws.on("message", (data) => {
    const raw = data.toString();
    log("Mensaje desde PC:", raw);

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { type: "raw_message", raw };
    }

    const current = getDeviceState(deviceId);
    deviceState.set(deviceId, {
      ...current,
      lastSeen: now(),
      lastMessage: parsed
    });
  });

  ws.on("close", () => {
    devices.delete(deviceId);
    log("PC desconectada:", deviceId);
  });

  ws.on("error", (err) => {
    log("WS error:", err.message);
  });
});

setInterval(() => {
  for (const [id, ws] of devices.entries()) {
    if (ws.isAlive === false) {
      log("WS terminado por inactividad:", id);
      ws.terminate();
      devices.delete(id);
      continue;
    }

    ws.isAlive = false;
    try {
      ws.ping();
      log("WS ping enviado", { deviceId: id });
    } catch (err) {
      log("Error enviando ping", { deviceId: id, message: err.message });
    }
  }
}, 30000);

app.get("/", (_req, res) => {
  res.send("SERVER OK");
});

app.get("/alexa", (_req, res) => {
  res.send("ALEXA ENDPOINT OK");
});

app.post("/alexa", (req, res) => {
  try {
    log("POST /alexa");
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
      return res.json(alexaResponse("Solicitud inválida"));
    }

    if (requestType === "LaunchRequest") {
      return res.json(
        alexaResponse(
          "Mi computadora lista. Dime qué quieres hacer.",
          false
        )
      );
    }

    if (requestType !== "IntentRequest") {
      return res.json(alexaResponse("No entendí la solicitud."));
    }

    if (intent === "AbrirAplicacionIntent") {
      const app = resolveSlotValue(body.request.intent.slots?.app);

      const ok = sendToPC({
        type: "open_app",
        app
      });

      return res.json(
        alexaResponse(
          ok ? `Abriendo ${app}` : "La computadora no está conectada"
        )
      );
    }

    if (intent === "AbrirSitioIntent") {
      const site = resolveSlotValue(body.request.intent.slots?.site);

      const ok = sendToPC({
        type: "open_website",
        site
      });

      return res.json(
        alexaResponse(
          ok ? `Abriendo ${site}` : "La computadora no está conectada"
        )
      );
    }

    if (intent === "VolumenIntent") {
      const rawAction = resolveSlotValue(body.request.intent.slots?.action);
      const action = normalizeVolumeAction(rawAction);

      const ok = sendToPC({
        type: "volume",
        action
      });

      return res.json(
        alexaResponse(
          ok ? `Volumen ${rawAction}` : "La computadora no está conectada"
        )
      );
    }

    if (intent === "BloquearComputadoraIntent") {
      const ok = sendToPC({
        type: "lock_pc"
      });

      return res.json(
        alexaResponse(
          ok ? "Bloqueando la computadora" : "La computadora no está conectada"
        )
      );
    }

    if (intent === "SuspenderComputadoraIntent") {
      const ok = sendToPC({
        type: "sleep_pc"
      });

      return res.json(
        alexaResponse(
          ok ? "Suspendiendo la computadora" : "La computadora no está conectada"
        )
      );
    }

    if (intent === "ApagarComputadoraIntent") {
      const ok = sendToPC({
        type: "shutdown_pc"
      });

      return res.json(
        alexaResponse(
          ok ? "Apagando la computadora" : "La computadora no está conectada"
        )
      );
    }

    // =========================
    // WHATSAPP
    // =========================

    if (intent === "AbrirWhatsAppIntent") {
      const ok = sendToPC({
        type: "open_whatsapp"
      });

      return res.json(
        alexaResponse(
          ok ? "Abriendo WhatsApp" : "La computadora no está conectada"
        )
      );
    }

    if (intent === "EnviarWhatsAppIntent") {
      const contact = resolveSlotValue(body.request.intent.slots?.contact);
      const message = resolveSlotValue(body.request.intent.slots?.message);

      if (!contact || !message) {
        return res.json(
          alexaResponse("Necesito el contacto y el mensaje.")
        );
      }

      const ok = sendToPC({
        type: "send_whatsapp_message",
        contact,
        message
      });

      return res.json(
        alexaResponse(
          ok
            ? `Enviando WhatsApp a ${contact}`
            : "La computadora no está conectada"
        )
      );
    }

    if (intent === "ResponderWhatsAppIntent") {
      const contact = resolveSlotValue(body.request.intent.slots?.contact);
      const message = resolveSlotValue(body.request.intent.slots?.message);

      if (!contact || !message) {
        return res.json(
          alexaResponse("Necesito a quién responder y el mensaje.")
        );
      }

      const ok = sendToPC({
        type: "reply_whatsapp_message",
        contact,
        message
      });

      return res.json(
        alexaResponse(
          ok
            ? `Respondiendo a ${contact}`
            : "La computadora no está conectada"
        )
      );
    }

    if (intent === "MensajesWhatsAppNuevosIntent") {
      const ok = sendToPC({
        type: "read_unread_whatsapp"
      });

      if (!ok) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      const state = getDeviceState();
      const lastMessage = state?.lastMessage;

      if (
        lastMessage &&
        lastMessage.type === "whatsapp_unread_result" &&
        typeof lastMessage.summary === "string"
      ) {
        return res.json(alexaResponse(lastMessage.summary));
      }

      return res.json(
        alexaResponse(
          "Voy a revisar los mensajes nuevos de WhatsApp en la computadora."
        )
      );
    }

    if (intent === "LeerUltimoWhatsAppIntent") {
      const contact = resolveSlotValue(body.request.intent.slots?.contact);

      if (!contact) {
        return res.json(alexaResponse("Necesito el nombre del contacto."));
      }

      const ok = sendToPC({
        type: "read_latest_whatsapp",
        contact
      });

      if (!ok) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      const state = getDeviceState();
      const lastMessage = state?.lastMessage;

      if (
        lastMessage &&
        lastMessage.type === "whatsapp_latest_result" &&
        typeof lastMessage.text === "string"
      ) {
        return res.json(
          alexaResponse(`El último mensaje de ${contact} dice: ${lastMessage.text}`)
        );
      }

      return res.json(
        alexaResponse(`Voy a revisar el último mensaje de ${contact}.`)
      );
    }

    return res.json(alexaResponse("No entendí ese comando."));
  } catch (e) {
    log("ERROR:", e.message);
    log("STACK:", e.stack);
    return res.json(alexaResponse("Error en el servidor"));
  }
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  log("Servidor corriendo en puerto", PORT);
});