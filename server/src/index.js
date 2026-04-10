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

const CENTINELAS_BASE_URL =
  process.env.CENTINELAS_BASE_URL || "https://centinela-security-zttw.onrender.com";

const CENTINELAS_PANEL_URL =
  process.env.CENTINELAS_PANEL_URL ||
  "https://centinela-security-zttw.onrender.com/panel-admin/index.html";

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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

function setDeviceLastMessage(deviceId, parsed) {
  const current = getDeviceState(deviceId);
  deviceState.set(deviceId, {
    ...current,
    lastSeen: now(),
    lastMessage: parsed
  });
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

async function fetchCentinelasJson(pathname) {
  const url = `${CENTINELAS_BASE_URL}${pathname}`;

  log("Consultando Centinelas", { url });

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Centinelas respondió ${response.status} en ${pathname}`);
  }

  return await response.json();
}

async function fetchCentinelasObjectives() {
  const data = await fetchCentinelasJson("/api/objetivos");

  if (!Array.isArray(data)) {
    throw new Error("La respuesta de /api/objetivos no es una lista");
  }

  return data;
}

async function fetchCentinelasDevices() {
  const data = await fetchCentinelasJson("/api/dispositivos");

  if (!Array.isArray(data)) {
    throw new Error("La respuesta de /api/dispositivos no es una lista");
  }

  return data;
}

async function findCentinelasObjective(query) {
  const q = normalizeText(query);

  if (!q) return null;

  const objectives = await fetchCentinelasObjectives();

  let exact = objectives.find((o) => normalizeText(o?.nombre) === q);
  if (exact) return exact;

  let startsWith = objectives.find((o) =>
    normalizeText(o?.nombre).startsWith(q)
  );
  if (startsWith) return startsWith;

  let partial = objectives.find((o) =>
    normalizeText(o?.nombre).includes(q)
  );
  if (partial) return partial;

  return null;
}

async function findCentinelasGuard(query) {
  const q = normalizeText(query);

  if (!q) return null;

  const devices = await fetchCentinelasDevices();

  const guards = devices.filter((d) => {
    const tipo = normalizeText(d?.tipo || "guardia");
    return tipo !== "admin" && tipo !== "dueno" && tipo !== "supervisor";
  });

  let exact = guards.find((g) => normalizeText(g?.nombre) === q);
  if (exact) return exact;

  let startsWith = guards.find((g) => normalizeText(g?.nombre).startsWith(q));
  if (startsWith) return startsWith;

  let partial = guards.find((g) => normalizeText(g?.nombre).includes(q));
  if (partial) return partial;

  return null;
}

function createRequestId(prefix = "req") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function waitForDeviceMessage(predicate, deviceId = getDefaultDeviceId(), timeoutMs = 7000) {
  return new Promise((resolve) => {
    const started = Date.now();

    const check = () => {
      const state = getDeviceState(deviceId);
      const lastMessage = state?.lastMessage || null;

      if (lastMessage && predicate(lastMessage)) {
        resolve(lastMessage);
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }

      setTimeout(check, 250);
    };

    check();
  });
}

async function requestPcAndWait(command, matcher, deviceId = getDefaultDeviceId(), timeoutMs = 7000) {
  const ok = sendToPC(command, deviceId);
  if (!ok) return { ok: false, message: null };

  const message = await waitForDeviceMessage(matcher, deviceId, timeoutMs);
  return { ok: true, message };
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

    setDeviceLastMessage(deviceId, parsed);
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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serverTime: now(),
    connectedDevices: Array.from(devices.keys()),
    defaultDeviceId: getDefaultDeviceId(),
    centinelasBaseUrl: CENTINELAS_BASE_URL,
    centinelasPanelUrl: CENTINELAS_PANEL_URL
  });
});

app.post("/alexa", async (req, res) => {
  try {
    log("POST /alexa");
    log("Headers:", safeJson(req.headers));
    log("Body:", safeJson(req.body));

    const body = req.body;
    const requestType = body?.request?.type;
    const intent = body?.request?.intent?.name;
    const deviceId = getDefaultDeviceId();

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
      }, deviceId);

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
      }, deviceId);

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
      }, deviceId);

      return res.json(
        alexaResponse(
          ok ? `Volumen ${rawAction}` : "La computadora no está conectada"
        )
      );
    }

    if (intent === "BloquearComputadoraIntent") {
      const ok = sendToPC({
        type: "lock_pc"
      }, deviceId);

      return res.json(
        alexaResponse(
          ok ? "Bloqueando la computadora" : "La computadora no está conectada"
        )
      );
    }

    if (intent === "SuspenderComputadoraIntent") {
      const ok = sendToPC({
        type: "sleep_pc"
      }, deviceId);

      return res.json(
        alexaResponse(
          ok ? "Suspendiendo la computadora" : "La computadora no está conectada"
        )
      );
    }

    if (intent === "ApagarComputadoraIntent") {
      const ok = sendToPC({
        type: "shutdown_pc"
      }, deviceId);

      return res.json(
        alexaResponse(
          ok ? "Apagando la computadora" : "La computadora no está conectada"
        )
      );
    }

    if (intent === "MostrarObjetivoCentinelasIntent") {
      const objetivo = resolveSlotValue(body.request.intent.slots?.objetivo);

      if (!objetivo) {
        return res.json(
          alexaResponse("Necesito el nombre del objetivo que quieres ver.")
        );
      }

      const ws = getDevice(deviceId);
      if (!ws || ws.readyState !== 1) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      try {
        const foundObjective = await findCentinelasObjective(objetivo);

        if (!foundObjective) {
          return res.json(
            alexaResponse(`No encontré el objetivo ${objetivo} en Centinelas.`)
          );
        }

        const ok = sendToPC({
          type: "show_centinelas_objective",
          objectiveName: foundObjective.nombre,
          objectiveId: foundObjective.id || null,
          panelUrl: CENTINELAS_PANEL_URL
        }, deviceId);

        return res.json(
          alexaResponse(
            ok
              ? `Mostrando ${foundObjective.nombre} en Centinelas`
              : "La computadora no está conectada"
          )
        );
      } catch (err) {
        log("Error buscando objetivo en Centinelas:", err.message);
        return res.json(
          alexaResponse("Tuve un problema al consultar Centinelas.")
        );
      }
    }

    if (intent === "MostrarGuardiaCentinelasIntent") {
      const guardia = resolveSlotValue(body.request.intent.slots?.guardia);

      if (!guardia) {
        return res.json(
          alexaResponse("Necesito el nombre del guardia que quieres ver.")
        );
      }

      const ws = getDevice(deviceId);
      if (!ws || ws.readyState !== 1) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      try {
        const foundGuard = await findCentinelasGuard(guardia);

        if (!foundGuard) {
          return res.json(
            alexaResponse(`No encontré al guardia ${guardia} en Centinelas.`)
          );
        }

        const ok = sendToPC({
          type: "show_centinelas_guard",
          guardName: foundGuard.nombre,
          guardId: foundGuard.id || null,
          panelUrl: CENTINELAS_PANEL_URL
        }, deviceId);

        return res.json(
          alexaResponse(
            ok
              ? `Mostrando al guardia ${foundGuard.nombre} en Centinelas`
              : "La computadora no está conectada"
          )
        );
      } catch (err) {
        log("Error buscando guardia en Centinelas:", err.message);
        return res.json(
          alexaResponse("Tuve un problema al consultar Centinelas.")
        );
      }
    }

    if (intent === "GuardiasPresentesCentinelasIntent") {
      const ws = getDevice(deviceId);
      if (!ws || ws.readyState !== 1) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      const requestId = createRequestId("present_guards");
      const result = await requestPcAndWait(
        {
          type: "get_centinelas_present_guards",
          panelUrl: CENTINELAS_PANEL_URL,
          requestId
        },
        (msg) => {
          if (!msg || typeof msg !== "object") return false;
          if (msg.requestId && msg.requestId === requestId) return true;
          if (msg.type === "centinelas_present_guards_result") return true;
          if (msg.type === "command_result" && msg.commandType === "get_centinelas_present_guards") return true;
          return false;
        },
        deviceId,
        9000
      );

      if (!result.ok) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      const payload =
        result.message?.parsed ||
        result.message?.result ||
        result.message ||
        null;

      const guards =
        payload?.guards ||
        payload?.presentGuards ||
        payload?.items ||
        payload?.data ||
        null;

      if (Array.isArray(guards)) {
        if (guards.length === 0) {
          return res.json(alexaResponse("No hay guardias presentes en este momento."));
        }

        const names = guards
          .map((g) => String(g?.nombre || g?.name || "").trim())
          .filter(Boolean)
          .slice(0, 5);

        const more = guards.length > names.length ? ` y ${guards.length - names.length} más` : "";
        const spoken =
          names.length > 0
            ? `Hay ${guards.length} guardias presentes. ${names.join(", ")}${more}.`
            : `Hay ${guards.length} guardias presentes.`;

        return res.json(alexaResponse(spoken));
      }

      if (typeof payload?.summary === "string" && payload.summary.trim()) {
        return res.json(alexaResponse(payload.summary));
      }

      return res.json(
        alexaResponse("No pude obtener el listado de guardias presentes.")
      );
    }

    // =========================
    // WHATSAPP
    // =========================

    if (intent === "AbrirWhatsAppIntent") {
      const ok = sendToPC({
        type: "open_whatsapp"
      }, deviceId);

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
      }, deviceId);

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
      }, deviceId);

      return res.json(
        alexaResponse(
          ok
            ? `Respondiendo a ${contact}`
            : "La computadora no está conectada"
        )
      );
    }

    if (intent === "MensajesWhatsAppNuevosIntent") {
      const requestId = createRequestId("wa_unread");
      const result = await requestPcAndWait(
        {
          type: "read_unread_whatsapp",
          requestId
        },
        (msg) => {
          if (!msg || typeof msg !== "object") return false;
          if (msg.requestId && msg.requestId === requestId) return true;
          if (msg.type === "whatsapp_unread_result") return true;
          if (msg.type === "command_result" && msg.commandType === "read_unread_whatsapp") return true;
          return false;
        },
        deviceId,
        7000
      );

      if (!result.ok) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      const lastMessage = result.message;

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

      const requestId = createRequestId("wa_latest");
      const result = await requestPcAndWait(
        {
          type: "read_latest_whatsapp",
          contact,
          requestId
        },
        (msg) => {
          if (!msg || typeof msg !== "object") return false;
          if (msg.requestId && msg.requestId === requestId) return true;
          if (msg.type === "whatsapp_latest_result") return true;
          if (msg.type === "command_result" && msg.commandType === "read_latest_whatsapp") return true;
          return false;
        },
        deviceId,
        7000
      );

      if (!result.ok) {
        return res.json(alexaResponse("La computadora no está conectada"));
      }

      const lastMessage = result.message;

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
