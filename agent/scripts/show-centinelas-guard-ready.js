import { chromium } from "playwright";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const LOCK_FILE = path.join(os.tmpdir(), "centinelas-guard-lock.json");
let lockOwned = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function acquireSingleInstanceLock(guardName) {
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
    guardName,
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

async function disableAutoCenter(page) {
  await page.evaluate(() => {
    try {
      window.autoCenter = false;
    } catch {}

    try {
      const chkAuto = document.getElementById("chk-auto-center");
      if (chkAuto) chkAuto.checked = false;
    } catch {}

    try {
      const chkAutoSmart = document.getElementById("chk-auto-smart");
      if (chkAutoSmart) chkAutoSmart.checked = false;
    } catch {}
  });

  await sleep(500);
}

async function waitForAutomationReady(page) {
  await page.waitForFunction(() => {
    const mapReady = !!window.map && typeof window.map.setView === "function";
    const guardApiReady =
      typeof window.selectGuardiaByName === "function" ||
      typeof window.selectGuardiaUnified === "function" ||
      (!!window.CentinelasAutomation &&
        typeof window.CentinelasAutomation.showGuardByName === "function") ||
      (!!window.CentinelasMapAutomation &&
        typeof window.CentinelasMapAutomation.focusGuardByName === "function");

    return mapReady && Array.isArray(window.dispositivos) && guardApiReady;
  }, { timeout: 30000 });
}

async function focusGuardWithStableApi(page, guardName) {
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
        typeof window.CentinelasAutomation.showGuardByName === "function"
      ) {
        const r = await window.CentinelasAutomation.showGuardByName(name);
        response.ok = !!r?.ok;
        response.source = "CentinelasAutomation.showGuardByName";
        response.detail = r || null;
        return response;
      }

      if (
        window.CentinelasMapAutomation &&
        typeof window.CentinelasMapAutomation.focusGuardByName === "function"
      ) {
        const r = await window.CentinelasMapAutomation.focusGuardByName(name, {
          zoom: 17,
          source: "agent_show_centinelas_guard",
        });
        response.ok = !!r?.ok;
        response.source = "CentinelasMapAutomation.focusGuardByName";
        response.detail = r || null;
        return response;
      }

      if (typeof window.selectGuardiaByName === "function") {
        const d = await window.selectGuardiaByName(name, {
          source: "agent_show_centinelas_guard",
          zoom: 17,
          center: true,
        });
        if (d) {
          response.ok = true;
          response.source = "selectGuardiaByName";
          response.detail = d;
          return response;
        }
      }

      throw new Error("No existe API estable de automatización para guardias.");
    } catch (err) {
      response.error = err?.message || String(err);
      return response;
    }
  }, guardName);

  if (!result?.ok) {
    throw new Error(result?.error || "No se pudo enfocar el guardia con la API estable");
  }

  return result;
}

async function resolveSelectedGuardId(page) {
  const result = await page.evaluate(() => {
    const id = String(window.guardiaSeleccionadoId || "").replace(/[^\d]/g, "");
    if (!id) {
      return { ok: false, error: "No hay guardia seleccionado" };
    }
    return { ok: true, id };
  });

  if (!result?.ok) {
    throw new Error(result?.error || "No se pudo resolver guardia seleccionado");
  }

  return result.id;
}

async function stillOwnLock() {
  const current = readLockFile();
  return current && Number(current.pid) === Number(process.pid);
}

async function lockGuardForever(page, guardName, guardId) {
  console.log(`Bloqueando guardia seleccionado indefinidamente: ${guardName}`);

  while (true) {
    try {
      if (!(await stillOwnLock())) {
        console.log("Otro guardia tomó el control. Terminando este bloqueo.");
        return;
      }

      if (page.isClosed()) {
        console.log("La página se cerró. Terminando bloqueo.");
        return;
      }

      await page.evaluate(
        async ({ guardNameArg, guardIdArg }) => {
          try {
            window.autoCenter = false;
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
            if (
              window.CentinelasAutomation &&
              typeof window.CentinelasAutomation.showGuardByName === "function"
            ) {
              await window.CentinelasAutomation.showGuardByName(guardNameArg);
              return;
            }
          } catch {}

          try {
            if (
              window.CentinelasMapAutomation &&
              typeof window.CentinelasMapAutomation.focusGuardByName === "function"
            ) {
              await window.CentinelasMapAutomation.focusGuardByName(guardNameArg, {
                zoom: 17,
                source: "agent_lock_guard",
              });
              return;
            }
          } catch {}

          try {
            if (typeof window.selectGuardiaUnified === "function") {
              window.selectGuardiaUnified(guardIdArg, {
                source: "agent_lock_guard",
                zoom: 17,
                center: true,
              });
            }
          } catch {}
        },
        { guardNameArg: guardName, guardIdArg: guardId }
      );

      await sleep(1500);
    } catch (err) {
      console.error("Error manteniendo el guardia fijado:", err.message);
      await sleep(2000);
    }
  }
}

async function main() {
  const guardName = process.argv[2];
  const panelUrl = process.argv[3];

  if (!guardName || !panelUrl) {
    throw new Error('Uso: node show-centinelas-guard.js "Guardia" "URL"');
  }

  installCleanupHandlers();
  await acquireSingleInstanceLock(guardName);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = await getCentinelasPage(browser, panelUrl);

  await attachDialogHandler(page);
  await resetPanel(page, panelUrl);
  await disableAutoCenter(page);
  await waitForAutomationReady(page);

  const focused = await focusGuardWithStableApi(page, guardName);
  const selectedGuardId = await resolveSelectedGuardId(page);

  console.log(
    `OK guardia mostrado: ${guardName} (${selectedGuardId}) via ${focused.source}`
  );

  await lockGuardForever(page, guardName, selectedGuardId);
}

main().catch((err) => {
  console.error(
    `Error: ${err.message}. Asegúrate de que el Chrome dedicado esté abierto con --remote-debugging-port=9222.`
  );
  removeLockFileIfOwned();
  process.exit(1);
});
