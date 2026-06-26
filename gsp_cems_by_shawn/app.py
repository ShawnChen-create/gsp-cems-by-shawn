import os
import re
from datetime import datetime, timedelta
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, request

APP_NAME = "GSP CEMS by Shawn"
BASE_URL = "https://aqmc.kcg.gov.tw/pubCems/CEMSData.aspx"
PLANT_CODE = os.getenv("CEMS_PLANT_CODE", "S1602755")  # 岡山回收場
DEFAULT_TIMEOUT = 25

app = Flask(__name__)

POLLUTANT_ALIASES = {
    "HCl": ["HCl", "氯化氫"],
    "SO2": ["SO2", "SO₂", "二氧化硫"],
    "NOx": ["NOx", "NOX", "氮氧化物"],
    "CO": ["CO", "一氧化碳"],
    "O2": ["O2", "O₂", "氧氣", "含氧"],
    "TEMP": ["溫度", "Temp", "TEMP"],
    "FLOW": ["流率", "流量", "Flow", "FLOW"],
}


def make_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": os.getenv(
            "CEMS_USER_AGENT",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        ),
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": BASE_URL,
    })
    # 若網站啟用 Cloudflare 驗證，Render 可能需要貼瀏覽器 Cookie 到環境變數 CEMS_COOKIE。
    cookie = os.getenv("CEMS_COOKIE", "").strip()
    if cookie:
        s.headers.update({"Cookie": cookie})
    return s


def hidden_fields(soup):
    fields = {}
    for inp in soup.find_all("input"):
        name = inp.get("name")
        if not name:
            continue
        if name.startswith("__") or name in ["ctl00$cthBody$DataDate"]:
            fields[name] = inp.get("value", "")
    return fields


def get_initial_state(session):
    r = session.get(BASE_URL, timeout=DEFAULT_TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    fields = hidden_fields(soup)
    if "__VIEWSTATE" not in fields:
        raise RuntimeError("無法取得 __VIEWSTATE，可能被網站驗證頁面阻擋。")
    return fields


def post_query(session, date_str, port):
    fields = get_initial_state(session)
    fields.update({
        "ctl00$cthBody$ScriptManager1": "ctl00$cthBody$UpdatePanel1|ctl00$cthBody$btnSerach",
        "ctl00$cthBody$DataDate": date_str,
        "ctl00$cthBody$DDLCno": PLANT_CODE,
        "ctl00$cthBody$DDLPolNo": port,
        "__LASTFOCUS": "",
        "__EVENTTARGET": "",
        "__EVENTARGUMENT": "",
        "__ASYNCPOST": "true",
        "ctl00$cthBody$btnSerach": "查詢",
    })
    headers = {
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": "https://aqmc.kcg.gov.tw",
        "Referer": BASE_URL,
        "X-MicrosoftAjax": "Delta=true",
        "X-Requested-With": "XMLHttpRequest",
    }
    r = session.post(BASE_URL, data=fields, headers=headers, timeout=DEFAULT_TIMEOUT)
    r.raise_for_status()
    return r.text


def extract_tables(html_or_delta):
    text = html_or_delta
    # ASP.NET UpdatePanel delta 常把 HTML 包在 pipe 區段中；BeautifulSoup 仍可直接解析。
    soup = BeautifulSoup(text, "html.parser")
    tables = soup.find_all("table")
    if tables:
        return tables
    # 若被編碼，嘗試抽取 <table> 片段。
    matches = re.findall(r"(<table[\s\S]*?</table>)", text, flags=re.I)
    return [BeautifulSoup(m, "html.parser").find("table") for m in matches]


def clean_text(x):
    return re.sub(r"\s+", " ", x.replace("\xa0", " ")).strip()


def parse_value_cell(cell):
    text = clean_text(cell.get_text(" "))
    underlined = bool(cell.find("u")) or "text-decoration" in str(cell).lower()
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*(?:\(\s*(-?\d+(?:\.\d+)?)\s*\))?", text)
    if not m:
        return {"raw": text, "value": None, "standard": None, "hourly_avg": underlined}
    return {
        "raw": text,
        "value": float(m.group(1)),
        "standard": float(m.group(2)) if m.group(2) is not None else None,
        "hourly_avg": underlined,
    }


def normalize_pollutant(name):
    t = clean_text(name)
    for key, aliases in POLLUTANT_ALIASES.items():
        if any(a.lower() in t.lower() for a in aliases):
            return key
    return t


def parse_cems_response(resp_text, date_str, port):
    tables = extract_tables(resp_text)
    rows_out = []
    for table in tables:
        trs = table.find_all("tr")
        if len(trs) < 2:
            continue
        header_cells = [clean_text(c.get_text(" ")) for c in trs[0].find_all(["th", "td"])]
        if len(header_cells) < 2:
            continue
        # 找時間欄位與污染物欄位；常見格式第一欄是時間，其餘為監測項目。
        time_idx = 0
        pollutant_headers = []
        for idx, h in enumerate(header_cells):
            if idx == time_idx:
                continue
            if h:
                pollutant_headers.append((idx, normalize_pollutant(h), h))
        if not pollutant_headers:
            continue
        for tr in trs[1:]:
            cells = tr.find_all(["td", "th"])
            if len(cells) <= time_idx:
                continue
            time_text = clean_text(cells[time_idx].get_text(" "))
            if not time_text or "合計" in time_text or "平均" in time_text:
                continue
            timestamp = combine_date_time(date_str, time_text)
            for idx, pol, raw_header in pollutant_headers:
                if idx >= len(cells):
                    continue
                parsed = parse_value_cell(cells[idx])
                if parsed["raw"] == "" or parsed["value"] is None:
                    continue
                rows_out.append({
                    "date": date_str,
                    "time": time_text,
                    "timestamp": timestamp,
                    "port": port,
                    "pollutant": pol,
                    "pollutant_label": raw_header,
                    "value": parsed["value"],
                    "standard": parsed["standard"],
                    "raw": parsed["raw"],
                    "hourly_avg": parsed["hourly_avg"],
                })
    return rows_out


def combine_date_time(date_str, time_text):
    # 支援 2026/06/26 + 09:06 或 09 時等格式。
    m = re.search(r"(\d{1,2})[:：時](\d{1,2})?", time_text)
    if not m:
        return f"{date_str} {time_text}"
    hh = int(m.group(1)); mm = int(m.group(2) or 0)
    return f"{date_str} {hh:02d}:{mm:02d}"


def daterange(start, end):
    d1 = datetime.strptime(start, "%Y/%m/%d")
    d2 = datetime.strptime(end, "%Y/%m/%d")
    if d2 < d1:
        d1, d2 = d2, d1
    if (d2 - d1).days > 7:
        raise ValueError("日期區間最多 7 天，避免網站查詢過量。")
    while d1 <= d2:
        yield d1.strftime("%Y/%m/%d")
        d1 += timedelta(days=1)


@app.route("/")
def index():
    return render_template("index.html", app_name=APP_NAME)


@app.route("/api/query")
def api_query():
    start = request.args.get("start") or datetime.now().strftime("%Y/%m/%d")
    end = request.args.get("end") or start
    ports = request.args.get("ports", "P101,P201,P301").split(",")
    ports = [p.strip().upper() for p in ports if p.strip().upper() in {"P101", "P201", "P301"}]
    if not ports:
        return jsonify({"ok": False, "error": "請至少選擇一個排放口。"}), 400

    try:
        session = make_session()
        data = []
        errors = []
        for d in daterange(start, end):
            for port in ports:
                try:
                    resp = post_query(session, d, port)
                    parsed = parse_cems_response(resp, d, port)
                    data.extend(parsed)
                    if not parsed:
                        errors.append(f"{d} {port} 查無可解析資料")
                except Exception as e:
                    errors.append(f"{d} {port}: {e}")
        return jsonify({
            "ok": True,
            "app": APP_NAME,
            "plant_code": PLANT_CODE,
            "count": len(data),
            "data": data,
            "errors": errors,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/health")
def health():
    return {"ok": True, "app": APP_NAME}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG") == "1")
