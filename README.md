# GSP CEMS by Shawn - Phase 1

手機版 Flask CEMS 查詢網站。

## 功能
- 手機版首頁
- 查詢岡山回收場 CEMS
- 支援 P101 / P201 / P301
- 後端即時串接 CEMSData.aspx
- Render 可部署

## Render 設定
Build Command:
```bash
pip install -r requirements.txt
```
Start Command:
```bash
gunicorn app:app
```
Environment Variables:
```text
CEMS_PLANT_CODE=S1602755
CEMS_URL=https://aqmc.kcg.gov.tw/pubCems/CEMSData.aspx
# 若網站因 Cloudflare / Session 驗證擋住，再補：
# CEMS_COOKIE=從 Chrome Copy as cURL 裡面的 cookie 字串
```

## 本機執行
```bash
pip install -r requirements.txt
python app.py
```
