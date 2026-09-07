#!/usr/bin/env python3
"""
VirtualYard Dealer Portal - Stock Control Scraper (ALL tabs)
============================================================
Tabs:
  0 = Available     4 = Contracted
  1 = On Order      5 = Bookings
  2 = On Hold       6 = Delivered
  3 = Assigned      7 = ALL (skipped — duplicate of above)

Output: virtualyard_stock_<timestamp>.json
"""

import requests
import json
import re
import time
from datetime import datetime
from html.parser import HTMLParser

# ─────────────────────────────────────────────
#  !! REPLACE THIS WITH YOUR ACTUAL COOKIE !!
SESSION_COOKIE = "__stripe_mid=c19a295b-a527-4020-a618-551150e206333d1141; _hjSessionUser_3296536=eyJpZCI6ImFmMzFlNDQ2LWY4NWUtNWE5OS05YzcxLWM2ZmFlNTJiODI2MyIsImNyZWF0ZWQiOjE3ODc2MzI3ODc3MTIsImV4aXN0aW5nIjp0cnVlfQ==; PHPSESSID=628dhsgt4qhla88g1riei60m32; _hjSession_3296536=eyJpZCI6ImIyNjkzMjNlLWJhYWEtNGRjYy1iOGRlLWNjNjUxMTNmOTdkMCIsImMiOjE3ODc4MDU4Njg1NzEsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowLCJzcCI6MH0=; __stripe_sid=d91ddafb-225c-46f1-9ff2-0a5e38e9845df393e6"
# ─────────────────────────────────────────────

BASE_URL      = "https://dealers.virtualyard.com.au"
DATATABLE_URL = f"{BASE_URL}/ajax/datatable/search.php"
MENU_ID       = 226
PAGE_SIZE     = 100

STOCK_TABS = {
    0: "Available",
    1: "On Order",
    2: "On Hold",
    3: "Assigned",
    4: "Contracted",
    5: "Bookings",
    6: "Delivered",
    # 7 = ALL — skipped to avoid duplication
}


# ── HTML helpers ─────────────────────────────────────────────────────────────

class _Strip(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, d):
        d = d.strip()
        if d:
            self.parts.append(d)


def strip_html(raw: str, sep: str = " | ") -> str:
    if not raw:
        return ""
    p = _Strip()
    p.feed(raw)
    return sep.join(p.parts)


# ── Field parsers ─────────────────────────────────────────────────────────────

def parse_vin(cell: str) -> str:
    m = re.search(r"<strong>([^<]+)</strong>", cell)
    return m.group(1).strip() if m else ""


def parse_location_code(cell: str) -> str:
    # The label span that follows the VIN <strong>
    m = re.search(r"<strong>[^<]+</strong><br><span[^>]*>([^<]*)</span>", cell)
    return m.group(1).strip() if m else ""


def parse_vehicle(cell: str) -> dict:
    """
    Extracts vehicle name and the card table fields:
    BUILT, Complied, Engine #, Battery #, Colour, Floorplan, Interior, Port
    """
    # Vehicle name from the loadPage anchor
    name_match = re.search(r'class="loadPage"[^>]*>([^<]+)</a>', cell)
    name = name_match.group(1).strip() if name_match else ""

    # Card table — pairs of <td>label</td><td>value</td>
    pairs = re.findall(r"<td>([^<]*)</td><td>(.*?)</td>", cell)
    info = {}
    for key, val in pairs:
        key = key.strip()
        if key:
            info[key] = strip_html(val).strip()

    return {
        "name":           name,
        "built":          info.get("BUILT", ""),
        "complied":       info.get("Complied", ""),
        "engine_number":  info.get("Engine #", ""),
        "battery_number": info.get("Battery #", ""),
        "colour":         info.get("Colour", ""),
        "interior":       info.get("Interior", ""),
        "floorplan":      info.get("Floorplan", ""),
        "port":           info.get("Port", ""),
    }


def parse_row(row: list, tab_label: str) -> dict:
    vehicle = parse_vehicle(row[2])
    return {
        "tab":            tab_label,
        "id":             row[0],
        "vin":            parse_vin(row[1]),
        "location_code":  parse_location_code(row[1]),
        **vehicle,
    }


# ── Fetch ─────────────────────────────────────────────────────────────────────

def build_params(tab: int, start: int, length: int) -> dict:
    params = {
        "menuId":           MENU_ID,
        "tab":              tab,
        "stage":            0,
        "draw":             1,
        "start":            start,
        "length":           length,
        "order[0][column]": 0,
        "order[0][dir]":    "desc",
        "search[value]":    "",
        "search[regex]":    "false",
        "ssrFilters":       "",
        "parent":           "",
        "child":            "",
        "params":           "",
        "_":                int(time.time() * 1000),
    }
    for i in range(4):
        params[f"columns[{i}][data]"]          = i
        params[f"columns[{i}][name]"]          = ""
        params[f"columns[{i}][searchable]"]    = "true"
        params[f"columns[{i}][orderable]"]     = "true" if i == 0 else "false"
        params[f"columns[{i}][search][value]"] = ""
        params[f"columns[{i}][search][regex]"] = "false"
    return params


def fetch_page(session, tab: int, start: int):
    try:
        r = session.get(
            DATATABLE_URL,
            params=build_params(tab, start, PAGE_SIZE),
            timeout=30,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  ✗ tab={tab} start={start}: {e}")
        return None


def scrape_tab(session, tab_index: int, tab_label: str) -> list:
    print(f"\n── {tab_label} (tab={tab_index}) ──")

    data = fetch_page(session, tab_index, 0)
    if not data:
        return []

    page_rows = data.get("data", [])
    reported  = data.get("recordsFiltered", 0)
    actual    = len(page_rows)

    rows = [parse_row(r, tab_label) for r in page_rows]

    # If the server returned fewer rows than a full page, we already have all
    if actual < PAGE_SIZE:
        print(f"  Records: {actual}  (server reported {reported})")
        return rows

    # Full page — keep paginating until a short page signals the end
    print(f"  Records: {reported}  (paginating…)")
    start = PAGE_SIZE
    while True:
        print(f"  Fetching {start}–{start + PAGE_SIZE - 1}…")
        data = fetch_page(session, tab_index, start)
        if not data:
            break
        page_rows = data.get("data", [])
        rows += [parse_row(r, tab_label) for r in page_rows]
        start += PAGE_SIZE
        time.sleep(0.3)

        if len(page_rows) < PAGE_SIZE:
            break

    print(f"  Fetched: {len(rows)} total")
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not SESSION_COOKIE or SESSION_COOKIE == "YOUR_SESSION_COOKIE_HERE":
        print("⚠  Set SESSION_COOKIE at the top of this script first.")
        return

    session = requests.Session()
    session.headers.update({
        "Cookie":           SESSION_COOKIE,
        "Accept":           "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer":          f"{BASE_URL}/",
        "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
    })

    print(f"VirtualYard Stock Control Scraper  [{datetime.now().strftime('%Y-%m-%d %H:%M')}]")
    print("=" * 55)

    all_rows = []
    for tab_index, tab_label in STOCK_TABS.items():
        all_rows += scrape_tab(session, tab_index, tab_label)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file  = f"virtualyard_stock_{timestamp}.json"

    output = {
        "exported_at":   datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_vehicles": len(all_rows),
        "vehicles":      all_rows,
    }
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Saved {len(all_rows)} vehicles → {out_file}")

    from collections import Counter
    by_tab = Counter(r["tab"] for r in all_rows)
    print("\nSummary by tab:")
    for tab in STOCK_TABS.values():
        print(f"  {tab:15s}  {by_tab.get(tab, 0):5d} vehicles")
    print(f"  {'TOTAL':15s}  {len(all_rows):5d} vehicles")


if __name__ == "__main__":
    main()