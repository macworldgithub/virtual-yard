#!/usr/bin/env python3
"""
VirtualYard Dealer Portal - Orders Scraper (ALL tabs)
=====================================================
Tabs:
  0 = Ordered       3 = Contracted    6 = Cancellation
  1 = Allocated     4 = Booking       7 = Refunded
  2 = Ready         5 = Delivered     8 = ALL (skipped)
  3 = Contracted    6 = Cancellation  9 = Lost

Output: virtualyard_orders_<timestamp>.json
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
MENU_ID       = 222
PAGE_SIZE     = 100

ORDER_TABS = {
    0: "Ordered",
    1: "Allocated",
    2: "Ready",
    3: "Contracted",
    4: "Booking",
    5: "Delivered",
    6: "Cancellation",
    7: "Refunded",
    9: "Lost",
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
        ("Date", "order_date"), ("STRIPE", "stripe_id"), ("Qty", "qty"),
        ("ASSIGNED TO", "assigned_to"), ("DELIVERED", "delivered"),
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
    m = re.search(r'data-page="#order"[^>]*>([^<]+)<', cell)
    return m.group(1).strip() if m else strip_html(cell)

def parse_row(row: list, tab_label: str) -> dict:
    vehicle  = parse_vehicle(row[1])
    customer = parse_customer(row[2])
    return {
        "tab":           tab_label,
        "order_id":      row[0],
        "order_ref":     vehicle["order_ref"],
        "vehicle":       vehicle["vehicle"],
        "sale_type":     vehicle["sale_type"],
        "po_number":     vehicle["po_number"],
        "customer_name": customer.get("customer_name", ""),
        "email":         customer.get("email", ""),
        "mobile":        customer.get("mobile", ""),
        "address":       customer.get("address", ""),
        "order_date":    customer.get("order_date", ""),
        "stripe_id":     customer.get("stripe_id", ""),
        "qty":           customer.get("qty", ""),
        "assigned_to":   customer.get("assigned_to", ""),
        "delivered":     customer.get("delivered", ""),
        "balance":       parse_balance(row[3]),
        "accessories":   parse_accessories(row[4]),
        "payment":       parse_payment(row[5]),
        "status":        parse_status(row[7]),
    }


# ── Fetch ───────────────────────────────────────────────────────────────────

def build_params(tab: int, start: int, length: int) -> dict:
    params = {
        "menuId": MENU_ID, "tab": tab, "stage": 0, "draw": 1,
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

def fetch_page(session, tab: int, start: int):
    try:
        r = session.get(DATATABLE_URL, params=build_params(tab, start, PAGE_SIZE), timeout=30)
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

    # Use actual rows returned on page 1 as ground truth, NOT recordsFiltered
    # because recordsFiltered can be stale/shared between tabs on this server
    page_rows = data.get("data", [])
    reported  = data.get("recordsFiltered", 0)
    actual    = len(page_rows)

    rows = [parse_row(r, tab_label) for r in page_rows]

    # Only paginate if the server actually filled a full page
    # (if actual < PAGE_SIZE the server already gave us everything)
    if actual < PAGE_SIZE:
        print(f"  Records: {actual}  (server reported {reported})")
        return rows

    # Full page returned — keep paginating but stop as soon as a page is short
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

        # Stop when the server returns a partial page (we've hit the real end)
        if len(page_rows) < PAGE_SIZE:
            break

    print(f"  Fetched: {len(rows)} total")
    return rows


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

    print(f"VirtualYard Orders Scraper  [{datetime.now().strftime('%Y-%m-%d %H:%M')}]")
    print("=" * 55)

    all_rows = []
    for tab_index, tab_label in ORDER_TABS.items():
        all_rows += scrape_tab(session, tab_index, tab_label)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file  = f"virtualyard_orders_{timestamp}.json"

    output = {
        "exported_at":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_orders": len(all_rows),
        "orders":       all_rows,
    }
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Saved {len(all_rows)} orders → {out_file}")

    from collections import Counter
    by_tab = Counter(r["tab"] for r in all_rows)
    print("\nSummary by tab:")
    for tab in ORDER_TABS.values():
        print(f"  {tab:15s}  {by_tab.get(tab, 0):5d} orders")
    print(f"  {'TOTAL':15s}  {len(all_rows):5d} orders")

if __name__ == "__main__":
    main()