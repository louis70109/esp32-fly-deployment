# esp-hub PRD / 交接文件

最後更新：2026-10-18　｜　狀態：伺服器（含金鑰生命週期）已部署到 Fly 並在線上驗證；**ESP32-C6 韌體尚未完成**（見「待辦」）

編寫與維護規則見 [README.md](README.md)；接手前先讀。

## 0. 換電腦接手指南（先做這些）

使用者會**換另一台電腦**，用這份 PRD 接著做 ESP32 韌體與燒錄。新電腦上沒有這次對話的任何記憶，
所以下面每一步都要照做，不要假設環境已經準備好。

### 0.1 取得並驗證程式（約 5 分鐘）
```bash
git clone https://github.com/louis70109/esp32-fly-deployment.git
cd esp32-fly-deployment
git log --oneline | head -5          # 最新一筆應是「金鑰生命週期」相關；若不是，代表上一台電腦還沒 push，請先請使用者去 push
npm install
npm test                              # 必須看到 "38 checks passed" 與 "4 checks passed"
```
- Node ≥ 16（Fly 的 Docker 映像用 Node 20）。`better-sqlite3` 釘在 `~8.7.0`，原因見 §6。
- `npm start` 會在 console 印出本機測試用的帳號與隨機密碼（只在沒設 `ADMIN_PASSWORD` 時）。
  本機伺服器預設 HTTP `8080`、MQTT（明文）`1883`，**不是** Fly 上的 TLS 8883。

### 0.2 確認 Fly 與線上狀態
```bash
flyctl auth whoami                    # 應為 louis70109@gmail.com；否則請使用者自己執行 flyctl auth login
flyctl status --app esp-hub-louis
curl https://esp-hub-louis.fly.dev/healthz    # {"ok":true}
```
- Windows 上 PowerShell 可能找不到 `fly`，用 `flyctl`。
- **管理者密碼不在任何檔案裡**，使用者自己保管。忘了就重設：`flyctl secrets set ADMIN_PASSWORD="新密碼" --app esp-hub-louis`（會自動重啟）。
- 線上已是含註冊碼 / 到期 / rotate 的版本，可直接用 ESP 實測。要測「到期」類行為又不想等 90 天，改用本機伺服器並設 `KEY_TTL_DAYS=0.002`
  （約 3 分鐘；區網內讓板子連電腦的 IP:1883，韌體要有可切換的 host / port / 是否 TLS）。

### 0.3 韌體開發環境（新電腦要自己裝；**我沒有驗證過任何一項**）
- Arduino IDE 2.x（或 `arduino-cli`）＋ **esp32 board package 3.x**（C6 需要 3.x）；板型選 "ESP32C6 Dev Module"（實際板子型號請先問使用者）。
- 函式庫：`PubSubClient`、`IRremoteESP8266`（用最新版；C6 支援不確定，編不過就先升級、再不行改 RMT）。
- 燒錄 / NVS 工具：`esptool`（`pip install esptool`）；批次產生 NVS 用 `esp-idf-nvs-partition-gen`（pip 套件，用法與版本請先實測）。
- Windows 要確認 USB 序列埠驅動與 COM 埠；板子進不了下載模式時按住 BOOT 再按 RESET。

### 0.4 開工前必須先問使用者的事（PRD 沒答案，別自己猜）
1. **板子型號與數量？**（決定要不要做批次燒錄腳本；1–3 塊用序列埠設定就夠。）
2. **「運轉中 / 未運轉」要怎麼判斷？** 目前草稿只是「按鈕切換並假設狀態」，**沒有真的偵測設備是否在運轉**。
   是靠按鈕？偵測設備電源 / 電流？還是只記錄「我們送出了開機 / 關機訊號」？這會影響整個回報邏輯。
3. **要控制 / 記錄哪些設備、什麼 IR 協定？** 通常要先用接收器抓一次該設備遙控器的碼，才知道協定與位元數。
4. **IR 發射 LED 與接收器的實際接法與腳位**（草稿用 GPIO4 發射、GPIO5 接收、GPIO9 按鈕，只是占位）。
5. **Wi-Fi 環境**（2.4GHz？有沒有 captive portal？）與板子要放的位置（電源是否穩定，決定斷電恢復的重要性）。

### 0.5 現有韌體範例的狀態
`firmware/esp32c6_ir_hub/esp32c6_ir_hub.ino` 是**寫好但從未編譯、從未上板**的範例（使用者明確要求「先不要自己編譯」，所以沒有安裝任何工具鏈）。
它已經包含：憑證存 NVS、序列埠佈建指令、`/enroll` 首次註冊、每日 `/heartbeat`、`should_rotate` 時 `/rotate`（新 key 存 NVS 並讀回確認後才切換）、
過期 / 被撤銷的處理、MQTT（含 Last Will）、IR 發射與接收、事件重送佇列。使用方式與已知缺口見 [firmware/README.md](../firmware/README.md)。
**接手的第一件事是在新電腦上編譯它**，修掉編譯錯誤後上板驗證，並把結果寫回本文件。

### 0.6 建議的開場提示（使用者貼進新 session）
> 請先讀 `docs/README.md` 與 `docs/PRD.md`，照 §0 的步驟驗證環境，然後先問我 §0.4 的問題，再接著做 §5 的 P0（ESP32-C6 韌體）。
> 做完請依 `docs/README.md` 的交接檢查更新 PRD。

## 1. 目標

用 ESP32-C6 控制紅外線（IR）發射器（例如冷氣、除濕機），並把「發射了什麼 IR 碼、開機/關機」這類事件
集中記錄到雲端；同時用 MQTT 持續回報板子是否在線、設備目前是否運轉；用網頁管理每一塊板子。

### 使用者需求（原話整理）
1. 一個有 **API key** 的服務，ESP32-C6 可以呼叫 API 把 IR 發射與開關機訊號記錄在 server。
2. ESP 可以透過 **MQTT** 更新狀態，確保服務「使用中 / 沒有運轉」。
3. server 可以分開開也行（目前選擇合併成一個程式，見決策）。
4. 有**前端**可看每一塊 ESP 的狀態並管理。
5. 前端要有**管理者帳號密碼**登入。
6. 每塊板子的 API key 要用**最有效率、不占空間**的方式設定（→ 見待辦 P0）。
7. API key 要能**動態**：有到期時間（TTL）、板子能自己換 key；伺服器端要實作這些（2026-10-18 已完成，見 §3）。

## 2. 現況（已完成並上線）

| 項目 | 內容 |
|---|---|
| Fly app | `esp-hub-louis`，region `nrt`，單一機器 |
| 前端 / API | https://esp-hub-louis.fly.dev |
| MQTT | `esp-hub-louis.fly.dev:8883`（TLS，Fly 終結，轉到容器 1883） |
| GitHub | https://github.com/louis70109/esp32-fly-deployment（`main`） |
| 文章（GitHub Pages） | https://nijialin.com/esp32-fly-deployment/ （原始檔在 `site/`，推到 `main` 且 `site/**` 有變更時由 `.github/workflows/pages.yml` 自動部署；帳號有綁自訂網域，所以不是 `louis70109.github.io`） |
| 儲存 | SQLite，Fly volume `hub_data` 掛在 `/data`（1 GB） |
| IP | 共用 IPv4 + 專屬 IPv6（免費；沒有買專屬 IPv4） |
| Fly secrets | `ADMIN_USER`、`ADMIN_PASSWORD`、`SESSION_SECRET`（**密碼不在 repo 裡**，也不要寫進文件；使用者已拿到） |

已驗證（線上端到端 + 本機 `npm test`）：HTTP 事件上傳、MQTT over TLS 上線/離線偵測、
管理登入、錯誤密碼 / 偽造 cookie / 舊金鑰皆被拒。

### 2.0.1 「AI Prompt」功能（2026-10-19，**程式已推送、管理頁面尚未部署到 Fly**）
給使用者貼給 AI 產生韌體的 prompt，單一正本是 `public/ai-prompt.txt`：
- 管理頁面：右上角「AI Prompt」按鈕（檢視 + 複製），註冊碼 / 金鑰對話框也有「複製 AI Prompt」。複製有 `execCommand` 備援，失敗會明說。
- 文章頁：「丟給 AI 幫你寫韌體」區塊。Pages 工作流程在部署時把 `public/ai-prompt.txt` 複製成 `site/ai-prompt.txt`（該檔已 gitignore）。
- `firmware/AI-PROMPT.md` 版本 A 必須與 `public/ai-prompt.txt` 完全一致，`npm test` 的 `test/prompt.js` 會檢查（改 prompt 請兩處同步）。
- 已驗證：本機瀏覽器真實點擊「複製」顯示「已複製 ✓」（腳本模擬的點擊會被瀏覽器拒絕，不代表壞掉）。
- **未驗證**：prompt 實際讓 AI 產生的韌體能不能編譯——沒有人跑過。
- 正式站要等下次 `flyctl deploy`（照 §6 流程）才會有管理頁面的按鈕；文章頁推送後由 Pages 自動更新。

### 2.0 註冊碼對話框 `null` 字樣（已修正並已部署）
2026-10-18 在瀏覽器實際操作「新增裝置 → 註冊碼」時發現：對話框按鈕上方多出一行字面的 `null`（原生 `replaceChildren()` 會把 `null` 轉成文字）。
已在 `public/index.html` 修正（改用 `fill()` 過濾空值），本機驗證消失；**已於 2026-10-19（台灣時間）部署到 Fly**，
並由 `tools/e2e-prod.js` 確認線上提供的是含修正的版本（檢查頁面內含 `const fill = `）。

### 2.1 金鑰生命週期（2026-10-18 完成，**已部署並在線上驗證**）
- **部署**：2026-10-18，程式為 commit `ac23016`。部署前手動建立 volume 快照 `vs_BYPBxn2KOYMSe0ggRemo`（保留 5 天；volume 當時才建立 2 小時，每日自動快照尚未產生）。
  正式資料庫的遷移在啟動時自動完成，log 無錯誤。
- **第二次部署**（2026-10-19，台灣時間）：commit `8932a99`（含 `null` 修正）。部署前再手動建立快照 `vs_geY581XZae3sxmXlR8J`（舊的 `vs_BYPB...` 已是 10 小時前、且早於上次部署）；
  部署後 `tools/e2e-prod.js` 全部通過、測試裝置已刪除。
- **本機測試**：`npm test` = `test/smoke.js` 38 項 + `test/migrate.js` 4 項（用舊結構的暫存資料庫驗證遷移）。
- **線上端到端**（部署後執行，測完已刪除測試裝置）：以 `enroll:true` 建立裝置 → `/enroll` 換 key（到期日 90.0 天）→ 註冊碼不可重用 →
  事件上傳 → heartbeat（`should_rotate:false`）→ MQTT over TLS 連線後在線 + 運轉中 → `/rotate`（寬限期內舊 key 可用、新 key 一用舊 key 即作廢）→
  管理者重新配發註冊碼並使舊 key 失效。全部通過。
- **瀏覽器驗證**：「新增裝置 → 註冊碼 → 重新產生註冊碼」在本機示範資料上實際點過（因此發現上面 §2.0 的 `null` 問題）；正式站沒有登入操作過。
- **未驗證**：過期掃描（每分鐘踢掉已連線 session）只在本機測試過，線上沒等到真的過期。

已實作：一次性註冊碼 `/enroll`、預設 90 天到期、板子自行 `/rotate`（含 24h 寬限與斷電恢復）、
`/heartbeat` 回報 `should_rotate`、MQTT 過期 session 掃描（每分鐘）、前端的「註冊碼」按鈕 / 到期顯示 / 「待註冊」標籤。
細節與規則見 README「金鑰生命週期」。

## 3. 架構與決策

單一 Node 程式（`src/server.js`）同時做三件事：Express REST + 靜態前端、內建 **Aedes** MQTT broker、SQLite（`better-sqlite3`）。

為什麼合併不分開：資料量小、一台機器就夠、presence 由 broker 的連線事件直接寫 DB，不需要跨服務同步。
代價：**只能跑一台機器**（broker 連線狀態在記憶體，SQLite 在單一 volume）。不要 `fly scale count 2`。
若未來要水平擴充，才需要拆出獨立 broker（如 EMQX / Mosquitto）+ 共用資料庫。

### 驗證模型
- **裝置**：每台一把 API key（`dk_` + 24 bytes base64url）。伺服器只存 SHA-256，**key 只在建立 / 換金鑰 / 註冊時顯示一次**。
  同一把 key 用於 HTTP（`X-API-Key`）與 MQTT 密碼（username = 裝置 ID，必須與 key 對應同一台）。
- **管理者**：`POST /api/v1/login {username,password}` → HttpOnly + SameSite=Strict + Secure 的簽章 session cookie（預設 12 小時）。
  舊的 `X-Admin-Key` 已移除。登入與 key 驗證失敗有每 IP 節流（60 秒內超過 20 次回 429）。
- MQTT ACL：裝置只能發佈 `devices/<自己id>/{state,event,status}`，只能訂閱 `devices/<自己id>/cmd`。
- 前端所有裝置來源資料都用 `textContent` 渲染（已用 `<img onerror>` 測過不會執行）。

### 金鑰生命週期的決策（2026-10-18）
- **選「註冊碼 + 到期 + 板子自動換」，不選 JWT / 短效 token**：裝置少、單一伺服器，JWT「免查資料庫」的好處用不到；
  遺失的板子需要能**立刻撤銷**，API key 比 JWT 容易；短效 token 仍要在板子存長效密鑰，被偷風險沒降低，還要處理 MQTT 重連。
  何時重新考慮：裝置數量大到驗證查詢成為瓶頸，或要把驗證拆給多個服務。
- **到期的 key 不能自己換**：否則外洩的 key 可以無限續命。代價：板子離線超過壽命就要人工重新配發（前端「註冊碼」按鈕）。
  因此板子應在 `should_rotate`（剩 1/3 壽命）時就換，並定期 heartbeat。
- **舊 key 寬限期 24 小時，新 key 一用就收掉舊 key**：避免板子寫 NVS 時斷電而失聯，又不讓舊 key 久留。
- **註冊碼 `/enroll` 不需驗證**（碼本身就是憑證）：128 bit 隨機、單次、24h、只存雜湊，並套用每 IP 失敗節流。
- **舊 key 預設不過期（遷移）**：避免部署新版時把已在現場的板子全部鎖死；要套用 TTL 須由管理者逐台「換金鑰」。
- 預設 `KEY_TTL_DAYS=90`。設 0 即新 key 永不過期（與舊行為相同）。

### 狀態語意
- **online**：由 MQTT 連線本身決定（連上=在線；斷線或 keepalive 逾時≈1.5×=離線）。同一裝置重連時以新連線為準（takeover），舊連線的斷線事件不會把它標離線。
- **running**（使用中 / 未運轉）：由 `devices/<id>/state` 的 `{"running":bool,...}` 或 HTTP `POST /state` 設定；
  `power_on` / `power_off` 事件也會自動更新 running。離線時前端顯示「狀態未知」，不顯示過期的運轉狀態。
- 事件 `ts`：裝置時鐘不可信，與伺服器差超過 24 小時就忽略改用伺服器時間。事件預設保留 90 天。

## 4. 介面摘要（完整版見 README.md）

```
裝置  POST /api/v1/events    {type, payload?, ts?}   X-API-Key        -> 201
      POST /api/v1/state     {running:bool,...}
      POST /api/v1/heartbeat   -> {key_expires_at, should_rotate}     POST /api/v1/rotate -> {api_key,...}
      POST /api/v1/enroll    {device_id, code}  不需 key           -> {api_key, key_expires_at}
管理  POST /api/v1/login | /logout ; GET /api/v1/session
      GET/POST /api/v1/devices {name,id?,enroll?} ; PATCH/DELETE /api/v1/devices/:id ; POST .../rotate-key
      POST /api/v1/devices/:id/enrollment {ttl_hours?}
      GET /api/v1/devices/:id/events?limit=&type= ; GET /api/v1/events
MQTT  devices/<id>/state | event | status(LWT) ; 訂閱 devices/<id>/cmd（目前 server 尚未發送任何指令）
```
事件 `type` 為 `[a-z0-9_.-]{1,40}`，慣用：`ir_tx`、`ir_rx`、`power_on`、`power_off`、`boot`。

## 5. 待辦（依優先順序）

### P0 — ESP32-C6 韌體（**範例已寫好，但從未編譯、從未上板，所以還不能算完成**）
`firmware/esp32c6_ir_hub/esp32c6_ir_hub.ino` 已依下列需求寫出範例（見 §0.5、firmware/README.md），要做的是**編譯、修錯、實機驗證、補缺口**。需求如下：

1. **憑證放 NVS，不寫死在程式碼**：所有板子燒同一份韌體；`device_id`、`api_key`、Wi-Fi SSID/密碼存在 NVS（`Preferences`），
   約 100 bytes、不占程式空間，更新韌體不會洗掉。
   **韌體要實作金鑰生命週期（伺服器端已完成）**：
   - 首次開機：NVS 沒有 `api_key` 但有 `enroll_code` → `POST /enroll` 換 key → **寫入 NVS 成功後**才開始正常運作並刪除註冊碼。
   - 每天（及開機時）`POST /heartbeat`；回 `should_rotate:true` 就 `POST /rotate`，先把新 key 寫進 NVS、成功後再改用新 key，
     並重連 MQTT。若 `/rotate` 的回應沒收到（逾時 / 斷電），下次開機仍握著舊 key，重打 `/rotate` 即可（伺服器已處理）。
   - 收到 401 `api key expired`：不要無限重試，進入「等待重新配發」狀態（例如 LED 提示），由管理者在前端按「註冊碼」，
     再用序列埠把新註冊碼寫進 NVS。
   - 韌體整體完成條件：①在實機編譯並上板；②一塊全新的板子只憑註冊碼就能上線並出現在前端；③按開關機 / 發射 IR 後，前端事件紀錄看得到；
     ④拔電重插後自動重連且狀態正確；⑤到期前自動換 key 且不中斷。
   - 驗收：用本機伺服器把 `KEY_TTL_DAYS` 設成很小的值（例如 0.002 ≈ 3 分鐘），確認板子能自動換 key 且不中斷上傳事件。
2. **兩種寫入方式**（使用者的核心要求：「最有效率給板子、不占空間」）：
   - 序列埠一次性設定：**範例已實作**（`WIFI` / `ENROLL` / `KEY` / `SET` / `STATUS` / `WIPE`），存入 NVS 後自動運作。
   - 批次燒錄腳本（**尚未實作**，`tools/provision.*`）：登入拿 cookie → `POST /api/v1/devices {enroll:true}` 建立裝置並拿到**註冊碼** →
     用 `nvs_partition_gen.py` 產生含 `device_id` + `enroll_code`（與 Wi-Fi）的 `nvs.bin` → `esptool` 只寫 NVS 分區。**位址與大小以板子實際的 partition table 為準**：Arduino-ESP32 預設是 0x9000、0x5000（20 KB），ESP-IDF 預設是 0x6000（24 KB）；先用 `esptool` / 專案的 `partitions.csv` 確認再產生 `nvs.bin`。
     因為燒進板子的是 24 小時內有效、單次的註冊碼而不是長效 key，批次檔案外流的風險很低；板子首次開機後自己換到 key。
     若不想用註冊碼，也可建立裝置時省略 `enroll`，直接把 `api_key` 寫進 NVS（只顯示一次）。
3. 在 ESP32-C6 實機**實際編譯並測試**。`IRremoteESP8266` 對 C6 的支援不確定，請用最新版；若不行考慮改用 ESP-IDF RMT / `IRremote`。
4. 草稿已包含、可沿用的設計：Wi-Fi + NTP、MQTT 含 Last Will、keepalive 30 秒、按鈕切換開關機並發 IR、
   IR 接收記錄 `ir_rx`、事件失敗時暫存 16 筆重送。
5. **TLS 驗證**：草稿用 `setInsecure()`（加密但不驗伺服器）。正式版改 `setCACert()`（Fly 的憑證鏈為 Let's Encrypt，注意憑證輪替與 ESP 記憶體）。
6. 腳本需要 `esptool` 與 ESP-IDF 的 `nvs_partition_gen.py`；先確認使用者有幾塊板子（決定要不要做批次腳本）。

### P1
- **Dependabot 安全警告**：推送時 GitHub 回報 https://github.com/louis70109/esp32-fly-deployment/security/dependabot/1 ，尚未查看是哪個套件、嚴重度。
  注意 `better-sqlite3` 釘在 `~8.7.0` 是因為本機 Node 16 沒有 9.x 的預編譯檔；Docker 用 Node 20，若要升級要確認兩邊。
- 前端沒有「為所有舊 key 一次套用到期日」的批次功能（舊 key 預設不過期，只能逐台換金鑰）。
- 前端沒有改密碼功能（目前只能 `flyctl secrets set ADMIN_PASSWORD=...`）。

### P2（需求未提，勿主動做）
- server → 裝置指令（`devices/<id>/cmd` 已開放訂閱但沒有發送端）、事件匯出 / 圖表、多管理者帳號、Fly 上的資料備份策略（volume 有每日快照保留 5 天）。

## 6. 開發與維運備忘

**部署新版的標準流程**（照做，這次就是這樣做的）：
1. `git push`；`npm test` 全過。
2. 確認 volume 有近期快照：`flyctl volumes snapshots list <volume-id> --app esp-hub-louis`（**要用 volume ID，不是名稱**；ID 用 `flyctl volumes list --app esp-hub-louis` 查）。
   沒有或太舊就 `flyctl volumes snapshots create <volume-id> --app esp-hub-louis`，等狀態從 `running` 變 `created` 再繼續。
3. `flyctl deploy --app esp-hub-louis --remote-only --ha=false`；看 `flyctl logs --app esp-hub-louis --no-tail`
   （啟動瞬間 health check 失敗一次是正常的，之後會 passing）。
4. `curl https://esp-hub-louis.fly.dev/healthz`，再對線上跑一次端到端（建測試裝置 → 驗證 → 刪除）：
   ```bash
   E2E_ADMIN_PASSWORD='管理者密碼' node tools/e2e-prod.js     # 需要先 npm install（用到 devDependency mqtt）
   ```
   密碼由使用者提供，只放環境變數，不要寫進檔案或指令歷史以外的地方。成功會印出 `production enrollment flow OK` 並刪除測試裝置。
5. 更新本文件的部署紀錄（§2.1）與變更紀錄，commit、push。

**小提醒**：快照剛建立時狀態是 `waiting` → `running` → `created`，要等到 `created` 才能部署；`flyctl` 的輸出要在 Git Bash 用管線餵給 `node` 讀取會失敗（EOF），直接寫死 volume ID 或改用 PowerShell。

```bash
npm install && npm start        # 本機；沒設 ADMIN_PASSWORD 會產生一組並印在 console（帳號 admin）
npm test                        # 端到端煙霧測試（HTTP + MQTT，用暫存資料庫）
flyctl deploy --app esp-hub-louis --remote-only --ha=false
flyctl logs --app esp-hub-louis
```

- 環境：使用者機器是 **Windows 11**，本機 **Node 16.17**（沒有全域 `fetch`，測試用 `http` 模組自製了 shim）。
  PowerShell 找不到 `fly`，要用 `flyctl`（WinGet 安裝；Git Bash 要用完整路徑）。已登入 Fly 帳號 `louis70109@gmail.com`。
- 在 Git Bash 用 `curl -d` 傳中文會被編碼成 `????`，這是 shell 問題不是伺服器問題；測中文請用 Node。
- `fly.toml`：`auto_stop_machines = "off"` 是必要的，機器休眠會讓所有裝置顯示離線。
- 部署新版時密碼 / `SESSION_SECRET` 不變；`SESSION_SECRET` 換掉會讓所有人登出。
- 安全守則：不要把 ADMIN 密碼、裝置 API key 寫進 repo、文件或 commit。

## 7. 變更紀錄
- 2026-10-19：新增 AI Prompt（`public/ai-prompt.txt`、管理頁面按鈕、文章頁區塊、`test/prompt.js` 防漂移）；複製按鈕加上 `execCommand` 備援與成功 / 失敗提示；
  repo description 放入服務與文章網址。管理頁面變更**尚未部署到 Fly**。
- 2026-10-19：部署註冊碼對話框 `null` 修正（部署前建快照 `vs_geY581XZae3sxmXlR8J`）；新增 `tools/e2e-prod.js` 作為線上端到端驗證，已對正式站跑過並通過。
- 2026-10-18：新增完整韌體範例（NVS、序列埠佈建、enroll / heartbeat / rotate、過期處理）與 firmware/README.md，**未編譯、未上板**；
  修正註冊碼對話框的 `null` 字樣（未部署）；新增 GitHub Pages 文章（`site/`，由 `.github/workflows/pages.yml` 部署）。
- 2026-10-18：部署金鑰生命週期到 Fly（commit `ac23016`），部署前先建 volume 快照，部署後在線上跑完註冊碼 / rotate 端到端並刪除測試裝置；程式已推到 GitHub `main`。
- 2026-10-18：實作金鑰生命週期（註冊碼 / 90 天到期 / 板子自行換 key / MQTT 過期掃描 / 前端對應 UI）、可設定的失敗節流、舊資料庫自動遷移；
  測試擴充為 38 + 4 項。過程中測試抓到並修正一個錯誤：建立裝置時回傳的 `enrollment_expires_at` 因組裝順序而缺漏。
- 2026-10-18：建立 PRD。伺服器（API key、MQTT、前端、帳密登入）完成並部署到 Fly；韌體列為 P0 待辦。
