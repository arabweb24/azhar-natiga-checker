#!/usr/bin/env node
"use strict";

/*
 * azhar-natiga-checker
 * --------------------
 * A polite, personal auto-retry checker for the Al-Azhar results portal
 * (https://natiga.azhar.eg/). It searches by a single national ID, keeps
 * retrying while the site is overloaded on results day, and stops as soon as
 * a result is shown — saving a screenshot + the page text and alerting you.
 *
 * Design goals (please keep them):
 *   - One national ID per run (your own). Not a mass scraper.
 *   - Respects the site: a sane interval with jitter, never faster than the
 *     site's own 5s cooldown, images/fonts blocked to stay light.
 *   - No CAPTCHA solving, no anti-bot evasion.
 */

const fs = require("fs");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error(
    "\n✖ مكتبة playwright غير مثبتة. شغّل الأوامر التالية:\n" +
      "    npm install\n" +
      "    npx playwright install chromium\n"
  );
  process.exit(1);
}

// ----------------------------- config ---------------------------------------

const ROOT = path.resolve(__dirname, "..");
const DEFAULTS = require("./config.default.json");

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    console.error(`✖ تعذّر قراءة ملف الإعدادات ${file}: ${e.message}`);
    process.exit(1);
  }
  return {};
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--calibrate") out._calibrate = true;
    else if (a === "--headed") out.headless = false;
    else if (a === "--headless") out.headless = true;
    else if (a === "--id") out.nationalId = argv[++i];
    else if (a === "--interval") out.intervalSeconds = Number(argv[++i]);
    else if (a === "--max") out.maxAttempts = Number(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--config") out._configPath = argv[++i];
    else if (a === "--help" || a === "-h") out._help = true;
    else console.warn(`⚠ وسيط غير معروف: ${a}`);
  }
  return out;
}

function loadConfig() {
  const cli = parseArgs(process.argv);
  const configPath = cli._configPath
    ? path.resolve(cli._configPath)
    : path.join(ROOT, "config.json");
  const fileCfg = readJsonIfExists(configPath);
  // precedence: CLI > config.json > defaults
  const cfg = Object.assign({}, DEFAULTS, fileCfg, cli);
  cfg._calibrate = !!cli._calibrate;
  cfg._help = !!cli._help;
  return cfg;
}

// ----------------------------- helpers --------------------------------------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  console.log(`[${stamp()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Ask the user a question on the terminal and resolve with the typed answer.
function promptLine(question) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  });
}

// Get a valid national ID: from config/CLI, else ask interactively (up to 3 tries).
async function resolveNationalId(cfg) {
  const valid = (v) => /^\d{6,}$/.test(String(v || "").trim());
  let id = cfg.nationalId ? String(cfg.nationalId).trim() : "";
  if (valid(id)) return id;

  if (process.stdin.isTTY) {
    for (let i = 0; i < 3 && !valid(id); i++) {
      id = await promptLine("↩ اكتب الرقم القومي واضغط Enter: ");
      if (!valid(id)) console.log("  ✖ رقم غير صالح (لازم أرقام فقط). حاول تاني.");
    }
  }
  return valid(id) ? id : "";
}

function tsForFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function classify(text, cfg) {
  const t = text || "";
  const hit = (list) => (list || []).find((k) => k && t.includes(k));

  const notFound = hit(cfg.notFoundKeywords);
  if (notFound) return { status: "notfound", reason: notFound };

  const success = hit(cfg.successKeywords);
  if (success) return { status: "success", reason: success };

  const err = hit(cfg.errorKeywords);
  if (err) return { status: "error", reason: err };

  return { status: "retry", reason: "لا مؤشرات واضحة بعد" };
}

// Find the national-ID input in the page and fill it. Runs in the page context
// so it works regardless of the exact markup: prefers an input whose
// label/placeholder/aria hints at "national id", else the first editable input.
async function fillNationalId(page, id, hint) {
  return page.evaluate(
    ({ id, hint }) => {
      const editable = Array.from(
        document.querySelectorAll("input, textarea")
      ).filter((el) => {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "submit", "button", "checkbox", "radio", "file"].includes(type))
          return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (el.disabled || el.readOnly) return false;
        return el.offsetParent !== null || style.position === "fixed";
      });

      if (editable.length === 0) return { ok: false, reason: "no-input" };

      const scoreOf = (el) => {
        const hay = [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("name"),
          el.getAttribute("id"),
          el.labels && el.labels[0] ? el.labels[0].textContent : "",
        ]
          .filter(Boolean)
          .join(" ");
        return hint && hay.includes(hint) ? 1 : 0;
      };

      editable.sort((a, b) => scoreOf(b) - scoreOf(a));
      const target = editable[0];
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(target, id);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.focus();
      return { ok: true, matched: scoreOf(target) === 1 };
    },
    { id, hint }
  );
}

// Click the search button (skipping the cooldown state). Falls back to Enter.
async function triggerSearch(page, cfg) {
  const deadline = Date.now() + 35000; // wait out any cooldown up to 35s

  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      ({ searchText, cooldownText }) => {
        const clickables = Array.from(
          document.querySelectorAll(
            "button, a, input[type=submit], input[type=button], [role=button]"
          )
        );
        const visible = (el) => {
          const s = window.getComputedStyle(el);
          return (
            s.display !== "none" &&
            s.visibility !== "hidden" &&
            (el.offsetParent !== null || s.position === "fixed")
          );
        };
        const textOf = (el) =>
          (el.value || el.textContent || "").replace(/\s+/g, " ").trim();

        const candidates = clickables.filter(visible);

        // A button currently in cooldown ("انتظر ..") — search not ready yet.
        const inCooldown = candidates.some(
          (el) => cooldownText && textOf(el).includes(cooldownText) && !el.disabled === false
        );

        const searchBtn = candidates.find(
          (el) =>
            textOf(el).includes(searchText) &&
            !textOf(el).includes(cooldownText) &&
            !el.disabled
        );

        if (searchBtn) {
          searchBtn.click();
          return "clicked";
        }
        // Any disabled/cooldown search button present → wait.
        const anyCooldown = candidates.find(
          (el) =>
            (cooldownText && textOf(el).includes(cooldownText)) ||
            (textOf(el).includes(searchText) && el.disabled)
        );
        if (anyCooldown || inCooldown) return "cooldown";
        return "none";
      },
      { searchText: cfg.searchButtonText, cooldownText: cfg.cooldownButtonText }
    );

    if (clicked === "clicked") return "clicked";
    if (clicked === "none") {
      // No obvious button — try submitting via Enter on the focused input.
      await page.keyboard.press("Enter").catch(() => {});
      return "enter";
    }
    // cooldown → wait a beat and retry
    await sleep(1500);
  }
  // Timed out waiting for the button — last resort.
  await page.keyboard.press("Enter").catch(() => {});
  return "enter-timeout";
}

async function grabText(page) {
  try {
    return await page.evaluate(() => document.body.innerText || "");
  } catch (e) {
    return "";
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function saveResult(page, cfg, text, tag) {
  const dir = path.isAbsolute(cfg.outputDir)
    ? cfg.outputDir
    : path.join(ROOT, cfg.outputDir);
  ensureDir(dir);
  const base = `${cfg.nationalId || "result"}-${tsForFile()}${tag ? "-" + tag : ""}`;
  const pngPath = path.join(dir, base + ".png");
  const txtPath = path.join(dir, base + ".txt");
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  fs.writeFileSync(txtPath, text || "", "utf8");
  return { pngPath, txtPath };
}

function printHelp() {
  console.log(`
azhar-natiga-checker — متابعة نتيجة الأزهر بالرقم القومي

الاستخدام:
  node src/index.js --id 30xxxxxxxxxxxx [--interval 20] [--max 500] [--headed]
  node src/index.js --calibrate --headed        # جولة تشخيص واحدة لضبط الكلمات المفتاحية

الخيارات:
  --id <رقم>         الرقم القومي المراد البحث عنه (أو ضعه في config.json)
  --interval <ثواني> الفاصل الزمني بين المحاولات (افتراضي 20، الحد الأدنى 5)
  --max <عدد>        أقصى عدد محاولات قبل التوقف (افتراضي 500)
  --url <رابط>       رابط الموقع (افتراضي https://natiga.azhar.eg/)
  --headed           إظهار نافذة المتصفح (للمراقبة/التشخيص)
  --headless         إخفاء المتصفح (الوضع الافتراضي)
  --config <ملف>     مسار ملف إعدادات مخصص (افتراضي config.json)
  --calibrate        تنفيذ بحث واحد وطباعة نص الصفحة كاملًا لضبط الكشف
  --help             عرض هذه المساعدة
`);
}

// Launch a browser as robustly as possible on Windows:
//   1) the system Edge / Chrome (present on virtually every Windows PC, no download),
//   2) Playwright's bundled Chromium,
//   3) if a browser binary is missing/quarantined, auto-install it once and retry.
async function launchBrowser(cfg) {
  const headless = cfg.headless !== false;
  const attempts = [];

  const channels =
    cfg.browserChannels && cfg.browserChannels.length
      ? cfg.browserChannels
      : ["msedge", "chrome"];
  for (const channel of channels) {
    attempts.push({
      label: `المتصفح المثبّت (${channel})`,
      opts: { headless, channel },
    });
  }
  attempts.push({ label: "متصفح Playwright المدمج", opts: { headless } });

  let lastErr;
  for (const a of attempts) {
    try {
      const browser = await chromium.launch(a.opts);
      log(`تم فتح المتصفح: ${a.label}`);
      return browser;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e).split("\n")[0];
      log(`تعذّر فتح ${a.label} — ${msg}`);
    }
  }

  // Last resort: (re)install the bundled Chromium, then launch it.
  try {
    const { execSync } = require("child_process");
    log("بحاول أثبّت متصفح Playwright تلقائيًا... (مرة واحدة، محتاج إنترنت)");
    execSync("npx playwright install chromium", { cwd: ROOT, stdio: "inherit" });
    const browser = await chromium.launch({ headless });
    log("تم فتح المتصفح: متصفح Playwright المدمج (بعد التثبيت)");
    return browser;
  } catch (e) {
    lastErr = e;
  }

  console.error(
    "\n✖ تعذّر فتح أي متصفح على الجهاز. جرّب مرة واحدة يدويًا:\n" +
      "      npx playwright install chromium\n" +
      "  وتأكد إن Microsoft Edge أو Google Chrome متثبّت.\n"
  );
  throw lastErr || new Error("no browser could be launched");
}

// ----------------------------- main -----------------------------------------

async function main() {
  const cfg = loadConfig();

  if (cfg._help) {
    printHelp();
    return;
  }

  cfg.nationalId = await resolveNationalId(cfg);
  if (!cfg.nationalId) {
    console.error(
      "\n✖ لم يتم تحديد رقم قومي صالح.\n" +
        "  اكتبه لما الأداة تطلبه، أو مرّره بالأمر:\n" +
        "      node src/index.js --id 30805152302986\n" +
        "  أو ضعه داخل ملف config.json (انسخه من config.example.json)\n"
    );
    process.exit(1);
  }

  // Enforce the site's minimum cooldown; be gentle by default.
  const MIN_INTERVAL = 5;
  if (!Number.isFinite(cfg.intervalSeconds) || cfg.intervalSeconds < MIN_INTERVAL) {
    cfg.intervalSeconds = Math.max(MIN_INTERVAL, DEFAULTS.intervalSeconds);
  }

  const masked = cfg.nationalId.replace(/^(\d{3})\d+(\d{3})$/, "$1******$2");
  log(`بدء المتابعة للرقم القومي: ${masked}`);
  log(`الموقع: ${cfg.url}`);
  log(
    `الفاصل: ~${cfg.intervalSeconds}s (+حتى ${cfg.jitterSeconds}s عشوائي) | أقصى محاولات: ${cfg.maxAttempts}`
  );
  log("للإيقاف اضغط Ctrl+C في أي وقت.\n");

  const browser = await launchBrowser(cfg);
  const context = await browser.newContext({
    locale: "ar-EG",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Stay light on the overloaded server: skip images/fonts/media.
  if (cfg.blockAssets) {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });
  }

  let found = false;

  const shutdown = async (code) => {
    try {
      await browser.close();
    } catch (e) {}
    process.exit(code);
  };
  process.on("SIGINT", async () => {
    log("\nتم الإيقاف بواسطة المستخدم.");
    await shutdown(found ? 0 : 130);
  });

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      await page.goto(cfg.url, {
        waitUntil: "domcontentloaded",
        timeout: cfg.navTimeoutSeconds * 1000,
      });

      const filled = await fillNationalId(
        page,
        cfg.nationalId,
        cfg.inputLabelHint
      );
      if (!filled.ok) {
        log(`محاولة ${attempt}: لم يظهر حقل الإدخال بعد — سأعيد المحاولة.`);
      } else {
        const how = await triggerSearch(page, cfg);
        // Give the result time to render / the request to return.
        await page
          .waitForLoadState("networkidle", {
            timeout: cfg.resultWaitSeconds * 1000,
          })
          .catch(() => {});
        await sleep(1200);

        const text = await grabText(page);

        if (cfg._calibrate) {
          log("=== وضع التشخيص: نص الصفحة بعد البحث ===\n");
          console.log(text.slice(0, 4000));
          console.log("\n=== نهاية النص ===");
          const saved = await saveResult(page, cfg, text, "calibrate");
          log(`تم حفظ لقطة الشاشة: ${saved.pngPath}`);
          await shutdown(0);
          return;
        }

        const verdict = classify(text, cfg);

        if (verdict.status === "success") {
          found = true;
          const saved = await saveResult(page, cfg, text, "FOUND");
          process.stdout.write("\u0007"); // terminal bell
          log("");
          log("🎉🎉  ظهرت النتيجة!  🎉🎉");
          log(`المؤشر: «${verdict.reason}»`);
          log(`لقطة الشاشة: ${saved.pngPath}`);
          log(`النص الكامل: ${saved.txtPath}`);
          log("");
          console.log("----- ملخص النص -----");
          console.log(text.slice(0, 1500));
          console.log("---------------------");
          await shutdown(0);
          return;
        }

        if (verdict.status === "notfound") {
          log(
            `محاولة ${attempt}: «${verdict.reason}» — ` +
              (cfg.stopOnNotFound
                ? "إيقاف (stopOnNotFound=true). تأكد من الرقم القومي."
                : "قد تكون النتيجة لم تُرفع بعد؛ سأكمل المحاولة.")
          );
          if (cfg.stopOnNotFound) {
            await saveResult(page, cfg, text, "notfound");
            await shutdown(2);
            return;
          }
        } else if (verdict.status === "error") {
          log(`محاولة ${attempt}: الموقع مشغول/خطأ («${verdict.reason}») — إعادة المحاولة.`);
        } else {
          log(`محاولة ${attempt}: لا نتيجة واضحة بعد (${how}) — إعادة المحاولة.`);
        }
      }
    } catch (e) {
      const short = String(e && e.message ? e.message : e).split("\n")[0];
      log(`محاولة ${attempt}: تعذّر الوصول (${short}) — إعادة المحاولة.`);
    }

    if (attempt < cfg.maxAttempts) {
      const jitter = Math.floor(Math.random() * (cfg.jitterSeconds + 1));
      const waitS = cfg.intervalSeconds + jitter;
      await sleep(waitS * 1000);
    }
  }

  log(`انتهت المحاولات (${cfg.maxAttempts}) دون ظهور النتيجة. جرّب لاحقًا.`);
  await shutdown(3);
}

main().catch(async (e) => {
  console.error("خطأ غير متوقع:", e);
  process.exit(1);
});
