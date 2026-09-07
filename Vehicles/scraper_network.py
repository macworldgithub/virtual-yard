import requests
import json
import time
import re
from bs4 import BeautifulSoup

SESSION_COOKIE = "1f62l6js9dao5ikr069dste633"

BASE_URL = "https://dealers.virtualyard.com.au/HARMONY-NEW-ENERGY-AUTO-SERVICE-(WSP)-PTY-LTD/"
AJAX_URL = "https://dealers.virtualyard.com.au/ajax/datatable/search.php"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
    "Referer": BASE_URL,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

session = requests.Session()
session.headers.update(HEADERS)
session.cookies.set("PHPSESSID", SESSION_COOKIE, domain="dealers.virtualyard.com.au")


def build_params(start, length=50):
    params = {
        "menuId": "917",       # <-- 917 = Network vehicles
        "tab": "0",
        "stage": "0",
        "draw": str(start // length + 1),
        "order[0][column]": "0",
        "order[0][dir]": "desc",
        "start": str(start),
        "length": str(length),
        "search[value]": "",
        "search[regex]": "false",
        "ssrFilters": "",
        "parent": "",
        "child": "",
        "params": "",
    }
    # Only 3 columns for network view
    col_orderable = ["true", "false", "false"]
    for i in range(3):
        params[f"columns[{i}][data]"] = str(i)
        params[f"columns[{i}][name]"] = ""
        params[f"columns[{i}][searchable]"] = "true"
        params[f"columns[{i}][orderable]"] = col_orderable[i]
        params[f"columns[{i}][search][value]"] = ""
        params[f"columns[{i}][search][regex]"] = "false"
    return params


def parse_row(row_data):
    """
    Network rows have 3 columns:
      [0] photo / status
      [1] vehicle details
      [2] price
    """
    if len(row_data) < 3:
        return None

    # Col 0: Status badge + photo
    photo_soup = BeautifulSoup(row_data[0], "html.parser")
    badge = photo_soup.find("span", class_="ribbon-inner")
    status = badge.get_text(strip=True) if badge else "IN-STOCK"
    img = photo_soup.find("img", {"data-status": True})
    photo_url = ""
    if img:
        src = img.get("src", "")
        if "placeholder" not in src:
            photo_url = src

    # Col 1: Vehicle details
    detail_soup = BeautifulSoup(row_data[1], "html.parser")
    name_tag = detail_soup.find("a", class_="loadPage")
    name = name_tag.get_text(strip=True) if name_tag else ""

    vehicle_id = ""
    if name_tag and name_tag.get("data-id"):
        m = re.search(r"vehicleId=(\d+)", name_tag.get("data-id", ""))
        if m:
            vehicle_id = m.group(1)

    card = {}
    card_table = detail_soup.find("table", class_="card")
    if card_table:
        for tr in card_table.find_all("tr"):
            tds = tr.find_all("td")
            for i in range(0, len(tds) - 1, 2):
                key = tds[i].get_text(strip=True).rstrip(":")
                val = tds[i + 1].get_text(strip=True)
                card[key] = val

    # Col 2: Price
    price_soup = BeautifulSoup(row_data[2], "html.parser")
    price_tag = price_soup.find("strong")
    price_raw = price_tag.get_text(strip=True) if price_tag else "$0"
    price_num = re.sub(r"[^\d.]", "", price_raw)
    price_value = float(price_num) if price_num else 0.0

    # Price label (Drive Away vs Exc. Gov. Charges)
    price_label_tag = price_soup.find("span", class_="label")
    price_label = price_label_tag.get_text(strip=True) if price_label_tag else ""

    return {
        "vehicle": name,
        "data": {
            "vehicle_id": vehicle_id,
            "status": status,
            "price_display": price_raw,
            "price_label": price_label,
            "price_value": price_value,
            "photo_url": photo_url,
            "vin": card.get("VIN#", ""),
            "yard": card.get("Yard:", card.get("Yard", "")),
            "registration": card.get("Reg#", "").strip(),
            "body_type": card.get("Body", ""),
            "odometer_km": card.get("Kms", "").replace(",", ""),
            "build_date": card.get("Built", ""),
            "age_days": card.get("Age", ""),
            "registration_expiry": card.get("Reg. Expiry", ""),
        }
    }


def scrape_all():
    print("Starting Virtual Yard NETWORK inventory scrape...")
    print("=" * 55)

    all_vehicles = []
    start = 0
    length = 50
    total = None

    while True:
        print(f"Fetching records {start}–{start + length - 1}...", end=" ", flush=True)

        try:
            params = build_params(start, length)
            r = session.get(AJAX_URL, params=params, timeout=20)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"\nERROR: {e}")
            break

        rows = data.get("data", [])
        if total is None:
            total = data.get("recordsTotal", 0)
            print(f"(total: {total} network vehicles)")

        page_vehicles = []
        for row in rows:
            v = parse_row(row)
            if v and v["vehicle"].strip():
                page_vehicles.append(v)

        all_vehicles.extend(page_vehicles)
        print(f"Got {len(page_vehicles)} | Running total: {len(all_vehicles)}/{total}")

        if not rows or start + length >= total:
            print("\nAll pages fetched.")
            break

        start += length
        time.sleep(0.6)

    return all_vehicles, total


def save_json(vehicles, total, filename="inventory2.json"):
    output = {
        "total": len(vehicles),
        "reported_total": total,
        "vehicles": vehicles
    }
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n✓ Saved {len(vehicles)} network vehicles to {filename}")


if __name__ == "__main__":
    vehicles, total = scrape_all()
    save_json(vehicles, total)

    print("\nSample (first 2 vehicles):")
    print(json.dumps(vehicles[:2], indent=2))