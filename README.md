# Event

重製 LINE NEWS 的玻璃擬態介面，並改為載入高雄市建築師公會「活動紀錄」列表（`news_list.php?t1=1`）。資料經由 `data/events.json` 餵給前端，提供搜尋、狀態篩選與排序能力。

## 快速啟動

1. 安裝依賴（僅在重新抓資料時需要）：`pip install -r requirements.txt`（或手動安裝 `requests` 與 `beautifulsoup4`）。
2. 啟動任一靜態伺服器（需支援 Fetch）：
   ```sh
   python -m http.server 4173
   # 或者：npx serve .
   ```
3. 造訪 `http://localhost:4173` 即可預覽。

## 更新活動資料

資料來源頁面偶爾會變動，可利用 `scripts/scrape_events.py` 重新產生 `data/events.json`：

```sh
py -3.10 -m pip install -r requirements.txt  # 首次執行時
py -3.10 scripts/scrape_events.py
```

若成功，終端機會顯示寫入數量與路徑，而頁尾也會同步更新 `資料更新時間`。

## 發佈到 GitHub Pages

1. 建立版本庫並提交：
   ```sh
   git init
   git add .
   git commit -m "feat: init line-event web"
   ```
2. 至 GitHub 建立公開倉庫 `line-event`，不含任何預設檔案。
3. 將遠端加入並推送：
   ```sh
   git remote add origin git@github.com:<YOUR_ACCOUNT>/line-event.git
   git push -u origin main
   ```
4. 在 GitHub Repository 設定中的 **Pages** 啟用 (Branch: `main`, Folder: `/root`)，即可取得公開網址。

> 如果要改用 `gh-pages` 分支，也可執行 `git subtree` 或 GitHub Actions。由於程式僅為純靜態資源，不需額外建置流程。
