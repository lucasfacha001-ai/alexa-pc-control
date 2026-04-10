import { exec, execFile, spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, "../scripts");

function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message} | stderr: ${stderr}`));
        return;
      }

      resolve({
        command,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || ""
      });
    });
  });
}

function runFile(file, args = []) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message} | stderr: ${stderr}`));
        return;
      }

      resolve({
        file,
        args,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || ""
      });
    });
  });
}

function runNodeScriptDetached(scriptName, args = []) {
  const scriptPath = getScriptPath(scriptName);

  if (!existsSync(scriptPath)) {
    throw new Error(`No existe el script requerido: ${scriptPath}`);
  }

  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  child.unref();

  return {
    pid: child.pid,
    scriptPath,
    args
  };
}

function normalizeAppName(app) {
  return (app || "").toLowerCase().trim();
}

function normalizeContactName(contact) {
  return (contact || "").trim();
}

function normalizeMessage(message) {
  return (message || "").trim();
}

function normalizeObjectiveName(value) {
  return normalizeMessage(value);
}

function normalizeGuardName(value) {
  return normalizeMessage(value);
}

function siteToUrl(site) {
  const value = (site || "").trim();
  const valueLower = value.toLowerCase();

  if (valueLower.includes("youtube")) return "https://www.youtube.com";
  if (valueLower.includes("google")) return "https://www.google.com";
  if (valueLower.includes("gmail")) return "https://mail.google.com";
  if (valueLower.includes("netflix")) return "https://www.netflix.com";
  if (valueLower.includes("twitch")) return "https://www.twitch.tv";
  if (valueLower.includes("whatsapp")) return "https://web.whatsapp.com";

  if (valueLower.startsWith("http://") || valueLower.startsWith("https://")) {
    return value;
  }

  return `https://${value}`;
}

function getAutoHotkeyPath() {
  const candidates = [
    "C:\\Program Files\\AutoHotkey\\AutoHotkey.exe",
    "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe",
    "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe",
    "C:\\Program Files\\AutoHotkey\\AutoHotkey64.exe"
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getScriptPath(name) {
  return path.join(SCRIPTS_DIR, name);
}

async function runAhkScript(scriptName, args = []) {
  const ahkPath = getAutoHotkeyPath();
  if (!ahkPath) {
    throw new Error(
      "AutoHotkey no está instalado. Instálalo antes de usar WhatsApp por voz."
    );
  }

  const scriptPath = getScriptPath(scriptName);

  if (!existsSync(scriptPath)) {
    throw new Error(`No existe el script requerido: ${scriptPath}`);
  }

  return await runFile(ahkPath, [scriptPath, ...args]);
}

async function runNodeScript(scriptName, args = []) {
  const scriptPath = getScriptPath(scriptName);

  if (!existsSync(scriptPath)) {
    throw new Error(`No existe el script requerido: ${scriptPath}`);
  }

  return await runFile(process.execPath, [scriptPath, ...args]);
}

async function openWhatsAppDesktop() {
  const possibleCommands = [
    'cmd /c start "" "whatsapp:"',
    'powershell -Command "Start-Process whatsapp:"'
  ];

  for (const command of possibleCommands) {
    try {
      return await run(command);
    } catch {
      // intentar siguiente opción
    }
  }

  const executableCandidates = [
    path.join(
      process.env.LOCALAPPDATA || "",
      "WhatsApp",
      "WhatsApp.exe"
    ),
    path.join(
      process.env.USERPROFILE || "",
      "AppData",
      "Local",
      "WhatsApp",
      "WhatsApp.exe"
    )
  ];

  for (const executable of executableCandidates) {
    if (existsSync(executable)) {
      return await run(`cmd /c start "" "${executable}"`);
    }
  }

  throw new Error("No pude abrir WhatsApp Desktop.");
}

function parseJsonStdout(stdout, fallbackType) {
  const text = (stdout || "").trim();
  if (!text) {
    return { type: fallbackType, ok: true };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      type: fallbackType,
      ok: true,
      text
    };
  }
}

function launchCentinelasScript(scriptName, payload = {}) {
  const panelUrl = normalizeMessage(payload.panelUrl);
  const objectiveName = normalizeObjectiveName(payload.objectiveName);
  const guardName = normalizeGuardName(payload.guardName);

  if (!panelUrl) {
    throw new Error("Missing panelUrl");
  }

  if (scriptName === "show-centinelas-objective.js" && !objectiveName) {
    throw new Error("Missing objectiveName");
  }

  if (scriptName === "show-centinelas-guard.js" && !guardName) {
    throw new Error("Missing guardName");
  }

  const args = [];
  if (scriptName === "show-centinelas-objective.js") args.push(objectiveName);
  if (scriptName === "show-centinelas-guard.js") args.push(guardName);
  args.push(panelUrl);

  return runNodeScriptDetached(scriptName, args);
}

export async function handleCommand(command) {
  switch (command.type) {
    case "open_app": {
      const app = normalizeAppName(command.app);

      if (app.includes("chrome") || app.includes("cromo")) {
        return await run('start "" chrome');
      }

      if (app.includes("spotify")) {
        return await run('start "" spotify');
      }

      if (app.includes("bloc de notas") || app.includes("notepad") || app.includes("notas")) {
        return await run('start "" notepad');
      }

      if (app.includes("discord")) {
        return await run('start "" discord');
      }

      if (app.includes("steam")) {
        return await run('start "" steam');
      }

      if (app.includes("whatsapp")) {
        return await openWhatsAppDesktop();
      }

      throw new Error(`Unsupported app: ${command.app}`);
    }

    case "open_website": {
      const url = siteToUrl(command.site);
      await open(url);
      return { openedUrl: url };
    }

    case "volume": {
      const action = (command.action || "").toLowerCase();

      if (action === "up") {
        return await run('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
      }

      if (action === "down") {
        return await run('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
      }

      if (action === "mute") {
        return await run('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"');
      }

      throw new Error(`Unsupported volume action: ${command.action}`);
    }

    case "lock_pc": {
      return await run("rundll32.exe user32.dll,LockWorkStation");
    }

    case "sleep_pc": {
      return await run('powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState(\'Suspend\', $false, $false)"');
    }

    case "shutdown_pc": {
      return await run("shutdown /s /t 0");
    }

    case "show_centinelas_objective": {
      const objectiveName = normalizeObjectiveName(command.objectiveName);
      const panelUrl = normalizeMessage(command.panelUrl);

      if (!objectiveName) {
        throw new Error("Missing objectiveName");
      }

      if (!panelUrl) {
        throw new Error("Missing panelUrl");
      }

      const launched = launchCentinelasScript("show-centinelas-objective.js", {
        objectiveName,
        panelUrl
      });

      return {
        type: "show_centinelas_objective_result",
        ok: true,
        objectiveName,
        panelUrl,
        pid: launched.pid,
        scriptPath: launched.scriptPath,
        message: `Proceso lanzado en segundo plano para fijar ${objectiveName}`
      };
    }

    case "show_centinelas_guard": {
      const guardName = normalizeGuardName(command.guardName);
      const panelUrl = normalizeMessage(command.panelUrl);

      if (!guardName) {
        throw new Error("Missing guardName");
      }

      if (!panelUrl) {
        throw new Error("Missing panelUrl");
      }

      const launched = launchCentinelasScript("show-centinelas-guard.js", {
        guardName,
        panelUrl
      });

      return {
        type: "show_centinelas_guard_result",
        ok: true,
        guardName,
        panelUrl,
        pid: launched.pid,
        scriptPath: launched.scriptPath,
        message: `Proceso lanzado en segundo plano para fijar ${guardName}`
      };
    }

    case "get_centinelas_present_guards": {
      const panelUrl = normalizeMessage(command.panelUrl);

      if (!panelUrl) {
        throw new Error("Missing panelUrl");
      }

      const result = await runNodeScript("get-centinelas-present-guards.js", [panelUrl]);

      return {
        type: "centinelas_present_guards_result",
        ok: true,
        panelUrl,
        parsed: parseJsonStdout(result.stdout, "centinelas_present_guards_result"),
        stdout: result.stdout,
        stderr: result.stderr
      };
    }

    // =========================
    // WHATSAPP
    // =========================

    case "open_whatsapp": {
      return await openWhatsAppDesktop();
    }

    case "send_whatsapp_message": {
      const contact = normalizeContactName(command.contact);
      const message = normalizeMessage(command.message);

      if (!contact) {
        throw new Error("Missing WhatsApp contact");
      }

      if (!message) {
        throw new Error("Missing WhatsApp message");
      }

      await openWhatsAppDesktop();

      const result = await runAhkScript("whatsapp_send.ahk", [contact, message]);

      return {
        type: "whatsapp_send_result",
        ok: true,
        contact,
        message,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }

    case "reply_whatsapp_message": {
      const contact = normalizeContactName(command.contact);
      const message = normalizeMessage(command.message);

      if (!contact) {
        throw new Error("Missing WhatsApp contact");
      }

      if (!message) {
        throw new Error("Missing WhatsApp message");
      }

      await openWhatsAppDesktop();

      const result = await runAhkScript("whatsapp_send.ahk", [contact, message]);

      return {
        type: "whatsapp_reply_result",
        ok: true,
        contact,
        message,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }

    case "read_unread_whatsapp": {
      await openWhatsAppDesktop();

      const result = await runAhkScript("whatsapp_read_unread.ahk", []);
      return parseJsonStdout(result.stdout, "whatsapp_unread_result");
    }

    case "read_latest_whatsapp": {
      const contact = normalizeContactName(command.contact);

      if (!contact) {
        throw new Error("Missing WhatsApp contact");
      }

      await openWhatsAppDesktop();

      const result = await runAhkScript("whatsapp_read_latest.ahk", [contact]);
      return parseJsonStdout(result.stdout, "whatsapp_latest_result");
    }

    default:
      throw new Error(`Unsupported command type: ${command.type}`);
  }
}
