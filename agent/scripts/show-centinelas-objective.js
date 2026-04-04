import { chromium } from "playwright";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

async function safeClick(page, selectors) {
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.count()) {
      try {
        await el.click({ timeout: 2000 });
        return true;
      } catch {}
    }
  }
  return false;
}

async function tryFillSearch(page, objectiveName) {
  const possibleInputs = [
    'input[type="search"]',
    'input[placeholder*="Buscar"]',
    'input[placeholder*="buscar"]',
    'input[placeholder*="Objetivo"]',
    'input[placeholder*="objetivo"]',
    'input[name*="buscar"]',
    'input[name*="objetivo"]'
  ];

  for (const selector of possibleInputs) {
    const input = page.locator(selector).first();
    if (await input.count()) {
      try {
        await input.click({ timeout: 2000 });
        await input.fill("");
        await input.fill(objectiveName);
        await sleep(1200);
        return true;
      } catch {}
    }
  }

  return false;
}

async function clickObjectiveByText(page, objectiveName) {
  const target = normalizeText(objectiveName);
  const candidates = page.locator("button, a, div, li, span, td");

  const count = await candidates.count();

  for (let i = 0; i < Math.min(count, 1000); i++) {
    const el = candidates.nth(i);

    try {
      const text = await el.innerText({ timeout: 200 });
      if (!text) continue;

      if (normalizeText(text).includes(target)) {
        try {
          await el.click({ timeout: 2000 });
          return true;
        } catch {}
      }
    } catch {}
  }

  return false;
}

async function getPage(browser, panelUrl) {
  const contexts = browser.contexts();
  let context = contexts[0];

  if (!context) {
    throw new Error("No encontré un contexto abierto en Chrome.");
  }

  let pages = context.pages();
  let page =
    pages.find((p) => (p.url() || "").includes("centinela-security-zttw.onrender.com")) ||
    pages[0];

  if (!page) {
    page = await context.newPage();
  }

  if (!page.url() || page.url() === "about:blank") {
    await page.goto(panelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  }

  return page;
}

async function main() {
  const objectiveName = process.argv[2];
  const panelUrl = process.argv[3];

  if (!objectiveName || !panelUrl) {
    throw new Error('Uso: node show-centinelas-objective.js "Objetivo" "URL"');
  }

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = await getPage(browser, panelUrl);

  if (!page.url().includes("centinela-security-zttw.onrender.com")) {
    await page.goto(panelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  }

  await page.bringToFront();
  await sleep(5000);

  await safeClick(page, [
    'button:has-text("Cerrar")',
    'button:has-text("Aceptar")',
    'button:has-text("Entendido")'
  ]);

  await tryFillSearch(page, objectiveName);

  await safeClick(page, [
    'button:has-text("Objetivos")',
    'a:has-text("Objetivos")',
    'button:has-text("Mapa")',
    'a:has-text("Mapa")'
  ]);

  await sleep(1500);

  const found = await clickObjectiveByText(page, objectiveName);

  if (!found) {
    throw new Error(`No pude localizar el objetivo: ${objectiveName}`);
  }

  await sleep(2000);
  console.log(`OK objetivo mostrado: ${objectiveName}`);
}

main().catch((err) => {
  console.error(
    `Error: ${err.message}. Asegúrate de abrir Chrome con --remote-debugging-port=9222 y tu Profile 2.`
  );
  process.exit(1);
});