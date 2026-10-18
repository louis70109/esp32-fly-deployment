# esp-hub

ESP32-C6 紅外線 / 開關機事件紀錄服務。一個 Node 程式同時提供：

| 功能 | 說明 |
|---|---|
| REST API + API key | 裝置用 `X-API-Key` 上傳事件（`ir_tx`、`ir_rx`、`power_on`、`power_off`…） |
| MQTT broker (內建) | 裝置用 MQTT 回報「在線 / 運轉中」，斷線由 broker 偵測 |
| 管理前端 `/` | 看每台 ESP 的在線、運轉狀態、事件紀錄；新增 / 改名 / 換金鑰 / 刪除 |
| SQLite | 存在 `DATA_DIR`（Fly 上是 volume） |

每台裝置有自己的 API key（建立時只顯示一次，資料庫只存 SHA-256）。同一把 key 同時用在 HTTP 與 MQTT 密碼。

## 本機執行

```bash
npm install
npm start      # 沒設 ADMIN_KEY 時會產生一組並印在 console
npm test       # 端到端煙霧測試（HTTP + MQTT）
```

環境變數：`ADMIN_KEY`（production 必填）、`PORT`(8080)、`MQTT_PORT`(1883)、`DATA_DIR`、`EVENT_RETENTION_DAYS`(90)。

## API

裝置端（Header `X-API-Key: dk_...`）

```
POST /api/v1/events     {"type":"ir_tx","payload":{...},"ts":1700000000000}   -> 201
POST /api/v1/state      {"running":true}
POST /api/v1/heartbeat
```
`type` 為 `[a-z0-9_.-]{1,40}`；`ts` 選填（毫秒，與伺服器差超過 24 小時就忽略）。
`power_on` / `power_off` 事件會自動把裝置標成運轉中 / 未運轉。

管理端（Header `X-Admin-Key`）

```
GET    /api/v1/devices
POST   /api/v1/devices            {"name":"客廳冷氣","id":"esp-living"}  -> 回傳 api_key（僅此一次）
PATCH  /api/v1/devices/:id        {"name":"..."}
POST   /api/v1/devices/:id/rotate-key
DELETE /api/v1/devices/:id
GET    /api/v1/devices/:id/events?limit=100&type=ir_tx
GET    /api/v1/events?limit=100
```

## MQTT

連線：`username = 裝置 ID`、`password = API key`（身分與 key 必須是同一台）。

| Topic（裝置發佈） | 內容 |
|---|---|
| `devices/<id>/state` | `{"running":true,...}`（建議 retain） |
| `devices/<id>/event` | `{"type":"ir_tx","payload":{...}}`，等同 HTTP 事件 |
| `devices/<id>/status` | `online` / `offline`（給 Last Will 用，presence 以連線本身為準） |

裝置只能發佈自己的上述 topic，訂閱自己的 `devices/<id>/cmd`；其他一律拒絕。
Broker 偵測到斷線（含 keepalive 逾時，約 1.5 × keepalive）就把該裝置標為離線。

## 部署到 Fly.io

```bash
# 1. 改 fly.toml 的 app 名稱（需全域唯一）
fly launch --copy-config --no-deploy
fly volumes create hub_data --size 1 --region nrt
fly secrets set ADMIN_KEY="$(openssl rand -base64 24)"
fly deploy
```

- **只能跑一台機器**：broker 的連線狀態在記憶體、SQLite 在單一 volume。不要 `fly scale count 2`。
- 前端 / API：`https://<app>.fly.dev`；MQTT：`<app>.fly.dev:8883`（TLS，Fly 終結）。
- 已設定 `auto_stop_machines = "off"`，否則機器睡著會讓所有裝置顯示離線。
- Fly 的共享 IPv4 只支援 HTTP/TLS handler；本設定的 8883 用 `tls` handler，可用。若連不上再 `fly ips allocate-v4` 配專屬 IP。

## ESP32-C6 韌體

`firmware/esp32c6_ir_hub/esp32c6_ir_hub.ino`：Wi-Fi、NTP、MQTT（含 Last Will）、IR 發射 / 接收、
按鈕切換開關機、事件失敗時暫存 16 筆重送。填入 Wi-Fi、`HUB_HOST`、`DEVICE_ID`、`API_KEY` 即可。

注意：
- 範例用 `setInsecure()`（加密但不驗證伺服器）。正式使用請改 `setCACert()`。
- IRremoteESP8266 對 ESP32-C6 的支援請用最新版；韌體尚未在實機編譯驗證。
