import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

CEMS_URL = os.getenv("CEMS_URL", "https://aqmc.kcg.gov.tw/pubCems/CEMSData.aspx")
PLANT_CODE = os.getenv("CEMS_PLANT_CODE", "S1602755")
STATIC_COOKIE = os.getenv("CEMS_COOKIE", "").strip()

POLLUTANTS = [
    {"key": "opacity", "label": "不透光率", "unit": "%"},
    {"key": "so2", "label": "SO₂", "unit": "ppm"},
    {"key": "nox", "label": "NOx", "unit": "ppm"},
    {"key": "co", "label": "CO", "unit": "ppm"},
    {"key": "hcl", "label": "HCl", "unit": "ppm"},
    {"key": "o2", "label": "O₂", "unit": "%"},
    {"key": "flow", "label": "排放流率", "unit": "Nm³/hr"},
    {"key": "temp", "label": "溫度", "unit": "°C"},
]

HEADER_ALIASES = {
    "不透光率": "opacity",
    "二氧化硫": "so2",
    "氮氧化物": "nox",
    "一氧化碳": "co",
    "氯化氫": "hcl",
    "氧氣": "o2",
    "排放流率": "flow",
    "溫度": "temp",
}


def clean_text(s: str) -> str:
    return re.sub(r"\s+", "", s or "").strip()


def parse_value(raw: str) -> Dict[str, Any]:
    text = clean_text(raw).replace("—", "-").replace("－", "-")
    is_hourly = "__UNDERLINE__" in text
    text = text.replace("__UNDERLINE__", "")
    if not text or text in {"--", "-", "=", "=="}:
        return {"raw": raw, "value": None, "standard": None, "hourly_avg": is_hourly}
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*(?:\(([-]?\d+(?:\.\d+)?)\))?", text)
    if not m:
        return {"raw": raw, "value": None, "standard": None, "hourly_avg": is_hourly}
    value = float(m.group(1))
    standard = float(m.group(2)) if m.group(2) else None
    return {"raw": text, "value": value, "standard": standard, "hourly_avg": is_hourly}


def extract_hidden_fields(html: str) -> Dict[str, str]:
    soup = BeautifulSoup(html, "lxml")
    fields = {}
    for name in ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "__EVENTTARGET", "__EVENTARGUMENT", "__LASTFOCUS"]:
        el = soup.find("input", {"name": name})
        fields[name] = el.get("value", "") if el else ""
    return fields


def unwrap_ajax_response(text: str) -> str:
    # ASP.NET UpdatePanel delta response may contain chunks separated by pipes.
    if "|updatePanel|" not in text and "|hiddenField|" not in text:
        return text
    parts = text.split("|")
    html_chunks = []
    for i, part in enumerate(parts):
        if part == "updatePanel" and i + 2 < len(parts):
            html_chunks.append(parts[i + 2])
    return "\n".join(html_chunks) if html_chunks else text


def fetch_cems(date_str: str, pol_no: str) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    session = requests.Session()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": CEMS_URL,
        "Origin": "https://aqmc.kcg.gov.tw",
    }
    if STATIC_COOKIE:
        headers["Cookie"] = STATIC_COOKIE

    first = session.get(CEMS_URL, headers=headers, timeout=20)
    first.raise_for_status()
    hidden = extract_hidden_fields(first.text)

    data = {
        "ctl00$cthBody$ScriptManager1": "ctl00$cthBody$UpdatePanel1|ctl00$cthBody$btnSerach",
        "ctl00$cthBody$DataDate": date_str,
        "ctl00$cthBody$DDLCno": PLANT_CODE,
        "ctl00$cthBody$DDLPolNo": pol_no,
        "__LASTFOCUS": hidden.get("__LASTFOCUS", ""),
        "__EVENTTARGET": "",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": hidden.get("__VIEWSTATE", ""),
        "__VIEWSTATEGENERATOR": hidden.get("__VIEWSTATEGENERATOR", ""),
        "__EVENTVALIDATION": hidden.get("__EVENTVALIDATION", ""),
        "__ASYNCPOST": "true",
        "ctl00$cthBody$btnSerach": "搜尋",
    }
    post_headers = dict(headers)
    post_headers.update({
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-MicrosoftAjax": "Delta=true",
        "X-Requested-With": "XMLHttpRequest",
    })
    resp = session.post(CEMS_URL, headers=post_headers, data=data, timeout=25)
    resp.raise_for_status()
    html = unwrap_ajax_response(resp.text)
    rows = parse_tables(html, date_str, pol_no)
    meta = {"date": date_str, "pol_no": pol_no, "count": len(rows)}
    return rows, meta


def parse_tables(html: str, date_str: str, pol_no: str) -> List[Dict[str, Any]]:
    # Mark underlined hourly average values before extracting text.
    soup = BeautifulSoup(html, "lxml")
    for u in soup.find_all(["u", "ins"]):
        u.string = (u.get_text(" ") + "__UNDERLINE__")

    tables = soup.find_all("table")
    best_rows: List[Dict[str, Any]] = []
    for table in tables:
        trs = table.find_all("tr")
        if len(trs) < 2:
            continue
        headers = [clean_text(th.get_text(" ")) for th in trs[0].find_all(["th", "td"])]
        if not headers or not any("時間" in h for h in headers):
            continue
        keys = []
        for h in headers:
            key = None
            for alias, mapped in HEADER_ALIASES.items():
                if alias in h or alias.replace("二", "2") in h:
                    key = mapped
                    break
            if "時間" in h:
                key = "time"
            keys.append(key)

        parsed = []
        for tr in trs[1:]:
            cells = tr.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            row = {"date": date_str, "pol_no": pol_no, "values": {}}
            t = clean_text(cells[0].get_text(" "))
            if not re.match(r"^\d{1,2}:\d{2}$", t):
                continue
            row["time"] = t
            for idx, cell in enumerate(cells[1:], start=1):
                if idx >= len(keys):
                    continue
                key = keys[idx]
                if not key or key == "time":
                    continue
                row["values"][key] = parse_value(cell.get_text(" "))
            parsed.append(row)
        if len(parsed) > len(best_rows):
            best_rows = parsed
    return best_rows


@app.route("/")
def index():
    today = datetime.now().strftime("%Y/%m/%d")
    return render_template("index.html", today=today, pollutants=POLLUTANTS)


@app.route("/api/cems")
def api_cems():
    date_str = request.args.get("date") or datetime.now().strftime("%Y/%m/%d")
    pols = request.args.get("pols", "P101,P201,P301").split(",")
    result = {}
    errors = {}
    for pol in pols:
        pol = pol.strip().upper()
        if pol not in {"P101", "P201", "P301"}:
            continue
        try:
            rows, meta = fetch_cems(date_str, pol)
            result[pol] = {"meta": meta, "rows": rows}
        except Exception as e:
            errors[pol] = str(e)
    return jsonify({"ok": not bool(errors), "date": date_str, "data": result, "errors": errors, "pollutants": POLLUTANTS})


@app.route("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
