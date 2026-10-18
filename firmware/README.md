# firmware/ — ESP32-C6 範例韌體

`esp32c6_ir_hub/esp32c6_ir_hub.ino` 是 esp-hub 的 ESP32-C6 用戶端範例。

> **狀態：寫好了，但從未編譯、從未上板。**
> 這份範例是在沒有編譯器、沒有板子的環境寫的（刻意不在那台電腦安裝工具鏈）。
> 第一次編譯很可能要修幾個小錯誤。修好後請把結果（編譯過了沒、實機行為）寫回 `docs/PRD.md`。

## 它做什麼

| 功能 | 說明 |
|---|---|
| 憑證放 NVS | `device_id`、`api_key`、Wi-Fi、伺服器位址都存在 Preferences（NVS），不寫在程式碼。所有板子燒同一份韌體 |
| 首次註冊 | NVS 有 `enroll_code` 就呼叫 `POST /api/v1/enroll` 換 key；**key 存進 NVS 並讀回確認後**才刪掉註冊碼 |
| 自動換 key | 每天 `POST /api/v1/heartbeat`；回 `should_rotate:true` 就 `POST /api/v1/rotate`，**新 key 存進 NVS 成功才切換**；存失敗就沿用舊 key（伺服器 24 小時寬限內仍認得，下次再換） |
| 過期處理 | 401 `api key expired` → 停止重試並印出提示，等管理者給新註冊碼；其他 401（被撤銷）每 30 分鐘重試一次 |
| MQTT | 使用者名稱 = 裝置 ID、密碼 = API key；Last Will 設為 `offline`；連線被拒（state 4/5）時會打一次 heartbeat 弄清楚是過期還是被撤銷 |
| 事件 | `boot`、`enrolled`、`key_rotated`、`ir_tx`、`ir_rx`、`power_on`、`power_off`，失敗時暫存最多 16 筆重送 |
| 序列埠指令 | `WIFI`、`ENROLL`、`KEY`、`SET`、`STATUS`、`WIPE`、`REBOOT`、`HELP` |

想請 AI 幫你產生或改寫韌體？見 [AI-PROMPT.md](AI-PROMPT.md)（可直接貼上的 prompt，含完整 API 規格，且不需要把 Wi-Fi 密碼或註冊碼貼給 AI）。

## 開發環境（新電腦要自己裝）

- Arduino IDE 2.x（或 `arduino-cli`）＋ **esp32 board package 3.x**。
- 板型：`ESP32C6 Dev Module`（以實際板子為準）。DevKitC-1 的 USB 孔要開 **Tools → USB CDC On Boot: Enabled**，Serial 才有輸出。
- 函式庫：`PubSubClient`、`IRremoteESP8266`（用最新版；對 C6 的支援我沒驗證，編不過先升級函式庫）。

## 第一次上板（序列埠，115200）

1. 在管理頁面按「新增裝置」（預設勾選註冊碼），記下**裝置 ID**與**註冊碼**（只顯示一次，24 小時內有效、只能用一次）。
2. 燒錄後打開序列埠監控，輸入（韌體裡的預設主機是占位字，所以**一定要先 `SET host`**，網域向管理者取得）：

```
SET host 你的網域.fly.dev
WIFI 你的SSID 你的Wi-Fi密碼
ENROLL esp-living en_xxxxxxxxxxxxxxxxxxxxxx
STATUS
```

3. 板子連上 Wi-Fi 後會自己用註冊碼換 key，log 出現 `[enroll] OK`，管理頁面的「待註冊」標籤消失、MQTT 顯示在線。
4. 之後不用再碰：每天 heartbeat，剩 1/3 壽命時自動換 key。

換 key 後想確認：`STATUS` 會顯示 key 的前 5 個字元（完整 key 不會印出來）。

## 對本機伺服器測試（不用 TLS、不用等 90 天）

在電腦上 `npm start`（HTTP 8080、MQTT 1883；`KEY_TTL_DAYS=0.002` 約 3 分鐘到期），板子與電腦在同一個區網：

```
SET host 192.168.1.50
SET tls 0
SET http_port 8080
SET mqtt_port 1883
SET hb 20
```

`SET hb 20` 讓板子每 20 秒 heartbeat 一次，才看得到自動換 key；測完記得把 `host`/`tls`/`http_port`/`mqtt_port`/`hb` 設回去（或 `WIPE` 後重新佈署）。

## 已知缺口（接手要處理）

1. **「運轉中 / 未運轉」是假設的**：目前只是「按鈕切換並認為設備跟著開/關」，沒有任何感測。要怎麼偵測請先問使用者（見 `docs/PRD.md` §0.4）。
2. **TLS 沒驗證伺服器**：`ROOT_CA` 為 `nullptr` 時用 `setInsecure()`（有加密、不驗身分）。正式版請放入根憑證。
3. **NVS 未加密**：有實體接觸的人可以讀出 flash 裡的 key。要防這個需開 flash encryption + NVS encryption。
4. **腳位與 IR 碼是占位**：`GPIO4` 發射、`GPIO5` 接收、`GPIO9` 按鈕、`0x20DF10EF`（NEC）。請依實際接線與設備改。
5. **批次燒錄**尚未實作（`tools/provision.*`，見 PRD P0）。板子數量不多時，用上面的序列埠指令就夠。
6. 序列埠 `WIFI` 指令的 SSID 不能有空白（密碼可以）。
7. 沒有 OTA 更新。
