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
      await sleep(1200);
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

  await sleep(3500);

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

async function resolveGuardCandidates(page, guardName) {
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

    const getName = (d) =>
      String(
        d?.nombre ?? d?.name ?? d?.guardiaNombre ?? d?.alias ?? d?.displayName ?? ""
      ).trim();

    const getId = (d) =>
      String(d?.id ?? d?.dispositivoId ?? d?.guardiaId ?? "").replace(/[^\d]/g, "");

    const target = normalize(name);
    const devices = Array.isArray(window.dispositivos) ? window.dispositivos : [];

    const candidates = devices
      .map((d) => {
        const label = getName(d);
        const txt = normalize(label);
        if (!txt) return null;

        let score = -1;
        if (txt === target) score = 100;
        else if (txt.startsWith(target)) score = 80;
        else if (txt.includes(target)) score = 60;
        else if (target.includes(txt) && txt.length > 3) score = 40;

        if (score < 0) return null;

        return {
          id: getId(d),
          nombre: label,
          score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.nombre.localeCompare(b.nombre));

    const bestScore = candidates.length ? candidates[0].score : -1;
    const best = candidates.filter((c) => c.score === bestScore);

    return {
      candidates: best.slice(0, 10),
    };
  }, guardName);

  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (!candidates.length) {
    throw new Error(`No encontré al guardia ${guardName}.`);
  }

  const distinctIds = [...new Set(candidates.map((c) => c.id).filter(Boolean))];
  if (distinctIds.length > 1) {
    const labels = candidates.map((c) => `${c.nombre} (${c.id || "sin-id"})`);
    throw new Error(
      `Encontré varios guardias para "${guardName}": ${labels.slice(0, 4).join(", ")}. Usa un nombre más específico.`
    );
  }

  return candidates[0];
}

async function focusGuardWithStableApi(page, candidate) {
  const result = await page.evaluate(async ({ guardName, guardId }) => {
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

      if (guardId && typeof window.selectGuardiaUnified === "function") {
        const d = await window.selectGuardiaUnified(guardId, {
          source: "agent_show_centinelas_guard",
          zoom: 17,
          center: true,
        });
        if (d) {
          response.ok = true;
          response.source = "selectGuardiaUnified";
          response.detail = d;
          return response;
        }
      }

      if (
        window.CentinelasAutomation &&
        typeof window.CentinelasAutomation.showGuardByName === "function"
      ) {
        const r = await window.CentinelasAutomation.showGuardByName(guardName);
        response.ok = !!r?.ok;
        response.source = "CentinelasAutomation.showGuardByName";
        response.detail = r || null;
        return response;
      }

      if (
        window.CentinelasMapAutomation &&
        typeof window.CentinelasMapAutomation.focusGuardByName === "function"
      ) {
        const r = await window.CentinelasMapAutomation.focusGuardByName(guardName, {
          zoom: 17,
          source: "agent_show_centinelas_guard",
        });
        response.ok = !!r?.ok;
        response.source = "CentinelasMapAutomation.focusGuardByName";
        response.detail = r || null;
        return response;
      }

      if (typeof window.selectGuardiaByName === "function") {
        const d = await window.selectGuardiaByName(guardName, {
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
  }, { guardName: candidate.nombre, guardId: candidate.id });

  if (!result?.ok) {
    throw new Error(result?.error || "No se pudo enfocar el guardia con la API estable");
  }

  return result;
}

async function stabilizeOnce(page) {
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
  await sleep(700);
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

  const candidate = await resolveGuardCandidates(page, guardName);
  const focused = await focusGuardWithStableApi(page, candidate);
  await stabilizeOnce(page);

  console.log(
    `OK guardia mostrado: ${candidate.nombre} (${candidate.id || "sin-id"}) via ${focused.source}`
  );

  await sleep(1200);
  removeLockFileIfOwned();
  process.exit(0);
}

main().catch((err) => {
  console.error(
    `Error: ${err.message}. Asegúrate de que el Chrome dedicado esté abierto con --remote-debugging-port=9222.`
  );
  removeLockFileIfOwned();
  process.exit(1);
});
