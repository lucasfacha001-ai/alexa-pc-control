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
        windowsHide: true
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
    startedAt: new Date().toISOString()
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
    timeout: 60000
  });
  return page;
}

async function resetPanel(page, panelUrl) {
  await page.bringToFront();

  try {
    await page.goto(panelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  } catch {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  }

  await sleep(5000);

  await safeClick(page, [
    'button:has-text("Cerrar")',
    'button:has-text("Aceptar")',
    'button:has-text("Entendido")',
    'button:has-text("OK")'
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

async function openObjectiveFilter(page) {
  const select = page.locator("#filtro-objetivo-mapa").first();
  await select.waitFor({ timeout: 15000 });
  return select;
}

async function selectObjectiveInDropdown(page, objectiveName) {
  const target = normalizeText(objectiveName);
  const select = await openObjectiveFilter(page);

  await page.waitForFunction(() => {
    const el = document.querySelector("#filtro-objetivo-mapa");
    return el && el.options && el.options.length > 1;
  }, { timeout: 15000 });

  const options = await select.locator("option").evaluateAll((nodes) =>
    nodes.map((n) => ({
      value: n.value,
      text: (n.textContent || "").trim()
    }))
  );

  let best = null;
  let bestScore = -1;

  for (const opt of options) {
    const txt = normalizeText(opt.text);
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
    throw new Error(`No encontré el objetivo en el selector: ${objectiveName}`);
  }

  console.log("Seleccionando objetivo:", best.text);

  await select.selectOption(best.value);
  await sleep(1500);

  return best;
}

async function centerSelectedObjective(page) {
  await page.evaluate(() => {
    try {
      const filtroObjMapa = document.getElementById("filtro-objetivo-mapa");
      const id = filtroObjMapa?.value || "";
      if (!id) return;

      const obj =
        typeof window.findObjetivo === "function"
          ? window.findObjetivo(id)
          : (window.objetivos || []).find((o) => String(o?.id) === String(id));

      if (!obj || obj.lat == null || obj.lng == null || !window.map) return;

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

      if (typeof window.map.flyTo === "function") {
        window.map.flyTo([obj.lat, obj.lng], 17, {
          animate: true,
          duration: 0.8
        });
      } else if (typeof window.map.setView === "function") {
        window.map.setView([obj.lat, obj.lng], 17);
      }

      if (typeof window.renderObjetivosAdmin === "function") {
        window.renderObjetivosAdmin();
      }
      if (typeof window.renderDispositivosAdmin === "function") {
        window.renderDispositivosAdmin();
      }
    } catch {}
  });

  await sleep(1200);
}

async function stillOwnLock() {
  const current = readLockFile();
  return current && Number(current.pid) === Number(process.pid);
}

async function lockObjectiveForever(page, selectedValue) {
  console.log(`Bloqueando objetivo seleccionado indefinidamente: ${selectedValue}`);

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

      await page.evaluate((value) => {
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
          const filtro = document.getElementById("filtro-objetivo-mapa");
          if (!filtro) return;

          if (String(filtro.value) !== String(value)) {
            filtro.value = String(value);
            filtro.dispatchEvent(new Event("change", { bubbles: true }));
          }

          const id = filtro.value || "";
          if (!id) return;

          const obj =
            typeof window.findObjetivo === "function"
              ? window.findObjetivo(id)
              : (window.objetivos || []).find((o) => String(o?.id) === String(id));

          if (!obj || obj.lat == null || obj.lng == null || !window.map) return;

          if (typeof window.map.setView === "function") {
            window.map.setView([obj.lat, obj.lng], 17);
          }

          if (typeof window.renderObjetivosAdmin === "function") {
            window.renderObjetivosAdmin();
          }
          if (typeof window.renderDispositivosAdmin === "function") {
            window.renderDispositivosAdmin();
          }
        } catch {}
      }, selectedValue);

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

  const selected = await selectObjectiveInDropdown(page, objectiveName);
  await centerSelectedObjective(page);

  console.log(
    `OK objetivo mostrado: ${objectiveName} -> ${selected.text} (${selected.value})`
  );

  await lockObjectiveForever(page, selected.value);
}

main().catch((err) => {
  console.error(
    `Error: ${err.message}. Asegúrate de que el Chrome dedicado esté abierto con --remote-debugging-port=9222.`
  );
  removeLockFileIfOwned();
  process.exit(1);
});