# 🚄 高鐵車票報帳小幫手

把台灣高鐵車票整理成報帳資料的純前端網頁：

**車票截圖／照片 → OCR 明細 → 電子車票證明 PDF 自動解密合併 → 套用 Word 模板產生報帳單**

👉 線上使用：<https://renhuang-huang.github.io/thsrc-expense-report/>

🔒 **隱私**：所有圖片、PDF、Word 模板都只在你的瀏覽器裡處理，沒有後端伺服器，也不會上傳任何檔案。
唯一例外：你選擇用「Claude」辨識並自行填入 API key 時，圖片會直接從你的瀏覽器送到 Anthropic API（不經過本站）。API key 只存在該分頁（sessionStorage），關閉分頁就清除。

## 功能

| 步驟 | 說明 |
|---|---|
| 1. 報帳資料 | 申請人、申請日期（預設今天 `yyyy/mm/dd`）、出差描述、統一編號（選填）、公司名稱（選填）。申請人、統編、公司名稱會記在這台電腦的瀏覽器，下次自動帶入。 |
| 2. 上傳車票圖片 | T Express 截圖、紙本車票照片都可以，可多選。OCR 解析出：類型（手機／紙本）、座別（對號座／自由座）、搭乘日期、起訖站、車票號碼 13 碼、訂位代號 8 碼、金額。紙本照片旋轉 90 度也能辨識。 |
| 3. 明細表 | 辨識結果可直接修改；缺漏或格式不對的欄位會標紅。可新增、刪除列。T Express 截圖通常沒有票價，會先用「預設票價」（例如 130），之後上傳 PDF 時會依證明上的票價自動更正。 |
| 4. 下載證明 | 每筆都會列出在 [高鐵 ptis 網站](https://ptis.thsrc.com.tw/ptis/index) 要點哪裡、要填什麼（點一下就能複製）。下載後把 PDF 拖回網頁，會用搭乘日期當密碼自動解開，再依票號／訂位代號／日期與起訖站對應到明細。沒對上的可以手動指定，或直接「新增成一筆」（只上傳 PDF、不上傳截圖也可以）。 |
| 5. Word 模板 | 上傳自己的 `.docx` 模板，或用內建的範例模板。 |
| 6. 匯出 | **合併 PDF**（依日期排序、無密碼，可選擇在最前面加一頁報帳單）、**Word 報帳單**、**明細 CSV**（格式與舊版 `車票明細.txt` 相同）、**報帳單 PDF**（單獨一份）。 |

### OCR 引擎

- **Tesseract.js**（預設、免費）：在瀏覽器本機辨識（`chi_tra` + `eng`），第一次會載入約 8MB 的引擎與語言資料，之後由瀏覽器快取。引擎與語言檔都放在本站，不依賴外部 CDN。辨識完請一定要檢查一次。
- **Claude**（選用，較準）：填入你自己的 Anthropic API key，瀏覽器直接呼叫 Messages API（模型 `claude-sonnet-5-5`，結構化 JSON 輸出）。費用由你的 API 帳號支付。

## Word 模板佔位符

佔位符一律寫成 `{{名稱}}`：

| 佔位符 | 內容 |
|---|---|
| `{{申請人}}` | 使用者填的申請人 |
| `{{申請日期}}` | 預設今天，格式 `yyyy/mm/dd` |
| `{{出差描述}}` | 使用者填的出差描述 |
| `{{統一編號}}` | 選填，沒填就是空白 |
| `{{公司名稱}}` | 選填，沒填就是空白 |
| `{{總金額}}` | 所有車票金額加總，有千分位（例：`1,560`） |
| `{{筆數}}` | 車票張數 |
| `{{清單}}` | 多行文字，每行 `日期,起站,迄站,金額`，依日期排序 |
| `{{#清單}}…{{/清單}}` | 每筆重複一次。區塊內可用 `{{序號}}` `{{日期}}` `{{起站}}` `{{迄站}}` `{{金額}}` `{{車票號碼}}` `{{訂位代號}}` |

**表格逐列展開**：在表格的某一列，第一格開頭寫 `{{#清單}}{{序號}}`、中間格寫 `{{日期}}` `{{起站}}` `{{迄站}}`、最後一格寫 `{{金額}}{{/清單}}`，匯出時這一列會依車票數量自動複製。可以參考網頁上的「下載範例模板」（[`public/sample-template.docx`](public/sample-template.docx)）。

> 小提醒：在 Word 裡打佔位符時，盡量一次打完、不要中途改格式，`{{` 和 `}}` 請用半形。

## 使用步驟

1. 填申請人、出差描述（需要的話填統編與公司名稱）。
2. 上傳這次要報帳的所有車票截圖／照片，等辨識完成。
3. 檢查明細表，把紅框補好。**一定要確認正確**，因為每張電子車票證明只能下載一次。
4. 依步驟 4 的指引，到高鐵網站逐張下載電子車票證明，再把 PDF 全部拖回網頁。
5. （選）上傳自己的 Word 模板。
6. 按「合併 PDF」「Word 報帳單」匯出。

## 限制

- **網頁不能代為從高鐵網站下載證明**：ptis 網站有 reCAPTCHA v3、不允許跨網域呼叫（CORS），而且每張證明只能下載一次。所以這一步要請使用者自己在高鐵網站操作，網頁只提供每張票要填的資料。
- 電子車票證明的開啟密碼是搭乘日期 `YYYYMMDD`。網頁會先用 [qpdf](https://github.com/qpdf/qpdf)（WASM）解密再用 pdf-lib 合併；萬一解不開，會改用 pdf.js 以密碼開啟後把每頁轉成高解析影像重建（此時合併檔裡的文字無法選取）。
- OCR 不保證百分之百正確，尤其是 Tesseract.js。請在下載證明前人工核對。
- 報帳單封面用瀏覽器內建字型繪製成影像，字型外觀會依作業系統略有不同。
- 本工具與台灣高鐵公司無關。

## 開發

需要 Node.js 22 以上。

```bash
npm install
npm run dev      # 本機開發 http://localhost:5173/thsrc-expense-report/
npm test         # 單元測試（OCR 文字解析、日期格式、金額加總、Word 模板、PDF 解密合併）
npm run build    # 產出 dist/
npm run make-template   # 重新產生 public/sample-template.docx
```

`npm run dev` / `npm run build` 會先執行 `scripts/copy-vendor.mjs`，把 Tesseract 引擎、中文語言資料與 pdf.js 字型表從 `node_modules` 複製到 `public/vendor/`（不進版控）。

技術：Vite + TypeScript（無框架）、tesseract.js、pdf.js、pdf-lib、qpdf-wasm、docxtemplater + PizZip、@anthropic-ai/sdk。

### 程式結構

| 檔案 | 用途 |
|---|---|
| `src/parse.ts` | OCR 文字與證明 PDF 內文的解析規則 |
| `src/stations.ts` | 站名正規化與代碼（南港 1 … 左營 12，台／臺都接受） |
| `src/format.ts` | 日期格式、金額加總、CSV、缺漏欄位檢查 |
| `src/ocr.ts` | Tesseract.js（含自動旋轉重試）與 Claude 辨識 |
| `src/pdf.ts` / `src/pdfjs.ts` | qpdf 解密、pdf-lib 合併、pdf.js 讀內文與影像備援 |
| `src/template.ts` | 套用 Word 模板 |
| `src/cover.ts` | 報帳單 PDF 頁面 |
| `src/main.ts` | 畫面與流程 |

## 部署（GitHub Pages）

推到 `main` 後，`.github/workflows/deploy.yml` 會自動測試、建置並部署。

第一次使用請到 repo 的 **Settings → Pages**，把 **Source** 設為 **GitHub Actions**。
