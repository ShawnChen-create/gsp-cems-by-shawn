# GSP CEMS by Shawn

手機版岡山廠 CEMS 網頁查詢版。

## 功能

- 查詢岡山回收場 CEMS
- 排放口：P101、P201、P301
- 日期區間查詢，預設最多 7 天
- 手機版 RWD 介面
- 趨勢圖
- 最新值卡片
- CSV 匯出

## 本機測試

```bash
pip install -r requirements.txt
python app.py
```

開啟：

```text
http://127.0.0.1:5000
```

## 部署到 Render

1. 建立 GitHub repository，例如：`gsp-cems-by-shawn`
2. 將本專案所有檔案上傳到 repository 根目錄
3. 到 Render 建立 New Web Service
4. 選取 GitHub repository
5. 設定：

```text
Build Command: pip install -r requirements.txt
Start Command: gunicorn app:app
```

6. Environment Variables：

```text
CEMS_PLANT_CODE = S1602755
```

7. 按 Deploy

## 關於 CEMS_COOKIE

高雄 CEMS 網站可能有 Cloudflare / ASP.NET Session 驗證。

若部署後出現「無法取得 __VIEWSTATE」或查詢失敗，請在 Render 的 Environment Variables 新增：

```text
CEMS_COOKIE = 你從 Chrome Network 複製的 Cookie 字串
```

Cookie 可能會過期，過期後需重新複製。

## 注意

本專案是即查即看版，不會長期儲存 CEMS 資料。
