import { chromium } from "playwright";

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

async function openObjectiveFilter(page) {
  const select = page.locator("#filtro-objetivo-mapa").first();
  await select.waitFor({ timeout: 15000 });
  return select;
}

async function selectObjectiveInDropdown(page, objectiveName) {
  const target = normalizeText(objectiveName);
  const select = await openObjectiveFilter(page);

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

  await select.selectOption(best.value);
  await sleep(1500);

  return best;
}

async function tryCenterOnMap(page) {
  await safeClick(page, [
    '#btn-centrar-todos',
    'button:has-text("Centrar")'
  ]);

  await sleep(1200);
}

async function main() {
  const objectiveName = process.argv[2];
  const panelUrl = process.argv[3];

  if (!objectiveName || !panelUrl) {
    throw new Error('Uso: node show-centinelas-objective.js "Objetivo" "URL"');
  }

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = await getCentinelasPage(browser, panelUrl);

  await attachDialogHandler(page);
  await resetPanel(page, panelUrl);

  const selected = await selectObjectiveInDropdown(page, objectiveName);
  await tryCenterOnMap(page);

  console.log(
    `OK objetivo mostrado: ${objectiveName} -> ${selected.text} (${selected.value})`
  );
}

main().catch((err) => {
  console.error(
    `Error: ${err.message}. Asegúrate de que el Chrome dedicado esté abierto con --remote-debugging-port=9222.`
  );
  process.exit(1);
});