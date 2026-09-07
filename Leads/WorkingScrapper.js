/**
 * scraper.js — VirtualYard → output.json (MongoDB-ready)
 * Usage: node scraper.js
 *
 * CONFIRMED API BEHAVIOUR (from network inspection):
 *   - `stage` is the real filter: 1=new 2=assigned 3=in_contract 4=deal 5=complete
 *   - `tab` param is IGNORED by the server — stage filters globally across all tabs
 *   - The "tab" grouping (inbox/overdue/follow_up etc.) shown in the UI is derived
 *     from each lead's own data (last-contact timing etc.), not a server-side filter
 *   - stage=0 (all) = sum of 1-5, skip it
 *
 *   So: scrape stage 1-5 once each. No tab loop needed.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const fs = require("fs");

// ── PASTE YOUR COOKIE HERE ──────────────────────────────────────────────────
const VY_COOKIE =
  "__stripe_mid=c19a295b-a527-4020-a618-551150e206333d1141; _hjSessionUser_3296536=eyJpZCI6ImFmMzFlNDQ2LWY4NWUtNWE5OS05YzcxLWM2ZmFlNTJiODI2MyIsImNyZWF0ZWQiOjE3ODc2MzI3ODc3MTIsImV4aXN0aW5nIjp0cnVlfQ==; PHPSESSID=628dhsgt4qhla88g1riei60m32; _hjSession_3296536=eyJpZCI6ImIyNjkzMjNlLWJhYWEtNGRjYy1iOGRlLWNjNjUxMTNmOTdkMCIsImMiOjE3ODc4MDU4Njg1NzEsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowLCJzcCI6MH0=; __stripe_sid=d91ddafb-225c-46f1-9ff2-0a5e38e9845df393e6";
// ───────────────────────────────────────────────────────────────────────────

const OUTPUT_FILE = "output1.json";
const BASE_URL = "https://dealers.virtualyard.com.au";
const PAGE_SIZE = 100;
const DELAY_MS = 500;

// stage param values — confirmed working from network inspection
// 1=new 2=assigned 3=in_contract 4=deal 5=complete
// 0=all (aggregate of 1-5, skip)
const LEAD_STAGES = [
  { stage: 1, label: "new" },
  { stage: 2, label: "assigned" },
  { stage: 3, label: "in_contract" },
  { stage: 4, label: "deal" },
  { stage: 5, label: "complete" },
];

const SOURCES = [
  { menuId: 245, type: "lead", label: "Leads" },
  { menuId: 899, type: "test_drive", label: "Test Drives" },
];

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

function buildParams(menuId, stage, start, length) {
  const p = new URLSearchParams();
  p.set("menuId", menuId);
  p.set("tab", 0); // ignored by server but required field
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

// ─── Row parsers ──────────────────────────────────────────────────────────────
function parseLeadRow(cells, stageLabel) {
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

  // tab label comes from the server's tree response embedded in each lead's card
  // The card's Stage field tells us the real stage text ("Assigned", "New" etc.)
  // The UI tab (inbox/overdue) is derived from timing — not stored here

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
    stage: stageLabel, // "new" | "assigned" | "in_contract" | "deal" | "complete"
    stageText: meta["Stage"] || "", // text from the card e.g. "Assigned"
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

function parseRow(row, type, stageLabel) {
  const cells = Array.isArray(row) ? row : Object.values(row);
  return type === "test_drive"
    ? parseTestDriveRow(cells)
    : parseLeadRow(cells, stageLabel);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────
async function fetchPage(menuId, stage, start) {
  const url = `${BASE_URL}/ajax/datatable/search.php?${buildParams(menuId, stage, start, PAGE_SIZE)}`;
  const res = await axios.get(url, { headers: makeHeaders(), timeout: 20000 });
  return res.data;
}

// ─── Scrape one stage ─────────────────────────────────────────────────────────
async function scrapeStage(source, stageNum, stageLabel, seen, allRecords) {
  const label = `${source.label} [${stageLabel}]`;

  let response;
  try {
    response = await fetchPage(source.menuId, stageNum, 0);
  } catch (err) {
    console.error(`\n  ⚠️  Initial fetch failed (${label}):`, err.message);
    return;
  }

  const total = parseInt(response.recordsTotal) || 0;
  if (total === 0) return;
  console.log(`  📄 ${label}: ${total} records`);

  let fetched = 0;
  let start = 0;
  let consecutiveEmpty = 0;

  fetched += processRows(
    response.data || [],
    source.type,
    stageLabel,
    seen,
    allRecords,
  );
  process.stdout.write(`\r  ⏳ ${fetched}/${total}`);

  while (fetched < total) {
    start += PAGE_SIZE;
    await sleep(DELAY_MS);

    let pageResponse = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        pageResponse = await fetchPage(source.menuId, stageNum, start);
        break;
      } catch (err) {
        console.error(
          `\n  ⚠️  Attempt ${attempt}/3 failed (${label} start=${start}):`,
          err.message,
        );
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    if (!pageResponse) {
      console.error(
        `  ❌ All retries failed at start=${start}, stopping (fetched ${fetched}/${total})`,
      );
      break;
    }

    const rows = pageResponse.data || [];

    if (rows.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        console.log(
          `\n  ⚠️  Two consecutive empty pages at start=${start}, stopping (fetched ${fetched}/${total})`,
        );
        break;
      }
      await sleep(1000);
      start -= PAGE_SIZE; // retry same offset
      continue;
    }

    consecutiveEmpty = 0;
    fetched += processRows(rows, source.type, stageLabel, seen, allRecords);
    process.stdout.write(`\r  ⏳ ${fetched}/${total}`);
  }

  process.stdout.write("\n");
}

function processRows(rows, type, stageLabel, seen, allRecords) {
  let count = 0;
  for (const row of rows) {
    try {
      const record = parseRow(row, type, stageLabel);
      const key = `${record.type}::${record._id}`;
      if (!seen.has(key)) {
        seen.add(key);
        allRecords.push(record);
      }
      count++;
    } catch (err) {
      console.error("\n  ⚠️  Parse error:", err.message);
    }
  }
  return count;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!VY_COOKIE || VY_COOKIE === "PASTE_YOUR_COOKIE_HERE") {
    console.error(
      "❌ Paste your cookie into VY_COOKIE at the top of this file.",
    );
    process.exit(1);
  }

  const allRecords = [];
  const seen = new Set();
  const startTime = Date.now();

  for (const source of SOURCES) {
    console.log(`\n🚀 Scraping ${source.label}...`);

    if (source.type === "test_drive") {
      // Test drives have no stage split — scrape all in one go (stage=0)
      await scrapeStage(source, 0, "all", seen, allRecords);
    } else {
      for (const { stage, label } of LEAD_STAGES) {
        await scrapeStage(source, stage, label, seen, allRecords);
        await sleep(DELAY_MS);
      }
    }
  }

  const leads = allRecords.filter((r) => r.type === "lead");
  const testDrives = allRecords.filter((r) => r.type === "test_drive");

  const output = {
    scrapedAt: new Date().toISOString(),
    summary: {
      totalLeads: leads.length,
      totalTestDrives: testDrives.length,
    },
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
  console.log(
    `   mongoimport --db yourdb --collection leads      --jsonArray --file output.json --jsonPath '$.leads'`,
  );
  console.log(
    `   mongoimport --db yourdb --collection testDrives --jsonArray --file output.json --jsonPath '$.testDrives'`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
