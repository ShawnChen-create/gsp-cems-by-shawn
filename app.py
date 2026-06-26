from datetime import datetime
from pathlib import Path
from flask import Flask, jsonify, render_template, request

from backend.parser import POLLUTANTS, parse_cems_response
from backend.cems_client import fetch_cems
from backend.database import init_db, upsert_parsed_result, load_cached_day, cache_stats

app = Flask(__name__, template_folder="frontend/templates", static_folder="frontend/static")

POLS = {
    "P101": "一號爐",
    "P201": "二號爐",
    "P301": "三號爐",
}


def today_str():
    return datetime.now().strftime("%Y/%m/%d")


def now_stamp():
    return datetime.now().strftime("%Y/%m/%d %H:%M:%S")


def sample_path(pol: str) -> Path:
    return Path("tests") / f"sample_response_{pol.lower()}.txt"


def parse_pols_arg(default="P101,P201,P301"):
    pols = [p.strip().upper() for p in request.args.get("pols", default).split(",") if p.strip()]
    return [p for p in pols if p in POLS]


def import_offline_samples(date_str: str):
    init_db()
    imported, errors = {}, {}
    for pol in POLS.keys():
        path = sample_path(pol)
        if not path.exists():
            errors[pol] = f"找不到 {path.as_posix()}"
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            parsed = parse_cems_response(text, date=date_str, pol_no=pol)
            cells = upsert_parsed_result(parsed, source="offline")
            imported[pol] = {"rows": parsed.get("history_count", 0), "cells": cells}
        except Exception as e:
            errors[pol] = str(e)
    return imported, errors


def sync_online(date_str: str, pols):
    saved, errors = {}, {}
    for pol in pols:
        try:
            parsed = fetch_cems(date_str, pol)
            cells = upsert_parsed_result(parsed, source="online")
            saved[pol] = {"rows": parsed.get("history_count", 0), "cells": cells}
        except Exception as e:
            errors[pol] = str(e)
    return saved, errors


@app.route("/")
def index():
    return render_template("index.html", today=today_str(), pollutants=POLLUTANTS, pols=POLS)


@app.route("/api/cache/import-offline", methods=["GET", "POST"])
def api_cache_import_offline():
    date_str = request.args.get("date") or "2026/06/26"
    imported, errors = import_offline_samples(date_str)
    return jsonify({
        "ok": not bool(errors),
        "date": date_str,
        "updated_at": now_stamp(),
        "imported": imported,
        "errors": errors,
        "cache_stats": cache_stats(date_str),
    })


@app.route("/api/cache")
def api_cache():
    date_str = request.args.get("date") or "2026/06/26"
    pols = parse_pols_arg()
    return jsonify({
        "ok": True,
        "mode": "cache",
        "date": date_str,
        "updated_at": now_stamp(),
        "data": load_cached_day(date_str, pols),
        "pollutants": POLLUTANTS,
        "cache_stats": cache_stats(date_str),
    })


@app.route("/api/offline-test")
def api_offline_test():
    date_str = request.args.get("date") or "2026/06/26"
    imported, errors = import_offline_samples(date_str)
    data = load_cached_day(date_str, list(POLS.keys()))
    return jsonify({
        "ok": True,
        "mode": "offline-cache",
        "date": date_str,
        "updated_at": now_stamp(),
        "data": data,
        "pollutants": POLLUTANTS,
        "imported": imported,
        "errors": errors,
        "cache_stats": cache_stats(date_str),
    })


@app.route("/api/cems")
def api_cems():
    date_str = request.args.get("date") or today_str()
    pols = parse_pols_arg()
    saved, errors = sync_online(date_str, pols)
    data = load_cached_day(date_str, pols)
    return jsonify({
        "ok": not bool(errors),
        "mode": "online-cache",
        "date": date_str,
        "updated_at": now_stamp(),
        "data": data,
        "errors": errors,
        "saved": saved,
        "pollutants": POLLUTANTS,
        "cache_stats": cache_stats(date_str),
    })


@app.route("/api/live")
def api_live():
    """
    v1.4.0 LIVE endpoint.
    mode=offline: 匯入離線樣本後讀快取。
    mode=online: 先線上同步 CEMS，失敗時仍回傳快取，避免 Dashboard 空白。
    mode=cache: 只讀 SQLite。
    """
    mode = (request.args.get("mode") or "offline").lower()
    date_str = request.args.get("date") or ("2026/06/26" if mode == "offline" else today_str())
    pols = parse_pols_arg()
    imported, saved, errors = {}, {}, {}

    if mode == "offline":
        imported, errors = import_offline_samples(date_str)
    elif mode == "online":
        saved, errors = sync_online(date_str, pols)
    elif mode == "cache":
        pass
    else:
        errors["mode"] = f"不支援的模式：{mode}"

    data = load_cached_day(date_str, pols)
    return jsonify({
        "ok": not bool(errors),
        "mode": mode,
        "date": date_str,
        "updated_at": now_stamp(),
        "data": data,
        "pollutants": POLLUTANTS,
        "imported": imported,
        "saved": saved,
        "errors": errors,
        "cache_stats": cache_stats(date_str),
    })


@app.route("/api/online-test")
def api_online_test():
    date_str = request.args.get("date") or today_str()
    pol = request.args.get("pol", "P101").upper()
    try:
        parsed = fetch_cems(date_str, pol)
        cells = upsert_parsed_result(parsed, source="online")
        return jsonify({
            "ok": True,
            "date": date_str,
            "pol": pol,
            "history_count": parsed.get("history_count", 0),
            "cells": cells,
            "latest": parsed.get("latest", {}),
            "updated_at": now_stamp(),
        })
    except Exception as e:
        return jsonify({"ok": False, "date": date_str, "pol": pol, "error": str(e), "updated_at": now_stamp()}), 500


@app.route("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
