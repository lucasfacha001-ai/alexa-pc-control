import { chromium } from "playwright";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const LOCK_FILE = path.join(os.tmpdir(), "centinelas-objective-lock.json");
let lockOwned = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readLockFile() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLockFile(data) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), "utf8");
}

function removeLockFileIfOwned() {
  try {
    if (!lockOwned) return;
    const current = readLockFile();
    if (current && Number(current.pid) === Number(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPreviousProcess(pid) {
  if (!pid || Number(pid) === Number(process.pid)) return;

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function acquireSingleInstanceLock(objectiveName) {
  const existing = readLockFile();

  if (existing?.pid && Number(existing.pid) !== Number(process.pid)) {
    if (isProcessAlive(Number(existing.pid))) {
      console.log(`Detecté un bloqueo anterior activo (${existing.pid}). Lo voy a cerrar.`);
      killPreviousProcess(Number(existing.pid));
      await sleep(1500);
    }
  }

  writeLockFile({
    pid: process.pid,
    objectiveName,
    startedAt: new Date().toISOString(),
  });
  lockOwned = true;
}

function installCleanupHandlers() {
  const cleanup = () => {
    removeLockFileIfOwned();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err?.message || err);
    cleanup();
    process.exit(1);
  });
}

async function attachDialogHandler(page) {
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {}
  });
}

async function safeClick(page, selectors) {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.count()) {
        await el.click({ timeout: 2000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function getCentinelasPage(browser, panelUrl) {
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error("No encontré Chrome abierto con depuración remota en el puerto 9222.");
  }

  const context = contexts[0];
  const pages = context.pages();

  for (const page of pages) {
    const url = page.url() || "";
    if (url.includes("centinela-security-zttw.onrender.com")) {
      return page;
    }
  }

  const page = await context.newPage();
  await page.goto(panelUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  return page;
}

async function resetPanel(page, panelUrl) {
  await page.bringToFront();

  try {
    await page.goto(panelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }

  await sleep(5000);

  await safeClick(page, [
    'button:has-text("Cerrar")',
    'button:has-text("Aceptar")',
    'button:has-text("Entendido")',
    'button:has-text("OK")',
  ]);
}

async function disableAutoCenterAndClearGuard(page) {
  await page.evaluate(() => {
    try {
      window.autoCenter = false;
    } catch {}

    try {
      window.guardiaSeleccionadoId = null;
    } catch {}

    try {
      const chkAuto = document.getElementById("chk-auto-center");
      if (chkAuto) chkAuto.checked = false;
    } catch {}

    try {
      const chkAutoSmart = document.getElementById("chk-auto-smart");
      if (chkAutoSmart) chkAutoSmart.checked = false;
    } catch {}

    try {
      if (typeof window.renderDispositivosAdmin === "function") {
        window.renderDispositivosAdmin();
      }
    } catch {}

    try {
      if (typeof window.renderObjetivosAdmin === "function") {
        window.renderObjetivosAdmin();
      }
    } catch {}
  });

  await sleep(800);
}

async function waitForAutomationReady(page) {
  await page.waitForFunction(() => {
    const mapReady = !!window.map && typeof window.map.setView === "function";
    const centinelasReady =
      !!window.CentinelasAutomation &&
      typeof window.CentinelasAutomation.isReady === "function" &&
      typeof window.CentinelasAutomation.showObjectiveByName === "function";

    const mapAutomationReady =
      !!window.CentinelasMapAutomation &&
      typeof window.CentinelasMapAutomation.focusObjectiveByName === "function";

    const objectivesReady = Array.isArray(window.objetivos);

    return mapReady && objectivesReady && (centinelasReady || mapAutomationReady);
  }, { timeout: 30000 });
}

async function focusObjectiveWithStableApi(page, objectiveName) {
  const result = await page.evaluate(async (name) => {
    const response = {
      ok: false,
      source: null,
      detail: null,
      error: null,
    };

    try {
      if (
        window.CentinelasAutomation &&
        typeof window.CentinelasAutomation.waitUntilReady === "function"
      ) {
        try {
          await window.CentinelasAutomation.waitUntilReady(12000);
        } catch {}
      }

      if (
        window.CentinelasAutomation &&
        typeof window.CentinelasAutomation.showObjectiveByName === "function"
      ) {
        const r = await window.CentinelasAutomation.showObjectiveByName(name);
        response.ok = !!r?.ok;
        response.source = "CentinelasAutomation.showObjectiveByName";
        response.detail = r || null;
        return response;
      }

      if (
        window.CentinelasMapAutomation &&
        typeof window.CentinelasMapAutomation.focusObjectiveByName === "function"
      ) {
        const r = await window.CentinelasMapAutomation.focusObjectiveByName(name, {
          zoom: 16,
          source: "agent_show_centinelas_objective",
        });
        response.ok = !!r?.ok;
        response.source = "CentinelasMapAutomation.focusObjectiveByName";
        response.detail = r || null;
        return response;
      }

      throw new Error("No existe API estable de automatización para objetivos.");
    } catch (err) {
      response.error = err?.message || String(err);
      return response;
    }
  }, objectiveName);

  if (!result?.ok) {
    throw new Error(result?.error || "No se pudo enfocar el objetivo con la API estable");
  }

  return result;
}

async function resolveObjectiveValueForLock(page, objectiveName) {
  const result = await page.evaluate((name) => {
    const normalize = (value) => {
      try {
        return String(value || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        return String(value || "").toLowerCase().trim();
      }
    };

    const target = normalize(name);
    const select = document.getElementById("filtro-objetivo-mapa");
    if (!select || !select.options) {
      return { ok: false, error: "No existe #filtro-objetivo-mapa" };
    }

    const options = Array.from(select.options || []).map((opt) => ({
      value: String(opt.value || "").trim(),
      text: String(opt.textContent || "").trim(),
    }));

    let best = null;
    let bestScore = -1;

    for (const opt of options) {
      const txt = normalize(opt.text);
      if (!txt || !opt.value) continue;

      let score = -1;
      if (txt === target) score = 100;
      else if (txt.startsWith(target)) score = 80;
      else if (txt.includes(target)) score = 60;
      else if (target.includes(txt) && txt.length > 3) score = 40;

      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }

    if (!best) {
      return { ok: false, error: "No se pudo resolver el option del objetivo" };
    }

    return {
      ok: true,
      value: best.value,
      text: best.text,
    };
  }, objectiveName);

  if (!result?.ok) {
    throw new Error(result?.error || "No se pudo resolver el objetivo para bloqueo");
  }

  return result;
}

async function stillOwnLock() {
  const current = readLockFile();
  return current && Number(current.pid) === Number(process.pid);
}

async function lockObjectiveForever(page, objectiveName, selectedValue) {
  console.log(`Bloqueando objetivo seleccionado indefinidamente: ${objectiveName}`);

  while (true) {
    try {
      if (!(await stillOwnLock())) {
        console.log("Otro objetivo tomó el control. Terminando este bloqueo.");
        return;
      }

      if (page.isClosed()) {
        console.log("La página se cerró. Terminando bloqueo.");
        return;
      }

      await page.evaluate(
        async ({ objectiveNameArg, selectedValueArg }) => {
          try {
            window.autoCenter = false;
          } catch {}

          try {
            window.guardiaSeleccionadoId = null;
          } catch {}

          try {
            const chkAuto = document.getElementById("chk-auto-center");
            if (chkAuto) chkAuto.checked = false;
          } catch {}

          try {
            const chkAutoSmart = document.getElementById("chk-auto-smart");
            if (chkAutoSmart) chkAutoSmart.checked = false;
          } catch {}

          try {
            const select = document.getElementById("filtro-objetivo-mapa");
            if (select && String(select.value || "") !== String(selectedValueArg || "")) {
              select.value = String(selectedValueArg || "");
            }
          } catch {}

          try {
            if (
              window.CentinelasAutomation &&
              typeof window.CentinelasAutomation.showObjectiveByName === "function"
            ) {
              await window.CentinelasAutomation.showObjectiveByName(objectiveNameArg);
              return;
            }
          } catch {}

          try {
            if (
              window.CentinelasMapAutomation &&
              typeof window.CentinelasMapAutomation.focusObjectiveByName === "function"
            ) {
              await window.CentinelasMapAutomation.focusObjectiveByName(objectiveNameArg, {
                zoom: 16,
                source: "agent_lock_objective",
              });
              return;
            }
          } catch {}

          try {
            const filtro = document.getElementById("filtro-objetivo-mapa");
            if (filtro && String(filtro.value || "") !== String(selectedValueArg || "")) {
              filtro.value = String(selectedValueArg || "");
              filtro.dispatchEvent(new Event("change", { bubbles: true }));
            }
          } catch {}
        },
        { objectiveNameArg: objectiveName, selectedValueArg: selectedValue }
      );

      await sleep(1500);
    } catch (err) {
      console.error("Error manteniendo el objetivo fijado:", err.message);
      await sleep(2000);
    }
  }
}

async function main() {
  const objectiveName = process.argv[2];
  const panelUrl = process.argv[3];

  if (!objectiveName || !panelUrl) {
    throw new Error('Uso: node show-centinelas-objective.js "Objetivo" "URL"');
  }

  installCleanupHandlers();
  await acquireSingleInstanceLock(objectiveName);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = await getCentinelasPage(browser, panelUrl);

  await attachDialogHandler(page);
  await resetPanel(page, panelUrl);
  await disableAutoCenterAndClearGuard(page);
  await waitForAutomationReady(page);

  const focused = await focusObjectiveWithStableApi(page, objectiveName);
  const selected = await resolveObjectiveValueForLock(page, objectiveName);

  console.log(
    `OK objetivo mostrado: ${objectiveName} -> ${selected.text} (${selected.value}) via ${focused.source}`
  );

  await lockObjectiveForever(page, objectiveName, selected.value);
}

main().catch((err) => {
  console.error(
    `Error: ${err.message}. Asegúrate de que el Chrome dedicado esté abierto con --remote-debugging-port=9222.`
  );
  removeLockFileIfOwned();
  process.exit(1);
});
