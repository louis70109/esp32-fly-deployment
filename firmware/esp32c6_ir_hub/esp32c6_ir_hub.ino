// ESP32-C6 IR hub client: logs IR / power events to the hub over HTTP (API key)
// and reports presence + running state over MQTT (TLS).
//
// Libraries (Library Manager): PubSubClient, IRremoteESP8266 (use the newest release;
// ESP32-C6 support landed late, if it fails to compile update the library first).
// Board: "ESP32C6 Dev Module" (arduino-esp32 3.x).

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <IRrecv.h>
#include <IRutils.h>
#include <time.h>

// ----------------------------------------------------------- configuration
const char* WIFI_SSID  = "YOUR_WIFI";
const char* WIFI_PASS  = "YOUR_WIFI_PASSWORD";

const char* HUB_HOST   = "esp-hub-louis.fly.dev";   // your Fly app hostname
const char* DEVICE_ID  = "esp-living";                   // shown when you create the device
const char* API_KEY    = "dk_PASTE_KEY_HERE";            // shown once when you create the device

const uint16_t MQTT_PORT = 8883;
const uint16_t KEEPALIVE_S = 30;                         // offline detected ~45 s after power loss

const uint8_t PIN_IR_TX   = 4;    // IR LED driver
const uint8_t PIN_IR_RX   = 5;    // IR receiver (e.g. VS1838B)
const uint8_t PIN_POWER_SW = 9;   // button to GND: toggles the controlled device on/off (BOOT button on many boards)

// Example code sent when "power" toggles. Replace with the codes of your own appliance.
const uint64_t IR_POWER_CODE = 0x20DF10EF;                // NEC

// ------------------------------------------------------------------ state
IRsend irsend(PIN_IR_TX);
IRrecv irrecv(PIN_IR_RX, 1024, 50, true);
decode_results irResults;

WiFiClientSecure mqttNet;
PubSubClient mqtt(mqttNet);

bool running = false;
unsigned long lastMqttTry = 0, lastBeat = 0, lastButton = 0;

// Tiny retry queue so events survive short Wi-Fi/server outages.
struct Pending { String type; String payload; int64_t ts; };
const int QMAX = 16;
Pending queue[QMAX];
int qHead = 0, qCount = 0;

// -------------------------------------------------------------- utilities
int64_t nowMs() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (int64_t)t * 1000 : 0;          // 0 = clock not synced, server uses its own time
}

String topic(const char* leaf) { return String("devices/") + DEVICE_ID + "/" + leaf; }

bool postEvent(const Pending& e) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure tls;
  tls.setInsecure();   // TODO production: tls.setCACert(<root CA>) to authenticate the server
  HTTPClient http;
  http.setTimeout(5000);
  if (!http.begin(tls, String("https://") + HUB_HOST + "/api/v1/events")) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  String body = String("{\"type\":\"") + e.type + "\",\"payload\":" + e.payload;
  if (e.ts) body += String(",\"ts\":") + String((long long)e.ts);
  body += "}";
  int code = http.POST(body);
  http.end();
  return code == 201;
}

void logEvent(const String& type, const String& payloadJson = "null") {
  Pending e{type, payloadJson, nowMs()};
  if (qCount < QMAX) { queue[(qHead + qCount) % QMAX] = e; qCount++; }
  else { queue[qHead] = e; qHead = (qHead + 1) % QMAX; }   // drop oldest
}

void flushQueue() {
  while (qCount > 0) {
    if (!postEvent(queue[qHead])) return;                  // retry next loop
    qHead = (qHead + 1) % QMAX; qCount--;
  }
}

void publishState() {
  if (!mqtt.connected()) return;
  String s = String("{\"running\":") + (running ? "true" : "false") +
             ",\"rssi\":" + WiFi.RSSI() + ",\"uptime_s\":" + (millis() / 1000) + "}";
  mqtt.publish(topic("state").c_str(), s.c_str(), true);
}

// --------------------------------------------------------------- actions
void setRunning(bool on) {
  running = on;
  irsend.sendNEC(IR_POWER_CODE, 32);
  logEvent("ir_tx", String("{\"protocol\":\"NEC\",\"code\":\"0x") + String((uint32_t)IR_POWER_CODE, HEX) + "\",\"bits\":32}");
  logEvent(on ? "power_on" : "power_off");   // the hub also marks the device running/idle from these
  publishState();
}

// ------------------------------------------------------------- connectivity
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(300);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
}

void connectMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastMqttTry < 5000) return;
  lastMqttTry = millis();
  // Username = device id, password = API key. Last-will marks us gone if power is cut.
  String will = topic("status");
  if (mqtt.connect(DEVICE_ID, DEVICE_ID, API_KEY, will.c_str(), 0, true, "offline")) {
    mqtt.publish(will.c_str(), "online", true);
    publishState();
  }
}

// -------------------------------------------------------------------- main
void setup() {
  Serial.begin(115200);
  pinMode(PIN_POWER_SW, INPUT_PULLUP);
  irsend.begin();
  irrecv.enableIRIn();

  connectWifi();
  mqttNet.setInsecure();                                   // TODO production: mqttNet.setCACert(<root CA>)
  mqtt.setServer(HUB_HOST, MQTT_PORT);
  mqtt.setKeepAlive(KEEPALIVE_S);
  mqtt.setBufferSize(512);

  logEvent("boot", String("{\"reset_reason\":") + (int)esp_reset_reason() + "}");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  connectMqtt();
  mqtt.loop();

  // Power button (debounced): toggles the appliance via IR and logs it.
  if (digitalRead(PIN_POWER_SW) == LOW && millis() - lastButton > 400) {
    lastButton = millis();
    setRunning(!running);
  }

  // Log any IR code seen by the receiver (e.g. the appliance's own remote).
  if (irrecv.decode(&irResults)) {
    logEvent("ir_rx", String("{\"protocol\":\"") + typeToString(irResults.decode_type) +
             "\",\"code\":\"0x" + uint64ToString(irResults.value, 16) + "\",\"bits\":" + irResults.bits + "}");
    irrecv.resume();
  }

  // Refresh state periodically so the dashboard keeps current RSSI/uptime.
  if (millis() - lastBeat > 60000) { lastBeat = millis(); publishState(); }

  flushQueue();
}
