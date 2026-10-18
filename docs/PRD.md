# esp-hub PRD / 交接文件

最後更新：2026-10-18　｜　狀態：伺服器已上線；**ESP32-C6 韌體尚未完成**（見「待辦」）

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

## 2. 現況（已完成並上線）

| 項目 | 內容 |
|---|---|
| Fly app | `esp-hub-louis`，region `nrt`，單一機器 |
| 前端 / API | https://esp-hub-louis.fly.dev |
| MQTT | `esp-hub-louis.fly.dev:8883`（TLS，Fly 終結，轉到容器 1883） |
| GitHub | https://github.com/louis70109/esp32-fly-deployment（`main`） |
| 儲存 | SQLite，Fly volume `hub_data` 掛在 `/data`（1 GB） |
| IP | 共用 IPv4 + 專屬 IPv6（免費；沒有買專屬 IPv4） |
| Fly secrets | `ADMIN_USER`、`ADMIN_PASSWORD`、`SESSION_SECRET`（**密碼不在 repo 裡**，也不要寫進文件；使用者已拿到） |

已驗證（本機 `npm test` 18 項、線上端到端）：HTTP 事件上傳、MQTT over TLS 上線/離線偵測、
管理登入、錯誤密碼 / 偽造 cookie / 舊金鑰皆被拒。

## 3. 架構與決策

單一 Node 程式（`src/server.js`）同時做三件事：Express REST + 靜態前端、內建 **Aedes** MQTT broker、SQLite（`better-sqlite3`）。

為什麼合併不分開：資料量小、一台機器就夠、presence 由 broker 的連線事件直接寫 DB，不需要跨服務同步。
代價：**只能跑一台機器**（broker 連線狀態在記憶體，SQLite 在單一 volume）。不要 `fly scale count 2`。
若未來要水平擴充，才需要拆出獨立 broker（如 EMQX / Mosquitto）+ 共用資料庫。

### 驗證模型
- **裝置**：每台一把 API key（`dk_` + 24 bytes base64url）。伺服器只存 SHA-256，**key 只在建立 / 換金鑰時顯示一次**。
  同一把 key 用於 HTTP（`X-API-Key`）與 MQTT 密碼（username = 裝置 ID，必須與 key 對應同一台）。
- **管理者**：`POST /api/v1/login {username,password}` → HttpOnly + SameSite=Strict + Secure 的簽章 session cookie（預設 12 小時）。
  舊的 `X-Admin-Key` 已移除。登入與 key 驗證失敗有每 IP 節流（60 秒內超過 20 次回 429）。
- MQTT ACL：裝置只能發佈 `devices/<自己id>/{state,event,status}`，只能訂閱 `devices/<自己id>/cmd`。
- 前端所有裝置來源資料都用 `textContent` 渲染（已用 `<img onerror>` 測過不會執行）。

### 狀態語意
- **online**：由 MQTT 連線本身決定（連上=在線；斷線或 keepalive 逾時≈1.5×=離線）。同一裝置重連時以新連線為準（takeover），舊連線的斷線事件不會把它標離線。
- **running**（使用中 / 未運轉）：由 `devices/<id>/state` 的 `{"running":bool,...}` 或 HTTP `POST /state` 設定；
  `power_on` / `power_off` 事件也會自動更新 running。離線時前端顯示「狀態未知」，不顯示過期的運轉狀態。
- 事件 `ts`：裝置時鐘不可信，與伺服器差超過 24 小時就忽略改用伺服器時間。事件預設保留 90 天。

## 4. 介面摘要（完整版見 README.md）

```
裝置  POST /api/v1/events    {type, payload?, ts?}   X-API-Key        -> 201
      POST /api/v1/state     {running:bool,...}
      POST /api/v1/heartbeat
管理  POST /api/v1/login | /logout ; GET /api/v1/session
      GET/POST /api/v1/devices ; PATCH/DELETE /api/v1/devices/:id ; POST .../rotate-key
      GET /api/v1/devices/:id/events?limit=&type= ; GET /api/v1/events
MQTT  devices/<id>/state | event | status(LWT) ; 訂閱 devices/<id>/cmd（目前 server 尚未發送任何指令）
```
事件 `type` 為 `[a-z0-9_.-]{1,40}`，慣用：`ir_tx`、`ir_rx`、`power_on`、`power_off`、`boot`。

## 5. 待辦（依優先順序）

### P0 — ESP32-C6 韌體（**目前不存在可用的韌體**）
`firmware/esp32c6_ir_hub/esp32c6_ir_hub.ino` 只是**未編譯、未在實機驗證的草稿**，把 ID/key/Wi-Fi 寫死在程式裡。需要做成正式韌體：

1. **憑證放 NVS，不寫死在程式碼**：所有板子燒同一份韌體；`device_id`、`api_key`、Wi-Fi SSID/密碼存在 NVS（`Preferences`），
   約 100 bytes、不占程式空間，更新韌體不會洗掉。
2. **兩種寫入方式**（使用者的核心要求：「最有效率給板子、不占空間」）：
   - 序列埠一次性設定：NVS 沒有 key 時等待 `SET <id> <key>`（以及 Wi-Fi）指令，存入後重啟。
   - 批次燒錄腳本（`tools/provision.*`）：呼叫 `POST /api/v1/devices`（需先登入拿 cookie）建立裝置 → 拿到 key →
     用 `nvs_partition_gen.py` 產生 `nvs.bin` → `esptool` 只寫 NVS 分區（預設 0x9000，24 KB）。**key 只顯示一次，必須在建立當下寫入板子。**
3. 在 ESP32-C6 實機**實際編譯並測試**。`IRremoteESP8266` 對 C6 的支援不確定，請用最新版；若不行考慮改用 ESP-IDF RMT / `IRremote`。
4. 草稿已包含、可沿用的設計：Wi-Fi + NTP、MQTT 含 Last Will、keepalive 30 秒、按鈕切換開關機並發 IR、
   IR 接收記錄 `ir_rx`、事件失敗時暫存 16 筆重送。
5. **TLS 驗證**：草稿用 `setInsecure()`（加密但不驗伺服器）。正式版改 `setCACert()`（Fly 的憑證鏈為 Let's Encrypt，注意憑證輪替與 ESP 記憶體）。
6. 腳本需要 `esptool` 與 ESP-IDF 的 `nvs_partition_gen.py`；先確認使用者有幾塊板子（決定要不要做批次腳本）。

### P1
- **Dependabot 安全警告**：推送時 GitHub 回報 https://github.com/louis70109/esp32-fly-deployment/security/dependabot/1 ，尚未查看是哪個套件、嚴重度。
  注意 `better-sqlite3` 釘在 `~8.7.0` 是因為本機 Node 16 沒有 9.x 的預編譯檔；Docker 用 Node 20，若要升級要確認兩邊。
- 前端沒有改密碼功能（目前只能 `flyctl secrets set ADMIN_PASSWORD=...`）。

### P2（需求未提，勿主動做）
- server → 裝置指令（`devices/<id>/cmd` 已開放訂閱但沒有發送端）、事件匯出 / 圖表、多管理者帳號、Fly 上的資料備份策略（volume 有每日快照保留 5 天）。

## 6. 開發與維運備忘

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
