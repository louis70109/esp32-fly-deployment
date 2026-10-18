# esp-hub

ESP32-C6 紅外線 / 開關機事件紀錄服務。一個 Node 程式同時提供：

| 功能 | 說明 |
|---|---|
| REST API + API key | 裝置用 `X-API-Key` 上傳事件（`ir_tx`、`ir_rx`、`power_on`、`power_off`…） |
| MQTT broker (內建) | 裝置用 MQTT 回報「在線 / 運轉中」，斷線由 broker 偵測 |
| 管理前端 `/` | 看每台 ESP 的在線、運轉狀態、事件紀錄；新增 / 改名 / 換金鑰 / 刪除 |
| SQLite | 存在 `DATA_DIR`（Fly 上是 volume） |

每台裝置有自己的 API key（只顯示一次，資料庫只存 SHA-256）。同一把 key 同時用在 HTTP 與 MQTT 密碼。
key 有生命週期：**一次性註冊碼**配發、**預設 90 天到期**、板子可**自行換 key**（見下方「金鑰生命週期」）。

## 本機執行

```bash
npm install
npm start      # 沒設 ADMIN_PASSWORD 時會產生一組並印在 console（帳號預設 admin）
npm test       # 端到端煙霧測試（HTTP + MQTT）
```

環境變數：`KEY_TTL_DAYS`(90，0=新金鑰不過期)、`KEY_GRACE_HOURS`(24)、`ENROLL_TTL_HOURS`(24)、`AUTH_FAIL_LIMIT`(20)、`ADMIN_USER`(admin)、`ADMIN_PASSWORD`（production 必填）、`SESSION_SECRET`（簽 session cookie，建議固定）、`SESSION_HOURS`(12)、`PORT`(8080)、`MQTT_PORT`(1883)、`DATA_DIR`、`EVENT_RETENTION_DAYS`(90)。

## API

裝置端（Header `X-API-Key: dk_...`）

```
POST /api/v1/events     {"type":"ir_tx","payload":{...},"ts":1700000000000}   -> 201
POST /api/v1/state      {"running":true}
POST /api/v1/heartbeat                                   -> {key_expires_at, should_rotate, server_time}
POST /api/v1/rotate                                      -> {api_key, key_expires_at, old_key_valid_until}
POST /api/v1/enroll     {"device_id","code"}  (不需 key)  -> 201 {api_key, key_expires_at}
```
`type` 為 `[a-z0-9_.-]{1,40}`；`ts` 選填（毫秒，與伺服器差超過 24 小時就忽略）。
`power_on` / `power_off` 事件會自動把裝置標成運轉中 / 未運轉。

管理端（先 `POST /api/v1/login {username,password}` 取得 HttpOnly session cookie；`POST /logout` 登出）

```
GET    /api/v1/devices
POST   /api/v1/devices            {"name":"客廳冷氣","id":"esp-living","enroll":true}
                                  enroll:true -> 回傳 enrollment.code（僅此一次），裝置尚無可用 key
                                  省略 enroll -> 直接回傳 api_key（僅此一次）
POST   /api/v1/devices/:id/enrollment  {"ttl_hours":24}  -> 為既有裝置產生新註冊碼（重新配發）
PATCH  /api/v1/devices/:id        {"name":"..."}
POST   /api/v1/devices/:id/rotate-key
DELETE /api/v1/devices/:id
GET    /api/v1/devices/:id/events?limit=100&type=ir_tx
GET    /api/v1/events?limit=100
```

## 金鑰生命週期

```
建立裝置(enroll:true) ──► 註冊碼(24h、單次) ──板子 POST /enroll──► api_key(90 天) ──快到期──► POST /rotate ──► 新 key
```

| 機制 | 行為 |
|---|---|
| 註冊碼 `en_...` | 24 小時（可設 1–168）、只能用一次、只存雜湊；對同一裝置再產生一組，舊的未使用碼立即作廢。`/enroll` 有失敗節流 |
| key 到期 | 預設 90 天（`KEY_TTL_DAYS`）。過期：HTTP 回 401 `api key expired`、MQTT 拒絕連線、已連線的 session 會在 1 分鐘內被踢掉。**過期的 key 不能自己 rotate**，要由管理者產生註冊碼重新配發 |
| 板子換 key | `POST /rotate`（用目前的 key）。舊 key 再有效 `KEY_GRACE_HOURS`(24h)；**新 key 第一次成功使用時舊 key 立即作廢** |
| 換 key 回應遺失（斷電） | 板子還握著舊 key，重打 `/rotate` 即可取得新 key，不會被鎖死 |
| 何時該換 | `POST /heartbeat` 回 `should_rotate:true`（剩餘壽命 ≤ 1/3，或正在用舊 key）；建議板子每天 heartbeat 一次 |
| 舊版已存在的 key | 資料庫自動遷移，`key_expires_at` 為空＝**永不過期**，直到管理者換 key |
| 管理者「換金鑰」 | 立刻換 key、舊 key 馬上失效、踢掉 MQTT、作廢未使用的註冊碼（給新 key 全新的 90 天） |
| 重新配發（註冊碼） | 舊 key 在板子完成註冊前仍有效；完成註冊後舊 key 失效、MQTT 被踢 |

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
fly secrets set ADMIN_USER=admin ADMIN_PASSWORD="$(openssl rand -base64 18)" SESSION_SECRET="$(openssl rand -hex 32)"
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
