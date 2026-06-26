import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from bs4 import BeautifulSoup

POLLUTANTS = [
    {"key": "opacity", "label": "不透光率", "unit": "%", "interval_min": 6},
    {"key": "so2", "label": "SO₂", "unit": "ppm", "interval_min": 15},
    {"key": "nox", "label": "NOx", "unit": "ppm", "interval_min": 15},
    {"key": "co", "label": "CO", "unit": "ppm", "interval_min": 15},
    {"key": "hcl", "label": "HCl", "unit": "ppm", "interval_min": 15},
    {"key": "nh3", "label": "NH₃", "unit": "ppm", "interval_min": 15},
    {"key": "o2", "label": "O₂", "unit": "%", "interval_min": 15},
    {"key": "flow", "label": "排放流率", "unit": "Nm³/hr", "interval_min": 60},
    {"key": "temp", "label": "溫度", "unit": "°C", "interval_min": 60},
]

HEADER_ALIASES = {
    "不透光率": "opacity",
    "不透光": "opacity",
    "二氧化硫": "so2",
    "氮氧化物": "nox",
    "一氧化碳": "co",
    "氯化氫": "hcl",
    "氨氣": "nh3",
    "氧氣": "o2",
    "排放流率": "flow",
    "溫度": "temp",
}


def clean_text(value: str) -> str:
    return re.sub(r"\s+", "", value or "").strip()


def unwrap_ajax_response(text: str) -> str:
    """ASP.NET AJAX response is pipe-delimited; extract updatePanel HTML blocks."""
    if "|updatePanel|" not in text:
        return text
    parts = text.split("|")
    chunks: List[str] = []
    for i, part in enumerate(parts):
        if part == "updatePanel" and i + 2 < len(parts):
            chunks.append(parts[i + 2])
    return "\n".join(chunks) if chunks else text


def parse_number(text: str) -> Optional[float]:
    text = clean_text(text).replace("—", "-").replace("－", "-")
    if not text or text in {"--", "-", "=", "=="}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def parse_standard(text: str) -> Optional[float]:
    match = re.search(r"\((-?\d+(?:\.\d+)?)\)", text or "")
    return float(match.group(1)) if match else None


def parse_cell(cell) -> Dict[str, Any]:
    """Parse a table cell. If an underlined value exists, prefer it as hourly average."""
    underline_el = cell.find(["u", "ins"])
    full_text = clean_text(cell.get_text(" "))
    under_text = clean_text(underline_el.get_text(" ")) if underline_el else ""
    chosen_text = under_text if parse_number(under_text) is not None else full_text
    return {
        "raw": full_text,
        "value": parse_number(chosen_text),
        "standard": parse_standard(chosen_text) or parse_standard(full_text),
        "hourly_avg": underline_el is not None and parse_number(under_text) is not None,
    }


def map_headers(header_cells) -> List[Optional[str]]:
    keys: List[Optional[str]] = []
    for cell in header_cells:
        text = clean_text(cell.get_text(" "))
        key = None
        if "時間" in text:
            key = "time"
        else:
            for alias, mapped in HEADER_ALIASES.items():
                if alias in text:
                    key = mapped
                    break
        keys.append(key)
    return keys


def parse_latest_table(soup: BeautifulSoup, date: str, pol_no: str) -> Dict[str, Any]:
    table = soup.find("table", {"id": "ctl00_cthBody_htmlTableLatest"}) or soup.find("table", id=re.compile("htmlTableLatest"))
    empty = {"date": date, "time": None, "timestamp": None, "pol_no": pol_no, "values": {}}
    if table is None:
        return empty
    rows = table.find_all("tr")
    if len(rows) < 2:
        return empty
    headers = map_headers(rows[0].find_all(["th", "td"]))
    cells = rows[1].find_all(["td", "th"])
    time_text = clean_text(cells[0].get_text(" ")) if cells else None
    latest = {
        "date": date,
        "time": time_text,
        "timestamp": f"{date} {time_text}" if time_text else None,
        "pol_no": pol_no,
        "values": {},
    }
    for idx, cell in enumerate(cells):
        if idx >= len(headers):
            continue
        key = headers[idx]
        if key is None or key == "time":
            continue
        latest["values"][key] = parse_cell(cell)
    return latest


def parse_history_table(soup: BeautifulSoup, date: str, pol_no: str) -> List[Dict[str, Any]]:
    table = soup.find("table", {"id": "ctl00_cthBody_gvList"}) or soup.find("table", id=re.compile("gvList"))
    if table is None:
        tables = soup.find_all("table")
        table = max(tables, key=lambda t: len(t.find_all("tr")), default=None)
    if table is None:
        return []
    rows = table.find_all("tr")
    if len(rows) < 2:
        return []
    headers = map_headers(rows[0].find_all(["th", "td"]))
    parsed_rows: List[Dict[str, Any]] = []
    for tr in rows[1:]:
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        time_text = clean_text(cells[0].get_text(" "))
        if not re.match(r"^\d{1,2}:\d{2}$", time_text):
            continue
        item: Dict[str, Any] = {
            "date": date,
            "time": time_text,
            "timestamp": f"{date} {time_text}",
            "pol_no": pol_no,
            "values": {},
        }
        for idx, cell in enumerate(cells):
            if idx >= len(headers):
                continue
            key = headers[idx]
            if key is None or key == "time":
                continue
            item["values"][key] = parse_cell(cell)
        parsed_rows.append(item)
    return parsed_rows


def build_effective_latest(history: List[Dict[str, Any]], latest_table: Dict[str, Any], date: str, pol_no: str) -> Dict[str, Any]:
    """Find the most recent valid value for each pollutant based on its own sampling interval."""
    values: Dict[str, Any] = {}
    latest_times: List[str] = []
    for pollutant in POLLUTANTS:
        key = pollutant["key"]
        found = None
        # Use latest table first only when it has a valid number, then fallback to history.
        candidate = (latest_table or {}).get("values", {}).get(key)
        if candidate and candidate.get("value") is not None:
            found = dict(candidate)
            found["time"] = (latest_table or {}).get("time")
            found["timestamp"] = (latest_table or {}).get("timestamp")
        else:
            for row in reversed(history):
                v = row.get("values", {}).get(key)
                if v and v.get("value") is not None:
                    found = dict(v)
                    found["time"] = row.get("time")
                    found["timestamp"] = row.get("timestamp")
                    break
        values[key] = found or {"raw": "", "value": None, "standard": None, "hourly_avg": False, "time": None, "timestamp": None}
        if values[key].get("time"):
            latest_times.append(values[key]["time"])
    display_time = max(latest_times) if latest_times else (latest_table or {}).get("time")
    return {
        "date": date,
        "time": display_time,
        "timestamp": f"{date} {display_time}" if display_time else None,
        "pol_no": pol_no,
        "values": values,
    }


def parse_cems_response(text: str, date: str = "2026/06/26", pol_no: str = "P101", **kwargs) -> Dict[str, Any]:
    # Accept legacy keyword date_str used by earlier files.
    if "date_str" in kwargs and kwargs["date_str"]:
        date = kwargs["date_str"]
    html = unwrap_ajax_response(text)
    soup = BeautifulSoup(html, "html.parser")
    latest_table = parse_latest_table(soup, date, pol_no)
    history = parse_history_table(soup, date, pol_no)
    effective_latest = build_effective_latest(history, latest_table, date, pol_no)
    return {
        "ok": True,
        "date": date,
        "pol_no": pol_no,
        "latest_table": latest_table,
        "latest": effective_latest,
        "history": history,
        "rows": history,  # backward compatibility for current frontend
        "history_count": len(history),
        "count": len(history),
        "pollutants": POLLUTANTS,
    }


def main() -> None:
    sample_path = Path("tests/sample_response_p101.txt")
    if not sample_path.exists():
        print("找不到 tests/sample_response_p101.txt")
        print("請先把 Response.txt 複製到 tests/sample_response_p101.txt")
        return
    text = sample_path.read_text(encoding="utf-8", errors="ignore")
    result = parse_cems_response(text, date="2026/06/26", pol_no="P101")
    print("解析成功")
    print(f"排放口：{result['pol_no']}")
    print(f"歷史筆數：{result['history_count']}")
    print(f"最新有效時間：{result['latest']['time']}")
    print("最新有效值：")
    for p in POLLUTANTS:
        key = p["key"]
        v = result["latest"]["values"].get(key, {})
        value = v.get("value")
        t = v.get("time")
        print(f"  {p['label']}: {value} {p['unit']}  @ {t}")
    output_path = Path("tests/parsed_sample_p101_v101.json")
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已輸出：{output_path}")


if __name__ == "__main__":
    main()
