/**
 * probe.js — Run this FIRST to inspect the raw VirtualYard API response.
 * It prints the field structure so we can map columns correctly before
 * building the full scraper.
 *
 * Usage:
 *   1. Paste your cookie string into the VY_COOKIE variable below
 *   2. node probe.js
 */

const axios = require("axios");

// ── PASTE YOUR COOKIE HERE ──────────────────────────────────────────────────
const VY_COOKIE =
  "__stripe_mid=c19a295b-a527-4020-a618-551150e206333d1141; _hjSessionUser_3296536=eyJpZCI6ImFmMzFlNDQ2LWY4NWUtNWE5OS05YzcxLWM2ZmFlNTJiODI2MyIsImNyZWF0ZWQiOjE3ODc2MzI3ODc3MTIsImV4aXN0aW5nIjp0cnVlfQ==; PHPSESSID=628dhsgt4qhla88g1riei60m32; _hjSession_3296536=eyJpZCI6ImIyNjkzMjNlLWJhYWEtNGRjYy1iOGRlLWNjNjUxMTNmOTdkMCIsImMiOjE3ODc4MDU4Njg1NzEsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowLCJzcCI6MH0=; __stripe_sid=d91ddafb-225c-46f1-9ff2-0a5e38e9845df393e6";
// ───────────────────────────────────────────────────────────────────────────

const BASE_URL = "https://dealers.virtualyard.com.au";

// The 8-column DataTables query params (matches exactly what the browser sends)
function buildDatatableParams(menuId, tab, stage, start = 0, length = 10) {
  const params = new URLSearchParams();
  params.set("menuId", menuId);
  params.set("tab", tab);
  params.set("stage", stage);
  params.set("draw", 1);

  // 8 columns (0-7) — matching the browser request exactly
  for (let i = 0; i <= 7; i++) {
    params.set(`columns[${i}][data]`, i);
    params.set(`columns[${i}][name]`, "");
    params.set(`columns[${i}][searchable]`, "true");
    params.set(`columns[${i}][orderable]`, i === 0 ? "true" : "false");
    params.set(`columns[${i}][search][value]`, "");
    params.set(`columns[${i}][search][regex]`, "false");
  }

  params.set("order[0][column]", 0);
  params.set("order[0][dir]", "desc");
  params.set("start", start);
  params.set("length", length);
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  params.set("ssrFilters", "");
  params.set("parent", "");
  params.set("child", "");
  params.set("params", "");
  params.set("ssrDateRange[startDate]", "");
  params.set("ssrDateRange[endDate]", "");
  params.set("_", Date.now());

  return params.toString();
}

async function probe() {
  if (!VY_COOKIE || VY_COOKIE === "PASTE_YOUR_COOKIE_HERE") {
    console.error(
      "❌ Paste your cookie into the VY_COOKIE variable at the top of this file.",
    );
    process.exit(1);
  }

  const headers = {
    Cookie: VY_COOKIE,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${BASE_URL}/render.php?page=leads&params=&menuId=245`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  console.log("🔍 Probing Leads (menuId=245, tab=0, stage=0) ...\n");

  try {
    const url = `${BASE_URL}/ajax/datatable/search.php?${buildDatatableParams(245, 0, 0, 0, 5)}`;
    const res = await axios.get(url, { headers });
    const data = res.data;

    console.log("=== TOP-LEVEL RESPONSE KEYS ===");
    console.log(Object.keys(data));

    console.log("\n=== TOTALS ===");
    console.log("recordsTotal:", data.recordsTotal);
    console.log("recordsFiltered:", data.recordsFiltered);

    if (!data.data || data.data.length === 0) {
      console.log(
        "\n⚠️  data array is empty — tab=0/stage=0 may have no records.",
      );
      console.log("Full response:", JSON.stringify(data, null, 2));
      return;
    }

    console.log("\n=== FIRST ROW (raw) ===");
    console.log(JSON.stringify(data.data[0], null, 2));

    console.log("\n=== ALL ROWS SUMMARY ===");
    data.data.forEach((row, i) => {
      console.log(`\n--- Row ${i} ---`);
      if (Array.isArray(row)) {
        row.forEach((cell, j) => {
          // Truncate long HTML values for readability
          const val = String(cell).substring(0, 120);
          console.log(`  [${j}]: ${val}`);
        });
      } else {
        // Sometimes DataTables returns objects instead of arrays
        Object.entries(row).forEach(([k, v]) => {
          const val = String(v).substring(0, 120);
          console.log(`  ${k}: ${val}`);
        });
      }
    });

    // Also probe Test Drives
    console.log(
      "\n\n🔍 Probing Test Drives (menuId=899, tab=0, stage=0) ...\n",
    );
    const url2 = `${BASE_URL}/ajax/datatable/search.php?${buildDatatableParams(899, 0, 0, 0, 3)}`;
    const res2 = await axios.get(url2, { headers });
    const data2 = res2.data;

    console.log("recordsTotal:", data2.recordsTotal);
    if (data2.data && data2.data.length > 0) {
      console.log("\n=== FIRST TEST DRIVE ROW ===");
      console.log(JSON.stringify(data2.data[0], null, 2));
    } else {
      console.log("(no test drive records in tab=0/stage=0)");
    }

    // Try all tabs 0-6 to find which have data
    console.log(
      "\n\n📊 Scanning which tabs have records (leads menuId=245)...\n",
    );
    for (let tab = 0; tab <= 6; tab++) {
      const u = `${BASE_URL}/ajax/datatable/search.php?${buildDatatableParams(245, tab, 0, 0, 1)}`;
      const r = await axios.get(u, { headers });
      console.log(`  tab=${tab}: recordsTotal=${r.data.recordsTotal ?? "n/a"}`);
      await sleep(300); // be polite to the server
    }
  } catch (err) {
    if (err.response) {
      console.error(
        "❌ HTTP Error:",
        err.response.status,
        err.response.statusText,
      );
      console.error(
        "Response body:",
        String(err.response.data).substring(0, 500),
      );
    } else {
      console.error("❌ Error:", err.message);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

probe();
