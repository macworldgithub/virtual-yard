#!/usr/bin/env python3
"""
VirtualYard Dealer Portal - Quotes Scraper
==========================================
Tabs: 0=Pending  1=Ordered  2=Deleted

Usage:
  python virtualyard_quotes.py            # scrape
  python virtualyard_quotes.py --probe    # find correct menuId first
"""

import requests
import json
import re
import sys
import time
from datetime import datetime
from html.parser import HTMLParser

# ─────────────────────────────────────────────
#  !! REPLACE THIS WITH YOUR ACTUAL COOKIE !!
SESSION_COOKIE = "__stripe_mid=c19a295b-a527-4020-a618-551150e206333d1141; _hjSessionUser_3296536=eyJpZCI6ImFmMzFlNDQ2LWY4NWUtNWE5OS05YzcxLWM2ZmFlNTJiODI2MyIsImNyZWF0ZWQiOjE3ODc2MzI3ODc3MTIsImV4aXN0aW5nIjp0cnVlfQ==; PHPSESSID=628dhsgt4qhla88g1riei60m32; _hjSession_3296536=eyJpZCI6ImIyNjkzMjNlLWJhYWEtNGRjYy1iOGRlLWNjNjUxMTNmOTdkMCIsImMiOjE3ODc4MDU4Njg1NzEsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowLCJzcCI6MH0=; __stripe_sid=d91ddafb-225c-46f1-9ff2-0a5e38e9845df393e6"
# ─────────────────────────────────────────────

BASE_URL       = "https://dealers.virtualyard.com.au"
DATATABLE_URL  = f"{BASE_URL}/ajax/datatable/search.php"
QUOTES_MENU_ID = 925   # update if --probe returns a different value
PAGE_SIZE      = 100

QUOTE_TABS = {
    0: "Pending",
    1: "Ordered",
    2: "Deleted",
}


# ── HTML helpers ────────────────────────────────────────────────────────────

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


# ── Field parsers ───────────────────────────────────────────────────────────

def parse_vehicle(cell: str) -> dict:
    text  = strip_html(cell, sep="\n")
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    is_fleet = any("Fleet" in l for l in lines)
    if is_fleet and len(lines) >= 4:
        return {"order_ref": lines[0], "po_number": lines[1],
                "vehicle": lines[2], "sale_type": lines[3]}
    return {
        "order_ref": lines[0] if len(lines) > 0 else "",
        "vehicle":   lines[1] if len(lines) > 1 else "",
        "sale_type": lines[2] if len(lines) > 2 else "",
        "po_number": "",
    }

def parse_customer(cell: str) -> dict:
    result = {}
    m = re.search(r'data-page="(?:customer|business)"[^>]*>\s*([^<]+)<', cell)
    result["customer_name"] = m.group(1).strip() if m else ""
    for label, key in [
        ("Email", "email"), ("Mobile", "mobile"), ("Address", "address"),
        ("Date", "quote_date"), ("STRIPE", "stripe_id"), ("Qty", "qty"),
        ("ASSIGNED TO", "assigned_to"),
    ]:
        m = re.search(rf'<td>{re.escape(label)}<\/td><td>(.*?)<\/td>', cell)
        result[key] = strip_html(m.group(1)) if m else ""
    return result

def parse_balance(cell: str) -> str:
    m = re.search(r'\$([\d,\.]+)', cell)
    return m.group(0) if m else strip_html(cell)

def parse_accessories(cell: str) -> list:
    items = re.findall(r'label label-outline label-default">([^<]+)<', cell)
    return [i.strip() for i in items if i.strip()]

def parse_payment(cell: str) -> str:
    items = re.findall(r'label label-outline label-default">([^<]+)<', cell)
    return " | ".join(i.strip() for i in items if i.strip())

def parse_status(cell: str) -> str:
    for pat in [r'data-page="#quote"[^>]*>([^<]+)<',
                r'data-page="#order"[^>]*>([^<]+)<']:
        m = re.search(pat, cell)
        if m:
            return m.group(1).strip()
    return strip_html(cell)

def r(row: list, idx: int) -> str:
    """Safe row index access — returns '' if column doesn't exist."""
    return row[idx] if idx < len(row) else ""

def parse_row(row: list, tab_label: str) -> dict:
    vehicle  = parse_vehicle(r(row, 1))
    customer = parse_customer(r(row, 2))
    return {
        "tab":           tab_label,
        "quote_id":      r(row, 0),
        "order_ref":     vehicle["order_ref"],
        "vehicle":       vehicle["vehicle"],
        "sale_type":     vehicle["sale_type"],
        "po_number":     vehicle["po_number"],
        "customer_name": customer.get("customer_name", ""),
        "email":         customer.get("email", ""),
        "mobile":        customer.get("mobile", ""),
        "address":       customer.get("address", ""),
        "quote_date":    customer.get("quote_date", ""),
        "stripe_id":     customer.get("stripe_id", ""),
        "qty":           customer.get("qty", ""),
        "assigned_to":   customer.get("assigned_to", ""),
        "balance":       parse_balance(r(row, 3)),
        "accessories":   parse_accessories(r(row, 4)),
        "payment":       parse_payment(r(row, 5)),
        "status":        parse_status(r(row, 7)),
    }


# ── Fetch ───────────────────────────────────────────────────────────────────

def build_params(menu_id: int, tab: int, start: int, length: int) -> dict:
    params = {
        "menuId": menu_id, "tab": tab, "stage": 0, "draw": 1,
        "start": start, "length": length,
        "order[0][column]": 0, "order[0][dir]": "desc",
        "search[value]": "", "search[regex]": "false",
        "ssrFilters": "", "parent": "", "child": "", "params": "",
        "ssrDateRange[startDate]": "", "ssrDateRange[endDate]": "",
        "_": int(time.time() * 1000),
    }
    for i in range(9):
        params[f"columns[{i}][data]"]          = i
        params[f"columns[{i}][name]"]          = ""
        params[f"columns[{i}][searchable]"]    = "true"
        params[f"columns[{i}][orderable]"]     = "true" if i == 0 else "false"
        params[f"columns[{i}][search][value]"] = ""
        params[f"columns[{i}][search][regex]"] = "false"
    return params

def fetch_page(session, menu_id: int, tab: int, start: int):
    try:
        r = session.get(DATATABLE_URL,
                        params=build_params(menu_id, tab, start, PAGE_SIZE),
                        timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  ✗ menuId={menu_id} tab={tab} start={start}: {e}")
        return None

def scrape_tab(session, menu_id: int, tab_index: int, tab_label: str) -> list:
    print(f"\n── {tab_label} (tab={tab_index}) ──")

    data = fetch_page(session, menu_id, tab_index, 0)
    if not data:
        return []

    page_rows = data.get("data", [])
    reported  = data.get("recordsFiltered", 0)
    rows      = [parse_row(r, tab_label) for r in page_rows]

    # If first page is short, we already have everything
    if len(page_rows) < PAGE_SIZE:
        print(f"  Records: {len(rows)}  (server reported {reported})")
        return rows

    print(f"  Records: {reported}  (paginating…)")
    start = PAGE_SIZE
    while True:
        print(f"  Fetching {start}–{start + PAGE_SIZE - 1}…")
        data = fetch_page(session, menu_id, tab_index, start)
        if not data:
            break
        page_rows = data.get("data", [])
        rows += [parse_row(r, tab_label) for r in page_rows]
        start += PAGE_SIZE
        time.sleep(0.3)

        # Stop on a partial page — that's the real end
        if len(page_rows) < PAGE_SIZE:
            break

    print(f"  Fetched: {len(rows)} total")
    return rows


# ── Probe ───────────────────────────────────────────────────────────────────

def probe_menu_id(session) -> None:
    print("Probing menuIds 218–235 to find Quotes section…\n")
    for mid in range(218, 236):
        data = fetch_page(session, mid, 0, 0)
        total = data.get("recordsFiltered", "ERR") if data else "ERR"
        marker = "  ← has data" if isinstance(total, int) and total > 0 and mid != 222 else ""
        print(f"  menuId={mid}  tab=0  records={total}{marker}")
        time.sleep(0.15)
    print("\nUpdate QUOTES_MENU_ID in this script to the menuId marked '← has data', then run without --probe.")


# ── Main ────────────────────────────────────────────────────────────────────

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

    if "--probe" in sys.argv:
        probe_menu_id(session)
        return

    print(f"VirtualYard Quotes Scraper  [{datetime.now().strftime('%Y-%m-%d %H:%M')}]")
    print(f"menuId={QUOTES_MENU_ID}")
    print("=" * 55)

    all_rows = []
    for tab_index, tab_label in QUOTE_TABS.items():
        all_rows += scrape_tab(session, QUOTES_MENU_ID, tab_index, tab_label)

    if not all_rows:
        print("\n⚠  No quotes found. menuId may be wrong.")
        print("   Run:  python virtualyard_quotes.py --probe")
        return

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file  = f"virtualyard_quotes_{timestamp}.json"
    output = {
        "exported_at":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_quotes": len(all_rows),
        "quotes":       all_rows,
    }
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Saved {len(all_rows)} quotes → {out_file}")

    from collections import Counter
    by_tab = Counter(r["tab"] for r in all_rows)
    print("\nSummary by tab:")
    for tab in QUOTE_TABS.values():
        print(f"  {tab:10s}  {by_tab.get(tab, 0):5d} quotes")
    print(f"  {'TOTAL':10s}  {len(all_rows):5d} quotes")

if __name__ == "__main__":
    main()