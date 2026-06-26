# GSP CEMS by Shawn

手機版 CEMS Dashboard（Phase 1.1）

## 本版更新

- 上方顯示 P101 / P201 / P301 三爐每個項目的最新有效數值
- 下方顯示每個項目的 24 小時移動平均趨勢圖
- 資料頻率：
  - 不透光率：6 分鐘一筆
  - SO2 / NOx / CO / HCl / NH3：15 分鐘一筆
  - 排放流率 / 溫度：1 小時一筆
- 後端會抓查詢日與前一日資料，供前端計算最近 24 小時移動平均

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
CEMS_TIMEOUT=35
```

若高雄 CEMS 端要求瀏覽器驗證，可另外加入：

```text
CEMS_COOKIE=你從 Chrome Network 複製出的 Cookie 內容
```
