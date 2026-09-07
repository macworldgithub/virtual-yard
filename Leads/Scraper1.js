/**
 * scraper.js — Full VirtualYard → MongoDB scraper.
 *
 * Run probe.js FIRST to confirm field mapping, then update
 * parseRow() below to match the actual column positions.
 *
 * Usage: node scraper.js
 *
 * What it does:
 *   - Loops through all tab × stage combinations for Leads + Test Drives
 *   - Paginates every combination until all records are fetched
 *   - Upserts each record into MongoDB (safe to re-run — no duplicates)
 *   - Prints a summary at the end
 */

require("dotenv").config();
const axios = require("axios");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
const Lead = require("./lead.model");

// ─── Config ────────────────────────────────────────────────────────────────
const BASE_URL = "https://dealers.virtualyard.com.au";
const PAGE_SIZE = 100; // max records per request (bump down if server rejects)
const DELAY_MS = 400; // delay between requests — be polite to the server

// All tab numbers to scrape (0-6). We'll discover which have data.
const TABS = [0, 1, 2, 3, 4, 5, 6];
// All stage numbers to scrape (0-5). 0 is usually "ALL".
const STAGES = [0]; // start with 0 (ALL) — avoids double-counting

const SOURCES = [
  { menuId: 245, type: "lead", label: "Leads" },
  { menuId: 899, type: "test_drive", label: "Test Drives" },
];

// ─── Tab/stage label maps (update after probe.js runs) ─────────────────────
// These are our best guesses — probe.js will confirm the actual mapping.
const TAB_LABELS = {
  0: "inbox",
  1: "sent",
  2: "follow_up",
  3: "overdue",
  4: "done",
  5: "archive",
  6: "lost",
};

const STAGE_LABELS = {
  0: "all",
  1: "new",
  2: "assigned",
  3: "in_contract",
  4: "deal",
  5: "complete",
};

// ─── HTTP client ────────────────────────────────────────────────────────────
function makeHeaders() {
  return {
    Cookie: process.env.VY_COOKIE,
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

// ─── HTML parser helpers ────────────────────────────────────────────────────
// VirtualYard DataTable cells often contain HTML — strip it to get text.
function stripHtml(html) {
  if (!html) return "";
  const $ = cheerio.load(String(html));
  return $.text().trim();
}

// Extract a data-attribute or href from HTML cell
function extractAttr(html, selector, attr) {
  if (!html) return "";
  const $ = cheerio.load(String(html));
  return $(selector).attr(attr) || "";
}

// ─── Row parser ─────────────────────────────────────────────────────────────
// ⚠️  UPDATE THESE COLUMN INDICES after running probe.js
// The column positions below are placeholders — probe.js will show
// exactly what each index contains.
function parseRow(row, type, menuId, tab, stage) {
  // row is either an array (most common) or an object
  const cells = Array.isArray(row) ? row : Object.values(row);

  // Strip HTML from all cells first
  const c = cells.map(stripHtml);

  // ── PLACEHOLDER MAPPING ──────────────────────────────────────────
  // TODO: Update column indices after probe.js runs.
  // Typical VirtualYard leads layout (verify with probe output):
  //   [0] = row actions HTML (contains the record ID as data-id)
  //   [1] = customer name
  //   [2] = phone / contact
  //   [3] = vehicle interest
  //   [4] = salesperson / assigned
  //   [5] = stage / status label
  //   [6] = date / time
  //   [7] = extra info

  // Extract the external ID from the action cell HTML (column 0)
  // VY typically puts it as data-id="12345" on an anchor or button
  const externalId =
    extractAttr(cells[0], "[data-id]", "data-id") ||
    extractAttr(cells[0], "a", "data-id") ||
    extractAttr(cells[0], "button", "data-id") ||
    // Fallback: try to pull an ID from a URL like /ajax/...?id=123
    (cells[0].match(/[?&]id=(\d+)/) || [])[1] ||
    // Last resort: hash the row content (not ideal but prevents crashes)
    require("crypto")
      .createHash("md5")
      .update(JSON.stringify(row))
      .digest("hex");

  // Parse full name into first/last
  const fullName = c[1] || "";
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  return {
    externalId,
    externalSource: "virtualyard",
    type,
    menuId,
    vyTab: tab,
    vyStage: stage,
    vyTabLabel: TAB_LABELS[tab] || String(tab),
    vyStageLabel: STAGE_LABELS[stage] || String(stage),
    fullName,
    firstName,
    lastName,
    // Phone — update column index after probe
    phone: c[2] || "",
    // Vehicle — update column index after probe
    vehicle: {
      model: c[3] || "",
    },
    // Assigned salesperson — update column index after probe
    assignedTo: c[4] || "",
    salesperson: c[4] || "",
    // Raw data stored so we can re-parse later once mapping is confirmed
    rawData: row,
    scrapedAt: new Date(),
  };
}

// ─── Fetch one page ─────────────────────────────────────────────────────────
async function fetchPage(menuId, tab, stage, start) {
  const url = `${BASE_URL}/ajax/datatable/search.php?${buildParams(menuId, tab, stage, start, PAGE_SIZE)}`;
  const res = await axios.get(url, { headers: makeHeaders(), timeout: 15000 });
  return res.data; // { draw, recordsTotal, recordsFiltered, data: [...] }
}

// ─── Upsert one lead into MongoDB ───────────────────────────────────────────
async function upsertLead(doc) {
  await Lead.findOneAndUpdate(
    { externalId: doc.externalId, type: doc.type },
    { $set: doc },
    { upsert: true, new: true },
  );
}

// ─── Scrape one tab+stage combination ───────────────────────────────────────
async function scrapeTabStage(source, tab, stage, stats) {
  let start = 0;
  let total = null;
  let fetched = 0;

  while (true) {
    let response;
    try {
      response = await fetchPage(source.menuId, tab, stage, start);
    } catch (err) {
      console.error(
        `    ⚠️  Request failed (tab=${tab} stage=${stage} start=${start}):`,
        err.message,
      );
      break;
    }

    if (total === null) {
      total = response.recordsTotal || 0;
      if (total === 0) break; // nothing here — skip
      console.log(
        `    📄 ${source.label} tab=${tab} stage=${stage}: ${total} records total`,
      );
    }

    const rows = response.data || [];
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const doc = parseRow(row, source.type, source.menuId, tab, stage);
        await upsertLead(doc);
        stats.upserted++;
      } catch (err) {
        console.error("    ⚠️  Parse/upsert error:", err.message);
        stats.errors++;
      }
    }

    fetched += rows.length;
    if (fetched >= total) break;
    start += PAGE_SIZE;
    await sleep(DELAY_MS);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const cookie = process.env.VY_COOKIE;
  if (!cookie || cookie === "your_cookie_string_here") {
    console.error("❌ VY_COOKIE not set in .env");
    process.exit(1);
  }

  const mongoUri =
    process.env.MONGO_URI || "mongodb://localhost:27017/tradie_agent";
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected\n");

  const stats = { upserted: 0, errors: 0 };
  const startTime = Date.now();

  for (const source of SOURCES) {
    console.log(`\n🚀 Scraping ${source.label} (menuId=${source.menuId})`);

    for (const tab of TABS) {
      for (const stage of STAGES) {
        await scrapeTabStage(source, tab, stage, stats);
        await sleep(DELAY_MS);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`   Upserted: ${stats.upserted}`);
  console.log(`   Errors:   ${stats.errors}`);

  await mongoose.disconnect();
  console.log("🔌 MongoDB disconnected");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
