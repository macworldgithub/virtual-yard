/**
 * scraper.js — VirtualYard → output.json
 * Usage: node scraper.js
 */

const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const fs = require("fs");

// ── PASTE YOUR COOKIE HERE ──────────────────────────────────────────────────
const VY_COOKIE =
  "__stripe_mid=c19a295b-a527-4020-a618-551150e206333d1141; _hjSessionUser_3296536=eyJpZCI6ImFmMzFlNDQ2LWY4NWUtNWE5OS05YzcxLWM2ZmFlNTJiODI2MyIsImNyZWF0ZWQiOjE3ODc2MzI3ODc3MTIsImV4aXN0aW5nIjp0cnVlfQ==; PHPSESSID=628dhsgt4qhla88g1riei60m32; _hjSession_3296536=eyJpZCI6ImIyNjkzMjNlLWJhYWEtNGRjYy1iOGRlLWNjNjUxMTNmOTdkMCIsImMiOjE3ODc4MDU4Njg1NzEsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowLCJzcCI6MH0=; __stripe_sid=d91ddafb-225c-46f1-9ff2-0a5e38e9845df393e6";
// ───────────────────────────────────────────────────────────────────────────

const OUTPUT_FILE = "output.json";
const BASE_URL = "https://dealers.virtualyard.com.au";
const PAGE_SIZE = 50; // lowered from 100 — more stable
const DELAY_MS = 500; // slightly more polite

// All tabs and stages — scrape every combination
const LEAD_TABS = [0, 2, 3, 4, 5]; // 0=inbox 2=follow_up 3=overdue 4=done 5=archive
const STAGES = [0, 1, 2, 3, 4, 5]; // 0=all 1=new 2=assigned 3=in_contract 4=deal 5=complete

const SOURCES = [
  { menuId: 245, type: "lead", label: "Leads" },
  { menuId: 899, type: "test_drive", label: "Test Drives" },
];

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

const MAKES = [
  "BYD",
  "Toyota",
  "Honda",
  "Mazda",
  "Ford",
  "Hyundai",
  "Kia",
  "Mitsubishi",
  "Nissan",
  "Subaru",
  "Volkswagen",
  "Mercedes",
  "BMW",
  "Audi",
  "Lexus",
  "Tesla",
  "MG",
  "GWM",
  "Haval",
  "Chery",
  "Isuzu",
  "Jeep",
  "Land Rover",
  "Suzuki",
  "Volvo",
  "Peugeot",
  "Renault",
  "Skoda",
  "Seat",
  "Fiat",
];

// ─── HTTP ────────────────────────────────────────────────────────────────────
function makeHeaders() {
  return {
    Cookie: VY_COOKIE,
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

// ─── HTML helpers ────────────────────────────────────────────────────────────
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
        const val = $(tds[i + 1])
          .text()
          .trim();
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

// ─── Row parsers ─────────────────────────────────────────────────────────────
function parseLeadRow(cells, menuId, tab, stage) {
  const customerId = extractAttr(cells[1], "button[data-id]", "data-id") || "";
  const leadIdMatch = String(cells[7]).match(/leadId=(\d+)/);
  const leadId = leadIdMatch ? leadIdMatch[1] : "";
  const externalId =
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
  const vehicleParsed = parseVehicleString(vehicleText);

  return {
    externalId,
    type: "lead",
    vyLeadId: leadId,
    vyCustomerId: customerId,
    isBusinessCustomer: (nameAnchor.attr("data-page") || "") === "business",
    fullName,
    firstName: nameParts[0] || "",
    lastName: nameParts.slice(1).join(" ") || "",
    source: meta["Source"] || "",
    assignedTo: meta["Assigned To"] || "",
    vyStageText: meta["Stage"] || "",
    lastContact: meta["Last Contact"] || "",
    leadDate: meta["Date"] || null,
    previewText,
    status: stripHtml(cells[6]),
    vyTab: tab,
    vyTabLabel: TAB_LABELS[tab] || String(tab),
    vyStage: stage,
    vyStageLabel: STAGE_LABELS[stage] || String(stage),
    menuId,
    vehicle: {
      vyVehicleId: vehicleIdMatch ? vehicleIdMatch[1] : "",
      raw: vehicleText,
      year: vehicleParsed.year,
      colour: vehicleParsed.colour,
      make: vehicleParsed.make,
      model: vehicleParsed.model,
      yard: vehicleMeta["Yard"] || "",
      stockNo: vehicleMeta["Stock#"] || "",
      price: vehicleMeta["Price"] || "",
    },
    scrapedAt: new Date().toISOString(),
  };
}

function parseTestDriveRow(cells, menuId, tab, stage) {
  const externalId = String(cells[0]).trim();
  const $2 = cheerio.load(String(cells[2]));
  const nameAnchor = $2("a.loadPage").first();
  const fullName = nameAnchor.text().trim();
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const leadIdMatch = (nameAnchor.attr("data-id") || "").match(/leadId=(\d+)/);
  const meta = parseCardTable($2, "body");
  const $5 = cheerio.load(String(cells[5]));

  return {
    externalId,
    type: "test_drive",
    vyLeadId: leadIdMatch ? leadIdMatch[1] : "",
    fullName,
    firstName: nameParts[0] || "",
    lastName: nameParts.slice(1).join(" ") || "",
    email: meta["Email"] || "",
    phone: meta["Phone"] || "",
    location: meta["Location"] || "",
    status: $5("a.loadPage").first().text().trim(),
    testDriveDate: $5("span.label").first().text().trim() || null,
    vyTab: tab,
    vyTabLabel: TAB_LABELS[tab] || String(tab),
    vyStage: stage,
    vyStageLabel: STAGE_LABELS[stage] || String(stage),
    menuId,
    scrapedAt: new Date().toISOString(),
  };
}

function parseRow(row, type, menuId, tab, stage) {
  const cells = Array.isArray(row) ? row : Object.values(row);
  return type === "test_drive"
    ? parseTestDriveRow(cells, menuId, tab, stage)
    : parseLeadRow(cells, menuId, tab, stage);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────
async function fetchPage(menuId, tab, stage, start) {
  const url = `${BASE_URL}/ajax/datatable/search.php?${buildParams(menuId, tab, stage, start, PAGE_SIZE)}`;
  const res = await axios.get(url, { headers: makeHeaders(), timeout: 20000 });
  return res.data;
}

// Deduplicate by externalId+type — keeps the first occurrence
function deduplicateRecords(records) {
  const seen = new Set();
  return records.filter((r) => {
    const key = `${r.type}::${r.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scrapeTabStage(source, tab, stage, allRecords) {
  let start = 0;
  let total = null;
  let fetched = 0;
  let emptyPages = 0; // safety: stop after 3 empty pages in a row

  const label = `${source.label} [${TAB_LABELS[tab] || tab}][${STAGE_LABELS[stage] || stage}]`;

  while (true) {
    let response;
    try {
      response = await fetchPage(source.menuId, tab, stage, start);
    } catch (err) {
      console.error(
        `\n  ⚠️  Request failed (${label} start=${start}):`,
        err.message,
      );
      await sleep(2000); // wait and retry once
      try {
        response = await fetchPage(source.menuId, tab, stage, start);
      } catch (err2) {
        console.error(`  ❌ Retry failed, skipping:`, err2.message);
        break;
      }
    }

    // Capture total on first page only (it can fluctuate mid-scrape)
    if (total === null) {
      total = parseInt(response.recordsTotal) || 0;
      if (total === 0) return; // nothing here — silently skip
      console.log(`  📄 ${label}: ${total} records`);
    }

    const rows = response.data || [];

    if (rows.length === 0) {
      emptyPages++;
      if (emptyPages >= 3) {
        console.log(
          `\n  ⚠️  Got 3 empty pages at start=${start}, stopping early (fetched ${fetched}/${total})`,
        );
        break;
      }
      await sleep(1000);
      continue; // retry same page
    }

    emptyPages = 0; // reset on successful page

    for (const row of rows) {
      try {
        allRecords.push(parseRow(row, source.type, source.menuId, tab, stage));
        fetched++;
      } catch (err) {
        console.error("\n  ⚠️  Parse error:", err.message);
      }
    }

    process.stdout.write(`\r  ⏳ ${fetched}/${total}`);

    // Stop when we've fetched everything OR server gave us a short page
    if (fetched >= total || rows.length < PAGE_SIZE) {
      process.stdout.write("\n");
      break;
    }

    start += PAGE_SIZE;
    await sleep(DELAY_MS);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!VY_COOKIE || VY_COOKIE === "PASTE_YOUR_COOKIE_HERE") {
    console.error(
      "❌ Paste your cookie into VY_COOKIE at the top of this file.",
    );
    process.exit(1);
  }

  const allRecords = [];
  const startTime = Date.now();

  for (const source of SOURCES) {
    console.log(`\n🚀 Scraping ${source.label}...`);
    const tabs = source.type === "test_drive" ? [0] : LEAD_TABS;
    const stages = source.type === "test_drive" ? [0] : STAGES;

    for (const tab of tabs) {
      for (const stage of stages) {
        await scrapeTabStage(source, tab, stage, allRecords);
        await sleep(DELAY_MS);
      }
    }
  }

  // Deduplicate — same lead can appear in multiple tab/stage combos
  const unique = deduplicateRecords(allRecords);
  const dupes = allRecords.length - unique.length;

  const output = {
    scrapedAt: new Date().toISOString(),
    totalLeads: unique.filter((r) => r.type === "lead").length,
    totalTestDrives: unique.filter((r) => r.type === "test_drive").length,
    duplicatesRemoved: dupes,
    records: unique,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`   Leads           : ${output.totalLeads}`);
  console.log(`   Test Drives     : ${output.totalTestDrives}`);
  console.log(`   Duplicates removed: ${dupes}`);
  console.log(`   Output          : ${OUTPUT_FILE}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
