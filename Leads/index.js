/**
 * scraper.js — VirtualYard → output.json (MongoDB-ready)
 * Usage: node scraper.js
 *
 * AUTO-COOKIE: reads your live Chrome session cookie automatically.
 * Uses sqlite3 (prebuilt Windows binary, no compiler needed) + PowerShell
 * for DPAPI decryption — no Python, no native addons beyond sqlite3.
 *
 * One-time setup (run once in this folder):
 *   npm install sqlite3
 *
 * Then just make sure you're logged in to VirtualYard in Chrome and run:
 *   node scraper.js
 *
 * IMPORTANT: Chrome must be fully closed before running, otherwise it locks
 * the cookie database. The script copies the DB to a temp file first to
 * work around this in most cases.
 *
 * If auto-cookie fails for any reason, paste a cookie into FALLBACK_COOKIE below.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

// ── FALLBACK: only used if auto-cookie extraction fails ───────────────────────
const FALLBACK_COOKIE = ""; // paste a cookie here only as a last resort
// ─────────────────────────────────────────────────────────────────────────────

const OUTPUT_FILE = "both.json";
const BASE_URL = "https://dealers.virtualyard.com.au";
const TARGET_DOMAIN = "dealers.virtualyard.com.au";
const PAGE_SIZE = 50;
const DELAY_MS = 300;

// ─── Auto-cookie: direct Chrome SQLite read + PowerShell DPAPI decrypt ────────

function getChromeCookiePath() {
  // Try all known Chrome profile locations on Windows
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(base, "Google", "Chrome", "User Data", "Default", "Network", "Cookies"),
    path.join(base, "Google", "Chrome", "User Data", "Default", "Cookies"),
    path.join(base, "Google", "Chrome", "User Data", "Profile 1", "Network", "Cookies"),
    path.join(base, "Google", "Chrome", "User Data", "Profile 1", "Cookies"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getChromeMasterKey() {
  // Chrome stores an AES key encrypted with Windows DPAPI in Local State
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const localStatePath = path.join(base, "Google", "Chrome", "User Data", "Local State");
  if (!fs.existsSync(localStatePath)) return null;

  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
    if (!encryptedKeyB64) return null;

    // The key is base64-encoded, prefixed with "DPAPI"
    const encryptedKey = Buffer.from(encryptedKeyB64, "base64").slice(5); // strip "DPAPI" prefix

    // Decrypt with PowerShell (uses Windows DPAPI, no extra tools needed)
    const ps = `
      $bytes = [System.Convert]::FromBase64String('${encryptedKey.toString("base64")}')
      $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
      [System.Console]::Write([System.Convert]::ToBase64String($dec))
    `.trim().replace(/\n\s+/g, "; ");

    const result = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return Buffer.from(result, "base64"); // 32-byte AES key
  } catch (err) {
    console.warn("⚠️  Could not decrypt Chrome master key:", err.message);
    return null;
  }
}

function decryptCookieValue(encryptedValue, masterKey) {
  if (!encryptedValue || encryptedValue.length === 0) return "";

  try {
    const buf = Buffer.isBuffer(encryptedValue)
      ? encryptedValue
      : Buffer.from(encryptedValue);

    // Chrome v80+: prefix "v10" or "v11", then 12-byte nonce, then ciphertext+16-byte tag
    const prefix = buf.slice(0, 3).toString("utf8");
    if ((prefix === "v10" || prefix === "v11") && masterKey) {
      const nonce = buf.slice(3, 15);
      const ciphertextAndTag = buf.slice(15);
      const ciphertext = ciphertextAndTag.slice(0, ciphertextAndTag.length - 16);
      const tag = ciphertextAndTag.slice(ciphertextAndTag.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    }

    // Older Chrome: DPAPI-encrypted directly (no v10 prefix)
    // Fall back to empty string — these are rare on modern Chrome
    return "";
  } catch (_) {
    return "";
  }
}

async function copyLockedFile(src, dst) {
  // Strategy 1: direct copy (works if Chrome is closed)
  try {
    fs.copyFileSync(src, dst);
    return true;
  } catch (_) {}

  // Strategy 2: robocopy — Windows built-in tool that can copy locked files
  try {
    const srcDir  = path.dirname(src);
    const srcFile = path.basename(src);
    const dstDir  = path.dirname(dst);
    const dstFile = path.basename(dst);
    execSync(
      `robocopy "${srcDir}" "${dstDir}" "${srcFile}" /NFL /NDL /NJH /NJS /NC /NS /NP`,
      { stdio: ["pipe","pipe","pipe"], timeout: 15000 }
    );
    // robocopy copies using the filename; rename to our expected dst name if different
    const roboDst = path.join(dstDir, srcFile);
    if (roboDst !== dst && fs.existsSync(roboDst)) fs.renameSync(roboDst, dst);
    if (fs.existsSync(dst)) return true;
  } catch (_) {}

  // Strategy 3: PowerShell Volume Shadow Copy (VSS) — bypasses all file locks
  try {
    const ps = `
      $s = (Get-WmiObject -List Win32_ShadowCopy).Create("C:\\\\","ClientAccessible")
      $id = $s.ShadowID
      $shadow = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq $id }
      $vol = $shadow.DeviceObject + "\\\\"
      $rel = "${src.replace(/\\/g, '\\\\').replace(/^C:\\\\/i, '')}".TrimStart("\\\\")
      Copy-Item ($vol + $rel) "${dst.replace(/\\/g, '\\\\')}" -Force
      $shadow.Delete()
    `.trim().replace(/\n\s+/g, "; ");
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
      stdio: ["pipe","pipe","pipe"], timeout: 30000
    });
    if (fs.existsSync(dst)) return true;
  } catch (_) {}

  return false;
}

async function fetchCookieFromChrome() {
  // Check sqlite3 is available
  let Database;
  try {
    Database = require("sqlite3").verbose().Database;
  } catch (_) {
    console.warn(`⚠️  sqlite3 is not installed.
   Run this once:  npm install sqlite3
   Then re-run:    node scraper.js`);
    return null;
  }

  const cookiePath = getChromeCookiePath();
  if (!cookiePath) {
    console.warn("⚠️  Chrome cookie file not found. Is Chrome installed?");
    return null;
  }

  // Copy using progressively more powerful strategies to bypass Chrome's lock
  const tmpPath = path.join(os.tmpdir(), "_vy_chrome_cookies.db");
  const copied = await copyLockedFile(cookiePath, tmpPath);
  if (!copied) {
    console.warn("⚠️  Could not copy Chrome cookie DB despite all strategies.\n" +
      "   Close Chrome completely and re-run, or set FALLBACK_COOKIE.");
    return null;
  }

  const masterKey = getChromeMasterKey();
  if (!masterKey) {
    console.warn("⚠️  Could not get Chrome master key — cookie values may be empty.");
  }

  return new Promise((resolve) => {
    const db = new Database(tmpPath, (err) => {
      if (err) {
        console.warn("⚠️  Could not open cookie DB:", err.message);
        return resolve(null);
      }

      const sql = `
        SELECT name, encrypted_value
        FROM cookies
        WHERE host_key LIKE '%${TARGET_DOMAIN}%'
          AND (expires_utc = 0 OR expires_utc > ${Date.now() * 1000})
      `;

      db.all(sql, [], (err, rows) => {
        db.close();
        try { fs.unlinkSync(tmpPath); } catch (_) {}

        if (err) {
          console.warn("⚠️  SQLite query failed:", err.message);
          return resolve(null);
        }

        if (!rows || rows.length === 0) {
          console.warn(`⚠️  No cookies found for ${TARGET_DOMAIN} in Chrome.\n` +
            "   Make sure you are logged in to VirtualYard in Chrome.");
          return resolve(null);
        }

        const parts = rows
          .map((row) => {
            const val = decryptCookieValue(row.encrypted_value, masterKey);
            return val ? `${row.name}=${val}` : null;
          })
          .filter(Boolean);

        resolve(parts.length > 0 ? parts.join("; ") : null);
      });
    });
  });
}

async function getCookie() {
  console.log("🔍 Attempting to auto-extract cookie from Chrome...");
  const auto = await fetchCookieFromChrome();

  if (auto) {
    if (auto.includes("PHPSESSID")) {
      console.log("🍪 Cookie auto-extracted from Chrome (PHPSESSID ✓)");
    } else {
      console.warn("⚠️  Cookies found but no PHPSESSID — are you logged in to VirtualYard in Chrome?");
    }
    return auto;
  }

  if (FALLBACK_COOKIE) {
    console.log("⚠️  Using FALLBACK_COOKIE from script.");
    return FALLBACK_COOKIE;
  }

  console.error(`
❌ Could not get a session cookie automatically.

Steps to fix:
  1. npm install sqlite3            (if not done yet)
  2. Log in to VirtualYard in Chrome
  3. node scraper.js                (Chrome can stay open — we copy the DB)

If it still fails, paste your cookie string into FALLBACK_COOKIE at the top of this file.
`);
  process.exit(1);
}

const LEAD_TABS = [
  { tab: 0, label: "inbox" },
  { tab: 2, label: "follow_up" },
  { tab: 3, label: "overdue" },
  { tab: 4, label: "done" },
  { tab: 5, label: "archive" },
];

const LEAD_STAGES = [
  { stage: 0, label: "new" },
  { stage: 1, label: "assigned" },
  { stage: 2, label: "in_contact" },
  { stage: 3, label: "deal" },
  { stage: 4, label: "complete" },
];

const SOURCES = [
  { menuId: 245, type: "lead", label: "Leads" },
  { menuId: 899, type: "test_drive", label: "Test Drives" },
];

const MAKES = [
  "BYD", "Toyota", "Honda", "Mazda", "Ford", "Hyundai", "Kia",
  "Mitsubishi", "Nissan", "Subaru", "Volkswagen", "Mercedes", "BMW",
  "Audi", "Lexus", "Tesla", "MG", "GWM", "Haval", "Chery", "Isuzu",
  "Jeep", "Land Rover", "Suzuki", "Volvo", "Peugeot", "Renault",
  "Skoda", "Seat", "Fiat",
];

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function makeHeaders(cookie) {
  return {
    Cookie: cookie,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${BASE_URL}/render.php?page=leads&params=&menuId=245`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
}

function buildParams(menuId, tab, stage, start, length) {
  const p = new URLSearchParams();
  p.set("menuId", menuId);
  p.set("tab", tab);
  p.set("stage", stage);
  p.set("draw", 1);
  for (let i = 0; i <= 7; i++) {
    p.set(`columns[${i}][data]`, i);
    p.set(`columns[${i}][name]`, "");
    p.set(`columns[${i}][searchable]`, "true");
    p.set(`columns[${i}][orderable]`, i === 0 ? "true" : "false");
    p.set(`columns[${i}][search][value]`, "");
    p.set(`columns[${i}][search][regex]`, "false");
  }
  p.set("order[0][column]", 0);
  p.set("order[0][dir]", "desc");
  p.set("start", start);
  p.set("length", length);
  p.set("search[value]", "");
  p.set("search[regex]", "false");
  p.set("ssrFilters", "");
  p.set("parent", "");
  p.set("child", "");
  p.set("params", "");
  p.set("ssrDateRange[startDate]", "");
  p.set("ssrDateRange[endDate]", "");
  p.set("_", Date.now());
  return p.toString();
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function stripHtml(html) {
  if (!html) return "";
  return cheerio.load(String(html)).text().trim();
}

function extractAttr(html, selector, attr) {
  if (!html) return "";
  return cheerio.load(String(html))(selector).attr(attr) || "";
}

function parseCardTable($, context) {
  const data = {};
  $(context)
    .find("table.card tr")
    .each((_, tr) => {
      const tds = $(tr).find("td");
      for (let i = 0; i < tds.length - 1; i += 2) {
        const key = $(tds[i]).text().trim().replace(/:$/, "");
        const val = $(tds[i + 1]).text().trim();
        if (key) data[key] = val;
      }
    });
  return data;
}

function parseVehicleString(str) {
  if (!str) return { year: null, colour: "", make: "", model: "" };
  const parts = str.trim().split(/\s+/);
  const year = /^\d{4}$/.test(parts[0]) ? parseInt(parts[0]) : null;
  const rest = year ? parts.slice(1) : parts;
  const makeIdx = rest.findIndex((p) =>
    MAKES.some((m) => m.toLowerCase() === p.toLowerCase()),
  );
  if (makeIdx > 0) {
    return {
      year,
      colour: rest.slice(0, makeIdx).join(" "),
      make: rest[makeIdx],
      model: rest.slice(makeIdx + 1).join(" "),
    };
  }
  return { year, colour: "", make: "", model: rest.join(" ") };
}

// ─── Row parsers ──────────────────────────────────────────────────────────────
function parseLeadRow(cells, tabLabel, stageLabel) {
  const customerId = extractAttr(cells[1], "button[data-id]", "data-id") || "";
  const leadIdMatch = String(cells[7]).match(/leadId=(\d+)/);
  const leadId = leadIdMatch ? leadIdMatch[1] : "";
  const _id =
    leadId ||
    customerId ||
    crypto.createHash("md5").update(JSON.stringify(cells)).digest("hex");

  const $2 = cheerio.load(String(cells[2]));
  const nameAnchor = $2("a.loadPage").first();
  const fullName = nameAnchor.text().trim();
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const meta = parseCardTable($2, "body");
  const previewText = $2("span.lead-body-preview").text().trim();

  const $3 = cheerio.load(String(cells[3]));
  const vehicleAnchor = $3("a.loadPage").first();
  const vehicleText = vehicleAnchor.text().trim();
  const vehicleIdMatch = (vehicleAnchor.attr("data-id") || "").match(
    /vehicleId=(\d+)/,
  );
  const vehicleMeta = parseCardTable($3, "body");
  const vp = parseVehicleString(vehicleText);

  const rawPrice = vehicleMeta["Price"] || "";
  const price = rawPrice
    ? parseFloat(rawPrice.replace(/[^0-9.]/g, "")) || null
    : null;
  const leadDate = meta["Date"] ? new Date(meta["Date"]) : null;

  return {
    _id,
    leadId,
    customerId,
    type: "lead",
    tab: tabLabel,
    stage: stageLabel,
    stageText: meta["Stage"] || "",
    customer: {
      fullName,
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      isBusiness: (nameAnchor.attr("data-page") || "") === "business",
    },
    source: meta["Source"] || "",
    assignedTo: meta["Assigned To"] || "",
    lastContact: meta["Last Contact"] || "",
    leadDate,
    status: stripHtml(cells[6]),
    previewText,
    vehicle: {
      vehicleId: vehicleIdMatch ? vehicleIdMatch[1] : "",
      raw: vehicleText,
      year: vp.year,
      colour: vp.colour,
      make: vp.make,
      model: vp.model,
      yard: vehicleMeta["Yard"] || "",
      stockNo: vehicleMeta["Stock#"] || "",
      priceRaw: rawPrice,
      price,
    },
    scrapedAt: new Date(),
  };
}

function parseTestDriveRow(cells) {
  const _id = String(cells[0]).trim();
  const $2 = cheerio.load(String(cells[2]));
  const nameAnchor = $2("a.loadPage").first();
  const fullName = nameAnchor.text().trim();
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const leadIdMatch = (nameAnchor.attr("data-id") || "").match(/leadId=(\d+)/);
  const meta = parseCardTable($2, "body");
  const $5 = cheerio.load(String(cells[5]));
  const dateRaw = $5("span.label").first().text().trim() || null;

  return {
    _id,
    leadId: leadIdMatch ? leadIdMatch[1] : "",
    type: "test_drive",
    customer: {
      fullName,
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: meta["Email"] || "",
      phone: meta["Phone"] || "",
    },
    location: meta["Location"] || "",
    status: $5("a.loadPage").first().text().trim(),
    testDriveDate: dateRaw ? new Date(dateRaw) : null,
    scrapedAt: new Date(),
  };
}

function parseRow(row, type, tabLabel, stageLabel) {
  const cells = Array.isArray(row) ? row : Object.values(row);
  return type === "test_drive"
    ? parseTestDriveRow(cells)
    : parseLeadRow(cells, tabLabel, stageLabel);
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchPage(cookie, menuId, tab, stage, start) {
  const url = `${BASE_URL}/ajax/datatable/search.php?${buildParams(menuId, tab, stage, start, PAGE_SIZE)}`;
  const res = await axios.get(url, {
    headers: makeHeaders(cookie),
    timeout: 20000,
  });

  // Detect session expiry — server returns HTML login page instead of JSON
  if (typeof res.data === "string" && res.data.includes("<form")) {
    throw new Error("SESSION_EXPIRED");
  }

  return res.data;
}

// ─── Scrape one tab+stage combo ───────────────────────────────────────────────
async function scrapeCombo(cookie, source, tab, tabLabel, stage, stageLabel, seen, allRecords) {
  const label = `${source.label} [${tabLabel}][${stageLabel}]`;

  let response;
  try {
    response = await fetchPage(cookie, source.menuId, tab, stage, 0);
  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      console.error(`\n❌ Session expired mid-scrape. Re-run the script (browser-cookie3 will pick up the new session).`);
      process.exit(1);
    }
    console.error(`\n  ⚠️  Initial fetch failed (${label}):`, err.message);
    return;
  }

  const reportedTotal = parseInt(response.recordsTotal) || 0;
  if (reportedTotal === 0) return;

  process.stdout.write(`  📄 ${label}: ~${reportedTotal} records`);

  let fetched = 0;
  let start = 0;

  processRows(response.data || [], source.type, tabLabel, stageLabel, seen, allRecords, (n) => { fetched += n; });

  let page = response;
  while ((page.data || []).length > 0) {
    start += PAGE_SIZE;
    await sleep(DELAY_MS);

    let next = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        next = await fetchPage(cookie, source.menuId, tab, stage, start);
        break;
      } catch (err) {
        if (err.message === "SESSION_EXPIRED") {
          console.error(`\n❌ Session expired mid-scrape. Re-run the script.`);
          process.exit(1);
        }
        console.error(`\n  ⚠️  Attempt ${attempt}/3 (${label} start=${start}):`, err.message);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    if (!next) {
      console.error(`\n  ❌ All retries failed at start=${start} (fetched ${fetched})`);
      break;
    }

    page = next;
    processRows(page.data || [], source.type, tabLabel, stageLabel, seen, allRecords, (n) => { fetched += n; });
    process.stdout.write(`\r  📄 ${label}: ${fetched} fetched (${seen.size} unique total)`);
  }

  process.stdout.write(`\n`);
}

function processRows(rows, type, tabLabel, stageLabel, seen, allRecords, countCb) {
  let added = 0;
  let total = 0;
  for (const row of rows) {
    try {
      const record = parseRow(row, type, tabLabel, stageLabel);
      const key = `${record.type}::${record._id}`;
      total++;
      if (!seen.has(key)) {
        seen.add(key);
        allRecords.push(record);
        added++;
      }
    } catch (err) {
      console.error("\n  ⚠️  Parse error:", err.message);
    }
  }
  if (countCb) countCb(total);
  return added;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cookie = await getCookie();

  const allRecords = [];
  const seen = new Set();
  const startTime = Date.now();

  for (const source of SOURCES) {
    console.log(`\n🚀 Scraping ${source.label}...`);

    if (source.type === "test_drive") {
      await scrapeCombo(cookie, source, 0, "all", 0, "all", seen, allRecords);
    } else {
      for (const { tab, label: tabLabel } of LEAD_TABS) {
        for (const { stage, label: stageLabel } of LEAD_STAGES) {
          await scrapeCombo(cookie, source, tab, tabLabel, stage, stageLabel, seen, allRecords);
          await sleep(DELAY_MS);
        }
      }
    }
  }

  const leads = allRecords.filter((r) => r.type === "lead");
  const testDrives = allRecords.filter((r) => r.type === "test_drive");

  const output = {
    scrapedAt: new Date().toISOString(),
    summary: { totalLeads: leads.length, totalTestDrives: testDrives.length },
    leads,
    testDrives,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`   Leads      : ${leads.length}`);
  console.log(`   Test Drives: ${testDrives.length}`);
  console.log(`   Output     : ${OUTPUT_FILE}`);
  console.log(`\n💡 Mongo import:`);
  console.log(`   mongoimport --db yourdb --collection leads      --jsonArray --file both.json --jsonPath '$.leads'`);
  console.log(`   mongoimport --db yourdb --collection testDrives --jsonArray --file both.json --jsonPath '$.testDrives'`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});