# 交接卡：168 台股選股（給 Claude Code）

## 這是什麼
Amos（TUP哥）的台股選股工具，給自己投資參考，也給「168 AI 一人公司」的學員學選股方法。
以台股為主（上市＋上櫃），美股（費半、那斯達克、台積電 ADR）只當參考。
使用者是新手，介面和文字都要白話、繁體中文、手機優先。

## 怎麼運作
- GitHub Actions（`.github/workflows/update.yml`）每個交易日台灣時間 17:45、19:20 執行 `node build-site.js`。
- `build-site.js` 呼叫 `engine.js` 抓資料、計算，產生 `site/index.html`，再發布到 GitHub Pages。
- 歷史資料存在 `store/store.json`，用 actions/cache 保存，不提交進 git（約 5MB）。快取遺失會自動重新回補。
- 每次執行會提交 `last-update.txt`，避免 GitHub 在 60 天無活動後停用排程。
- 網址：https://pt520530.github.io/tw-stock/

## 檔案
- `engine.js`：選股引擎（抓資料、存資料、計算、勝率追蹤）。沒有外部套件，Node 18+ 內建 fetch。
- `page.html`：手機網頁模板，`/*__DATA__*/null` 等佔位字串由 build-site.js 替換。
- `build-site.js`：雲端版入口，也會把各資料來源的成功與否寫進 Actions 執行摘要。

## 選股邏輯（使用者已確認）
- 不要存股。首頁是「今日推薦」：波段 4 項＋籌碼 4 項，每項 12.5 分；75 分以上、收盤在季線上、近四季有獲利（本益比 > 0）才列入。
- 波段：均線多頭排列（收盤 > 月線 > 季線）、月線往上、量 ≥ 前 5 日均量 1.5 倍、離月線不超過 +10%。
- 籌碼：投信連買 ≥ 3 天、投信 3 日買超 ≥ 100 張、外資 5 日買超、三大法人 5 日買超。
- 只看 20 日均量 ≥ 500 張的一般股票（4 碼、非 0 開頭）。
- 參考價位：月線（支撐）、停損＝月線 × 0.97、近 3 月最高收盤、近半年高低。
- 勝率追蹤：每天的推薦 10 個交易日後結算上漲比例、贏過 0050 比例、平均報酬；「實際紀錄」和「歷史回測」分開標示。
- 台股慣例：紅漲綠跌。

## 資料來源
- 證交所 rwd：`afterTrading/STOCK_DAY_ALL?date=`、`fund/T86?date=`（三大法人）
- 證交所 OpenAPI：`exchangeReport/STOCK_DAY_ALL`、`BWIBBU_ALL`（本益比）
- 櫃買 OpenAPI：`tpex_mainboard_daily_close_quotes`、`tpex_3insti_daily_trading`、`tpex_mainboard_peratio_analysis`
- 櫃買歷史：`web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?d=民國年/月/日&o=json`
- 美股：Yahoo Finance chart API（^SOX、^IXIC、TSM、TWD=X）

## 尚未用真實資料驗證（優先處理）
開發環境連不到台灣的資料來源，以上程式只用模擬資料測過。
1. 櫃買 OpenAPI 的欄位名稱是用候選名稱比對猜的（`keyOf`），需要用真實回應確認。
2. 證交所 rwd 和櫃買端點可能擋海外 IP（GitHub Actions 在美國）。第一次執行後看 Actions 摘要的資料來源表。
3. 如果台灣來源被擋：可改用 self-hosted runner（Amos 有一台跑 n8n 的 VPS），或改用其他可從海外存取的資料源。

## 不要做的事
- 不要宣稱準確率或保證獲利；推薦是條件篩選結果，頁面要保留「不構成投資建議」。
- 對學員公開個股推薦在台灣可能涉及投顧法規，已提醒過使用者，措辭維持「條件篩選」。
