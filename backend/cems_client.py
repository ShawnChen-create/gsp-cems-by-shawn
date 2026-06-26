import os
from pathlib import Path
from typing import Dict

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

from .parser import parse_cems_response

CEMS_URL = os.getenv("CEMS_URL", "https://aqmc.kcg.gov.tw/pubCems/CEMSData.aspx")
PLANT_CODE = os.getenv("CEMS_PLANT_CODE", "S1602755")
REQUEST_TIMEOUT_MS = int(os.getenv("CEMS_TIMEOUT_MS", "60000"))

POLS = {
    "P101": "P101",
    "P201": "P201",
    "P301": "P301",
}


def ensure_tests_dir() -> None:
    Path("tests").mkdir(exist_ok=True)


def fetch_cems(date_str: str, pol_no: str) -> Dict:
    """
    Playwright 版 CEMS 查詢：
    1. 開啟高雄 CEMS 即時數據頁
    2. 選擇岡山回收場
    3. 等待 ASP.NET __doPostBack 重新整理
    4. 選擇排放口 P101/P201/P301
    5. 按搜尋
    6. 抓取頁面 HTML 丟給 parser
    """
    ensure_tests_dir()
    pol_no = pol_no.upper().strip()
    if pol_no not in POLS:
        raise ValueError(f"不支援的排放口：{pol_no}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 1366, "height": 900},
            locale="zh-TW",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/149.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()
        try:
            page.goto(CEMS_URL, wait_until="networkidle", timeout=REQUEST_TIMEOUT_MS)
            page.fill("#ctl00_cthBody_DataDate", date_str)
            page.select_option("#ctl00_cthBody_DDLCno", PLANT_CODE)
            try:
                page.wait_for_load_state("networkidle", timeout=REQUEST_TIMEOUT_MS)
            except PlaywrightTimeoutError:
                pass
            page.wait_for_selector("#ctl00_cthBody_DDLPolNo", timeout=REQUEST_TIMEOUT_MS)
            page.wait_for_function(
                """(pol) => {
                    const sel = document.querySelector("#ctl00_cthBody_DDLPolNo");
                    if (!sel) return false;
                    return Array.from(sel.options).some(o => o.value === pol);
                }""",
                arg=pol_no,
                timeout=REQUEST_TIMEOUT_MS,
            )
            page.select_option("#ctl00_cthBody_DDLPolNo", pol_no)
            page.click("#ctl00_cthBody_btnSerach")
            try:
                page.wait_for_load_state("networkidle", timeout=REQUEST_TIMEOUT_MS)
            except PlaywrightTimeoutError:
                pass
            page.wait_for_selector("#ctl00_cthBody_gvList", timeout=REQUEST_TIMEOUT_MS)
            page.wait_for_timeout(1000)
            html = page.content()
            Path(f"tests/playwright_result_{pol_no.lower()}.html").write_text(
                html, encoding="utf-8", errors="ignore"
            )
            return parse_cems_response(html, date_str=date_str, pol_no=pol_no)
        finally:
            context.close()
            browser.close()
