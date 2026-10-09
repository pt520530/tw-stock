# 168 台股選股（GitHub 雲端版）

每個交易日傍晚，GitHub 會自動抓證交所、櫃買中心和美股資料，算出「今日推薦」，更新到一個固定網址。手機打開就能看，電腦不用開。

## 第一次設定（大約 15 分鐘）

**1. 申請 GitHub 帳號**
到 https://github.com 註冊（免費）。

**2. 建立儲存庫**
右上角「＋」→「New repository」
- Repository name：`tw-stock`（可以自己取）
- 選 **Public**（免費帳號要公開才能用網頁功能）
- 按「Create repository」

**3. 上傳檔案**
在新儲存庫頁面按「uploading an existing file」，把這個資料夾裡的檔案全部拖進去，按「Commit changes」。

> ⚠️ Mac 的 Finder 預設看不到 `.github` 資料夾，拖曳時可能漏掉它。
> 上傳後如果儲存庫裡沒有 `.github` 資料夾，請改用：「Add file」→「Create new file」，
> 檔名輸入 `.github/workflows/update.yml`，把同名檔案的內容整份貼上，再按「Commit changes」。

**4. 打開網頁功能**
儲存庫的「Settings」→ 左邊「Pages」→「Source」選 **GitHub Actions**。

**5. 第一次執行**
上方「Actions」→ 左邊「更新選股」→ 右邊「Run workflow」→ 綠色「Run workflow」。
第一次要回補半年資料，大約 30 分鐘。跑完會出現綠色勾勾。

**6. 打開網頁**
網址是 `https://你的帳號.github.io/tw-stock/`
手機打開後，用瀏覽器的「分享」→「加入主畫面」，以後就像 App 一樣點開。

## 之後

- 每個交易日台灣時間 17:45 和 19:20 自動更新，不用做任何事。
- 想馬上更新：Actions →「更新選股」→「Run workflow」。
- 每次執行的結果（哪些資料有抓到）在 Actions 點進該次執行就看得到。

## 和電腦版的差別

- 沒有盤中即時股價，顯示的是收盤價。
- GitHub 的主機在國外，證交所或櫃買中心有可能擋。網頁頂端會列出每個資料來源有沒有抓到。

## 注意

推薦是依固定條件計算的結果，用來學習選股方法，不是買賣建議。
這個網頁是公開的，知道網址的人都看得到。
