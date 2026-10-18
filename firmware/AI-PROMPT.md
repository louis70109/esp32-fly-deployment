# 給 AI 的 prompt：產生 ESP32 韌體

把下面的 prompt 貼給 ChatGPT / Claude / Cursor 等 AI，它就能產生連上 esp-hub 的 ESP32 韌體。
**先把 `【】` 裡的內容換成你自己的**（板子、腳位、設備）。

> **機密不要貼進對話。** Wi-Fi 密碼、裝置 ID、註冊碼都不要寫進 prompt。
> prompt 已要求 AI 把它們做成「序列埠指令輸入並存進 NVS」，燒錄後你自己在序列埠監控視窗輸入就好。
> 註冊碼雖然 24 小時內失效、只能用一次，仍建議別貼到雲端對話。

網頁也有這份 prompt：管理頁面右上角「AI Prompt」按鈕、文章頁的「丟給 AI 幫你寫韌體」。版本 A 的正本是 [`public/ai-prompt.txt`](../public/ai-prompt.txt)，`npm test` 會檢查它和下面的版本 A 完全一致，**改其中一份請同步改另一份**。

提醒：AI 產生的程式**沒有人替它編譯過**。請自己編譯、上板測試，編譯錯誤可以直接貼回去請 AI 修。

---

## 版本 A：完整版（貼給一般聊天 AI）

````text
你是資深的 ESP32 韌體工程師。請為 ESP32-C6 寫一份「可以直接編譯」的 Arduino 韌體（單一 .ino），
讓板子連到我的 esp-hub 伺服器。請只輸出完整程式碼與簡短的使用說明，不要省略任何函式。

## 我的環境
- 板子：【ESP32-C6-DevKitC-1，請改成你的型號】
- 開發環境：【Arduino IDE 2.x + arduino-esp32 3.x，請改成你的】
- 可使用的函式庫：PubSubClient、IRremoteESP8266、Preferences、HTTPClient、WiFiClientSecure（不要用 ArduinoJson，欄位自己用字串處理）
- 腳位：IR 發射 GPIO【4】、IR 接收 GPIO【5】、開關按鈕 GPIO【9】（按下接 GND）
- 要控制的設備與 IR 碼：【例如 NEC 0x20DF10EF 當作電源鍵；不確定就先用這個當占位】
- 伺服器：HTTPS 與 MQTT 都在 your-app.fly.dev（HTTPS 埠 443、MQTT over TLS 埠 8883；請換成你自己的網域）

## 絕對不能做的事
- 不可把 Wi-Fi 密碼、裝置 ID、註冊碼、API key 寫死在程式碼裡。
- 這些值全部做成「序列埠指令」（115200 baud）輸入，並存進 NVS（Preferences，命名空間 "hub"）：
  WIFI <ssid> <password>
  ENROLL <device_id> <註冊碼>
  KEY <device_id> <api_key>      （選用：直接存金鑰，略過註冊）
  STATUS   （顯示設定；API key 只顯示前 5 碼，其餘遮蔽）
  WIPE     （清除金鑰與註冊碼）
  HELP
- 不可在 Serial 輸出完整的 API key 或註冊碼。

## 伺服器 API（以下就是全部，請嚴格照做）

所有 HTTP 都是 POST、Content-Type: application/json。

1) 用註冊碼換金鑰（不需要 key）
   POST /api/v1/enroll   body: {"device_id":"<id>","code":"<註冊碼>"}
   成功 201：{"device_id":"...","api_key":"dk_...","key_expires_at":<毫秒時間戳>}
   失敗 401：註冊碼錯誤、過期或已用過。
   → 成功後必須「先把 api_key 寫進 NVS 並讀回確認一致」，才可以刪除 NVS 裡的註冊碼。
   → 註冊碼只能用一次；若 401 就停止重試並印出提示（請使用者到管理頁面重新產生註冊碼）。

2) 之後所有呼叫都帶標頭 X-API-Key: <api_key>

3) 上傳事件
   POST /api/v1/events   body: {"type":"ir_tx","payload":{...},"ts":<毫秒時間戳，選填>}
   成功 201。type 只能是 [a-z0-9_.-]{1,40}。
   請用這些 type：boot、enrolled、key_rotated、ir_tx、ir_rx、power_on、power_off。
   - 每次發射 IR：送 ir_tx（payload 放 protocol、code、bits）。
   - 每次開機/關機：送 power_on 或 power_off。
   - 收到 IR 訊號：送 ir_rx。
   事件要先放進最多 16 筆的記憶體佇列，傳送失敗時下次重試，佇列滿了丟掉最舊的。
   ts 用 NTP 校時後的 epoch 毫秒；時鐘還沒校準就不要帶 ts。

4) 心跳與自動換金鑰
   POST /api/v1/heartbeat   body: {}
   回 200：{"ok":true,"server_time":..,"key_expires_at":..,"should_rotate":true|false}
   - 開機 20 秒後做第一次，之後每 24 小時一次（間隔可用序列埠 SET hb <秒> 調整，最小 10）。
   - 如果 should_rotate 為 true：呼叫
     POST /api/v1/rotate   body: {}
     回 200：{"api_key":"dk_...","key_expires_at":..,"old_key_valid_until":..}
     → 一定要「先寫進 NVS 並讀回確認」成功，才切換成新 key、並讓 MQTT 重連。
     → 寫入失敗就繼續用舊 key（伺服器會再通知一次）。

5) 任何 HTTP 401 的處理
   - 回應內容含 "expired"：金鑰已過期。停止所有重試，Serial 提示使用者向管理者要新註冊碼並用 ENROLL 指令重新註冊。
   - 其他 401（被撤銷或刪除）：30 分鐘後再試一次。

## MQTT（TLS，埠 8883，使用 PubSubClient）
- clientId = device_id；username = device_id；password = api_key
- keepalive 30 秒、buffer 512 bytes
- Last Will：topic devices/<device_id>/status，內容 "offline"，retain=true
- 連上後發布 "online" 到同一個 status topic（retain）
- 每 60 秒以及狀態改變時，發布到 devices/<device_id>/state（retain）：
  {"running":true|false,"rssi":<number>,"uptime_s":<number>}
- 只能發布 devices/<自己的id>/state、event、status 這三個 topic
- 連線被拒（state 4 或 5）時，呼叫一次 heartbeat 來判斷是「過期」還是「被撤銷」，一分鐘最多一次

## 其他需求
- Wi-Fi 斷線自動重連；連上後用 configTime 做 NTP（pool.ntp.org）。
- TLS：先用 setInsecure()，但在程式最上方放一個 `const char* ROOT_CA = nullptr;`，
  非 nullptr 時改用 setCACert(ROOT_CA)，並在註解標明「正式環境請填入根憑證」。
- 按鈕（防彈跳 400ms）切換「運轉中/未運轉」：發射 IR 電源碼、送 ir_tx 與 power_on/power_off、更新 MQTT state。
  註明這只是「假設設備跟著開關」，沒有真的感測設備狀態。
- 非阻塞：不要在 loop() 裡用長時間 delay。
- 程式碼要有清楚註解，並用 Serial 印出每個階段（enroll / heartbeat / rotate / mqtt）的結果。

## 輸出格式
1. 完整 .ino 程式碼（一個程式碼區塊）。
2. 需要安裝的函式庫與板子設定（例如 USB CDC On Boot）。
3. 第一次上板的操作步驟（序列埠要輸入哪些指令）。
4. 你不確定、需要我實測確認的地方（請誠實列出，不要假裝已驗證）。
````

---

## 版本 B：精簡版（只要「用註冊碼換金鑰」這一步）

````text
請用 Arduino（ESP32-C6，arduino-esp32 3.x）寫一個最小可編譯的範例：
開機後若 NVS（Preferences，命名空間 "hub"，鍵 "api_key"）沒有金鑰，就用註冊碼向伺服器換。

- POST https://your-app.fly.dev/api/v1/enroll（請換成你自己的網域），JSON：{"device_id":"<id>","code":"<註冊碼>"}
- 成功回 201：{"api_key":"dk_...","key_expires_at":...}；401 代表註冊碼錯誤、過期或已用過
- 拿到 api_key 後存進 NVS，之後用標頭 X-API-Key 呼叫 POST /api/v1/events，body {"type":"boot"}，成功回 201
- 使用 HTTPClient + WiFiClientSecure（先用 setInsecure()，註解標明正式版要改 setCACert）
- 不要用 ArduinoJson，自己取出 "api_key" 欄位
- Wi-Fi 密碼、裝置 ID、註冊碼請用序列埠指令輸入並存進 NVS，不要寫死在程式碼裡
- 輸出完整程式碼，並誠實說明哪些部分你沒辦法確認
````

---

## 版本 C：給能讀 repo 的 AI 代理（Claude Code、Cursor agent 等）

````text
請 clone https://github.com/louis70109/esp32-fly-deployment ，先讀 docs/README.md 與 docs/PRD.md（照 §0 的步驟），
再讀 firmware/README.md 與 firmware/esp32c6_ir_hub/esp32c6_ir_hub.ino。

目標：讓 firmware/esp32c6_ir_hub/esp32c6_ir_hub.ino 在我的板子【型號】上編譯通過並上板運作。
開工前先問我 PRD §0.4 的五個問題。範例韌體從未編譯過，請先編譯、修錯；
我的 Wi-Fi 與註冊碼我會自己用序列埠輸入，請不要要求我貼給你。
完成後依 docs/README.md 的交接檢查更新 PRD。
````

---

## 使用提醒

- **裝置 ID 與註冊碼**：管理頁面按「新增裝置」取得（註冊碼 24 小時內有效、只能用一次）。
- **本機測試**：把 `your-app.fly.dev` 換成電腦的區網 IP，並要求 AI 加上 `SET host / tls / http_port / mqtt_port` 指令
  （本機是 HTTP 8080、MQTT 1883、不用 TLS）。
- 想要更完整的實作，可以直接使用 [esp32c6_ir_hub.ino](esp32c6_ir_hub/esp32c6_ir_hub.ino)，它已經包含上面版本 A 的全部功能。
