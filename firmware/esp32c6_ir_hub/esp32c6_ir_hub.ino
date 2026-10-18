// esp32c6_ir_hub — ESP32-C6 client for esp-hub.
//
// STATUS: example written without a compiler or a board. It has NOT been compiled or run.
//         Expect to fix small build errors on first compile. See firmware/README.md.
//
// What it does
//   * Credentials live in NVS (Preferences), not in the code: one binary for every board.
//   * First boot: redeems a one-time enrollment code (POST /api/v1/enroll) for an API key.
//   * Daily heartbeat; when the server says should_rotate, swaps the key (POST /api/v1/rotate)
//     and only switches to the new key after it is safely stored in NVS.
//   * Reports presence + running state over MQTT (TLS), with a Last Will for power loss.
//   * Logs IR transmit/receive and power on/off events over HTTP, with a small retry queue.
//   * Serial console (115200) for provisioning: type HELP.
//
// Libraries (Library Manager): PubSubClient, IRremoteESP8266 (newest release).
// Board: ESP32C6 Dev Module, arduino-esp32 3.x. For the USB port of a DevKitC-1 enable
// Tools > USB CDC On Boot so Serial works.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <IRrecv.h>
#include <IRutils.h>
#include <esp_system.h>
#include <time.h>

// ------------------------------------------------------------ build-time defaults
// Everything here can be overridden at runtime from the serial console (stored in NVS).
#define DEFAULT_HOST       "your-app.fly.dev"   // placeholder: set yours with the serial command  SET host <name>.fly.dev
#define DEFAULT_HTTP_PORT  443
#define DEFAULT_MQTT_PORT  8883
#define DEFAULT_TLS        true
#define DEFAULT_HB_SECONDS 86400      // heartbeat (and rotation check) once a day

// TODO(production): paste the PEM root CA that signs the server certificate to verify it.
// While nullptr the connection is encrypted but the server is NOT authenticated.
static const char* ROOT_CA = nullptr;

// ------------------------------------------------------------------ hardware (placeholders)
const uint8_t PIN_IR_TX    = 4;   // IR LED driver
const uint8_t PIN_IR_RX    = 5;   // IR receiver (e.g. VS1838B)
const uint8_t PIN_POWER_SW = 9;   // button to GND (BOOT on many C6 boards): toggles the appliance
const uint64_t IR_POWER_CODE = 0x20DF10EF;   // NEC power code; replace with your appliance's

// ------------------------------------------------------------------------ config in NVS
struct Config {
  String ssid, pass, host, deviceId, apiKey, enrollCode;
  uint16_t httpPort = DEFAULT_HTTP_PORT;
  uint16_t mqttPort = DEFAULT_MQTT_PORT;
  bool tls = DEFAULT_TLS;
  uint32_t hbSeconds = DEFAULT_HB_SECONDS;
};
Config cfg;
Preferences prefs;
const char* NS = "hub";

void loadConfig() {
  prefs.begin(NS, true);
  cfg.ssid       = prefs.getString("ssid", "");
  cfg.pass       = prefs.getString("pass", "");
  cfg.host       = prefs.getString("host", DEFAULT_HOST);
  cfg.deviceId   = prefs.getString("dev_id", "");
  cfg.apiKey     = prefs.getString("api_key", "");
  cfg.enrollCode = prefs.getString("enroll_code", "");
  cfg.httpPort   = prefs.getUShort("http_port", DEFAULT_HTTP_PORT);
  cfg.mqttPort   = prefs.getUShort("mqtt_port", DEFAULT_MQTT_PORT);
  cfg.tls        = prefs.getBool("tls", DEFAULT_TLS);
  cfg.hbSeconds  = prefs.getUInt("hb_s", DEFAULT_HB_SECONDS);
  prefs.end();
}

// Writes a string to NVS and reads it back; true only if the stored value matches.
// (A rotated key must never be used before this returns true.)
bool saveString(const char* key, const String& value) {
  prefs.begin(NS, false);
  if (value.length() == 0) prefs.remove(key); else prefs.putString(key, value);
  prefs.end();
  prefs.begin(NS, true);
  String back = prefs.getString(key, "");
  prefs.end();
  return back == value;
}

// ------------------------------------------------------------------------ globals
IRsend irsend(PIN_IR_TX);
IRrecv irrecv(PIN_IR_RX, 1024, 50, true);
decode_results irResults;

WiFiClientSecure mqttSecure;
WiFiClient mqttPlain;
PubSubClient mqtt;

bool running = false;               // what we believe the appliance is doing (see PRD: no real sensing yet)
bool wifiStarted = false, timeConfigured = false;
bool keyExpired = false;            // server said "api key expired": only a new enroll code fixes it
bool enrollRejected = false;        // enroll code was invalid/expired/used
unsigned long blockedUntil = 0;     // auth failure back-off (millis)
unsigned long lastWifiTry = 0, lastEnrollTry = 0, lastBeat = 0, lastMqttTry = 0, lastStatePub = 0,
              lastButton = 0, lastHint = 0, wifiUpAt = 0, lastMqttDiag = 0;
bool beatStarted = false;
String lineBuf;

// Tiny retry queue so events survive short Wi-Fi/server outages.
struct Pending { String type; String payload; int64_t ts; };
const int QMAX = 16;
Pending queue[QMAX];
int qHead = 0, qCount = 0;

// ------------------------------------------------------------------------ helpers
int64_t nowMs() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (int64_t)t * 1000 : 0;   // 0 = clock not synced; server then uses its own time
}

String topic(const char* leaf) { return String("devices/") + cfg.deviceId + "/" + leaf; }

String maskKey(const String& k) { return k.length() ? k.substring(0, 5) + "..." : String("(none)"); }

// Tiny JSON field readers. The server's keys/values never contain quotes or escapes.
String jsonString(const String& body, const char* key) {
  String pat = String("\"") + key + "\":\"";
  int i = body.indexOf(pat);
  if (i < 0) return "";
  i += pat.length();
  int j = body.indexOf('"', i);
  return j < 0 ? String("") : body.substring(i, j);
}
bool jsonBool(const String& body, const char* key) {
  String pat = String("\"") + key + "\":true";
  return body.indexOf(pat) >= 0;
}

void configureTls(WiFiClientSecure& c) {
  if (ROOT_CA) c.setCACert(ROOT_CA); else c.setInsecure();
}

bool haveUsableKey() {
  return cfg.deviceId.length() && cfg.apiKey.length() && !keyExpired && (long)(blockedUntil - millis()) <= 0;
}

// ------------------------------------------------------------------------ HTTP
// Returns the HTTP status, or -1 on transport error. `response` gets the body.
int httpPostJson(const String& path, const String& body, bool withKey, String& response) {
  response = "";
  if (WiFi.status() != WL_CONNECTED) return -1;
  String url = String(cfg.tls ? "https://" : "http://") + cfg.host + ":" + cfg.httpPort + path;
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;
  http.setTimeout(8000);
  bool began;
  if (cfg.tls) { configureTls(secure); began = http.begin(secure, url); }
  else         { began = http.begin(plain, url); }
  if (!began) return -1;
  http.addHeader("Content-Type", "application/json");
  if (withKey) http.addHeader("X-API-Key", cfg.apiKey);
  int code = http.POST(body);
  if (code > 0) response = http.getString();
  http.end();
  return code;
}

// A 401 means the key is unusable. Expired keys cannot rotate themselves, so stop and wait for
// a new enrollment code; a merely rejected key (revoked/deleted) is retried every 30 minutes.
void handleAuthFailure(const String& response) {
  if (response.indexOf("expired") >= 0) {
    keyExpired = true;
    Serial.println("[auth] API key EXPIRED. Ask the admin for a new enrollment code, then: ENROLL <device_id> <code>");
  } else {
    blockedUntil = millis() + 30UL * 60UL * 1000UL;
    Serial.println("[auth] API key rejected (revoked/deleted?). Retrying in 30 min.");
  }
}

bool postEvent(const Pending& e) {
  String body = String("{\"type\":\"") + e.type + "\",\"payload\":" + e.payload;
  if (e.ts) body += String(",\"ts\":") + String((long long)e.ts);
  body += "}";
  String resp;
  int code = httpPostJson("/api/v1/events", body, true, resp);
  if (code == 401) handleAuthFailure(resp);
  return code == 201;
}

void logEvent(const String& type, const String& payloadJson = "null") {
  Pending e{type, payloadJson, nowMs()};
  if (qCount < QMAX) { queue[(qHead + qCount) % QMAX] = e; qCount++; }
  else { queue[qHead] = e; qHead = (qHead + 1) % QMAX; }   // drop oldest
}

void flushQueue() {
  if (!haveUsableKey()) return;
  while (qCount > 0) {
    if (!postEvent(queue[qHead])) return;                   // retry on a later loop
    qHead = (qHead + 1) % QMAX; qCount--;
  }
}

// ------------------------------------------------------- enrollment, heartbeat, rotation
bool doEnroll() {
  String body = String("{\"device_id\":\"") + cfg.deviceId + "\",\"code\":\"" + cfg.enrollCode + "\"}";
  String resp;
  int code = httpPostJson("/api/v1/enroll", body, false, resp);
  if (code == 201) {
    String key = jsonString(resp, "api_key");
    if (key.length() && saveString("api_key", key)) {
      cfg.apiKey = key;
      cfg.enrollCode = "";
      saveString("enroll_code", "");           // only after the key is safely stored
      keyExpired = false; enrollRejected = false; blockedUntil = 0;
      if (mqtt.connected()) mqtt.disconnect(); // reconnect with the new key
      Serial.println("[enroll] OK, key stored in NVS.");
      logEvent("enrolled");
      return true;
    }
    Serial.println("[enroll] got a key but could not store it; will retry (code stays valid until used).");
    return false;
  }
  if (code == 401) {
    enrollRejected = true;
    Serial.println("[enroll] code invalid, expired or already used. Get a new one from the dashboard.");
  } else {
    Serial.printf("[enroll] failed (http %d), will retry.\n", code);
  }
  return false;
}

bool doRotate() {
  String resp;
  int code = httpPostJson("/api/v1/rotate", "{}", true, resp);
  if (code == 401) { handleAuthFailure(resp); return false; }
  if (code != 200) { Serial.printf("[rotate] failed (http %d)\n", code); return false; }
  String key = jsonString(resp, "api_key");
  // Store first, switch second. If this fails we keep the old key; the server still honours it
  // during the grace window and will ask us to rotate again.
  if (key.length() && saveString("api_key", key)) {
    cfg.apiKey = key;
    if (mqtt.connected()) mqtt.disconnect();
    Serial.println("[rotate] new key stored in NVS and in use.");
    logEvent("key_rotated");
    return true;
  }
  Serial.println("[rotate] could not store the new key; keeping the old one.");
  return false;
}

void doHeartbeat() {
  String resp;
  int code = httpPostJson("/api/v1/heartbeat", "{}", true, resp);
  if (code == 401) { handleAuthFailure(resp); return; }
  if (code != 200) { Serial.printf("[heartbeat] failed (http %d)\n", code); return; }
  lastBeat = millis();
  beatStarted = true;
  if (jsonBool(resp, "should_rotate")) doRotate();
}

void maintainAuth() {
  if (cfg.deviceId.length() == 0) return;
  if (cfg.enrollCode.length() && !enrollRejected && millis() - lastEnrollTry > 30000UL) {
    lastEnrollTry = millis();
    doEnroll();
    return;
  }
  if (!haveUsableKey()) return;
  bool due = beatStarted ? (millis() - lastBeat >= cfg.hbSeconds * 1000UL)
                         : (millis() - wifiUpAt > 20000UL);   // first one shortly after boot
  if (due) { lastBeat = millis(); beatStarted = true; doHeartbeat(); }
}

// ------------------------------------------------------------------------ MQTT
void publishState() {
  if (!mqtt.connected()) return;
  String s = String("{\"running\":") + (running ? "true" : "false") +
             ",\"rssi\":" + WiFi.RSSI() + ",\"uptime_s\":" + (millis() / 1000) + "}";
  mqtt.publish(topic("state").c_str(), s.c_str(), true);
}

void connectMqtt() {
  if (mqtt.connected() || !haveUsableKey()) return;
  if (millis() - lastMqttTry < 5000UL) return;
  lastMqttTry = millis();
  Client& net = cfg.tls ? static_cast<Client&>(mqttSecure) : static_cast<Client&>(mqttPlain);
  if (cfg.tls) configureTls(mqttSecure);
  mqtt.setClient(net);
  mqtt.setServer(cfg.host.c_str(), cfg.mqttPort);
  mqtt.setKeepAlive(30);
  mqtt.setBufferSize(512);
  String will = topic("status");
  // user = device id, password = API key; the broker rejects any other combination.
  if (mqtt.connect(cfg.deviceId.c_str(), cfg.deviceId.c_str(), cfg.apiKey.c_str(), will.c_str(), 0, true, "offline")) {
    mqtt.publish(will.c_str(), "online", true);
    publishState();
    return;
  }
  // 4 = bad credentials, 5 = unauthorized. Ask the HTTP API why (expired vs revoked), rate-limited.
  int st = mqtt.state();
  if ((st == 4 || st == 5) && millis() - lastMqttDiag > 60000UL) {
    lastMqttDiag = millis();
    doHeartbeat();
  }
}

// ------------------------------------------------------------------------ appliance + IR
void setRunning(bool on) {
  running = on;
  irsend.sendNEC(IR_POWER_CODE, 32);
  logEvent("ir_tx", String("{\"protocol\":\"NEC\",\"code\":\"0x") + String((uint32_t)IR_POWER_CODE, HEX) + "\",\"bits\":32}");
  logEvent(on ? "power_on" : "power_off");   // the hub also marks the device running / idle from these
  publishState();
}

void handleButton() {
  if (digitalRead(PIN_POWER_SW) == LOW && millis() - lastButton > 400UL) {
    lastButton = millis();
    setRunning(!running);
  }
}

void handleIrRx() {
  if (irrecv.decode(&irResults)) {
    logEvent("ir_rx", String("{\"protocol\":\"") + typeToString(irResults.decode_type) +
             "\",\"code\":\"0x" + uint64ToString(irResults.value, 16) + "\",\"bits\":" + irResults.bits + "}");
    irrecv.resume();
  }
}

// ------------------------------------------------------------------------ Wi-Fi
void ensureWifi() {
  if (cfg.ssid.length() == 0) return;
  if (WiFi.status() == WL_CONNECTED) {
    if (!timeConfigured) {
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      timeConfigured = true;
      wifiUpAt = millis();
      Serial.print("[wifi] connected, ip ");
      Serial.println(WiFi.localIP());
    }
    return;
  }
  timeConfigured = false;
  if (!wifiStarted || millis() - lastWifiTry > 15000UL) {
    lastWifiTry = millis();
    wifiStarted = true;
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  }
}

// ------------------------------------------------------------------------ serial console
void printStatus() {
  Serial.println("---- status ----");
  Serial.printf("wifi      : %s (%s)\n", cfg.ssid.length() ? cfg.ssid.c_str() : "(not set)",
                WiFi.status() == WL_CONNECTED ? "connected" : "not connected");
  Serial.printf("hub       : %s  http %u  mqtt %u  tls %d\n", cfg.host.c_str(), cfg.httpPort, cfg.mqttPort, cfg.tls);
  Serial.printf("device id : %s\n", cfg.deviceId.length() ? cfg.deviceId.c_str() : "(not set)");
  Serial.printf("api key   : %s%s\n", maskKey(cfg.apiKey).c_str(), keyExpired ? "  [EXPIRED]" : "");
  Serial.printf("enroll    : %s%s\n", cfg.enrollCode.length() ? "code pending" : "none", enrollRejected ? " [rejected]" : "");
  Serial.printf("mqtt      : %s\n", mqtt.connected() ? "connected" : "disconnected");
  Serial.printf("heartbeat : every %u s\n", cfg.hbSeconds);
  Serial.printf("queued    : %d events\n", qCount);
}

void printHelp() {
  Serial.println("Commands:");
  Serial.println("  WIFI <ssid> <password>       set Wi-Fi (ssid without spaces; password may contain spaces)");
  Serial.println("  ENROLL <device_id> <code>    redeem a one-time enrollment code from the dashboard");
  Serial.println("  KEY <device_id> <api_key>    store an API key directly (skips enrollment)");
  Serial.println("  SET <host|http_port|mqtt_port|tls|hb> <value>   e.g. SET tls 0 for a local test server");
  Serial.println("  STATUS | WIPE (forget key + code) | REBOOT | HELP");
}

void processLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String rest = sp < 0 ? String("") : line.substring(sp + 1);
  rest.trim();
  cmd.toUpperCase();
  String a = rest, b = "";
  int sp2 = rest.indexOf(' ');
  if (sp2 >= 0) { a = rest.substring(0, sp2); b = rest.substring(sp2 + 1); b.trim(); }

  if (cmd == "HELP") { printHelp(); }
  else if (cmd == "STATUS") { printStatus(); }
  else if (cmd == "REBOOT") { Serial.println("rebooting..."); delay(200); ESP.restart(); }
  else if (cmd == "WIFI" && a.length()) {
    cfg.ssid = a; cfg.pass = b;
    saveString("ssid", a); saveString("pass", b);
    wifiStarted = false; WiFi.disconnect();
    Serial.println("wifi saved.");
  }
  else if (cmd == "ENROLL" && a.length() && b.length()) {
    cfg.deviceId = a; cfg.enrollCode = b;
    saveString("dev_id", a);
    bool ok = saveString("enroll_code", b);
    keyExpired = false; enrollRejected = false; lastEnrollTry = 0;
    Serial.println(ok ? "enroll code saved; will redeem as soon as Wi-Fi is up." : "ERROR: could not save enroll code");
  }
  else if (cmd == "KEY" && a.length() && b.length()) {
    cfg.deviceId = a; cfg.apiKey = b; cfg.enrollCode = "";
    saveString("dev_id", a); saveString("enroll_code", "");
    bool ok = saveString("api_key", b);
    keyExpired = false; blockedUntil = 0;
    if (mqtt.connected()) mqtt.disconnect();
    Serial.println(ok ? "key saved." : "ERROR: could not save key");
  }
  else if (cmd == "SET" && a.length() && b.length()) {
    a.toLowerCase();
    prefs.begin(NS, false);
    if (a == "host")           { cfg.host = b; prefs.putString("host", b); }
    else if (a == "http_port") { cfg.httpPort = (uint16_t)b.toInt(); prefs.putUShort("http_port", cfg.httpPort); }
    else if (a == "mqtt_port") { cfg.mqttPort = (uint16_t)b.toInt(); prefs.putUShort("mqtt_port", cfg.mqttPort); }
    else if (a == "tls")       { cfg.tls = (b == "1" || b == "true"); prefs.putBool("tls", cfg.tls); }
    else if (a == "hb")        { cfg.hbSeconds = (uint32_t)b.toInt(); if (cfg.hbSeconds < 10) cfg.hbSeconds = 10; prefs.putUInt("hb_s", cfg.hbSeconds); }
    else { Serial.println("unknown setting"); }
    prefs.end();
    if (mqtt.connected()) mqtt.disconnect();
    Serial.println("saved.");
  }
  else if (cmd == "WIPE") {
    cfg.apiKey = ""; cfg.enrollCode = "";
    saveString("api_key", ""); saveString("enroll_code", "");
    keyExpired = false; enrollRejected = false;
    if (mqtt.connected()) mqtt.disconnect();
    Serial.println("key and enroll code erased.");
  }
  else { Serial.println("unknown or incomplete command. Type HELP."); }
}

void handleSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') { processLine(lineBuf); lineBuf = ""; }
    else if (lineBuf.length() < 200) lineBuf += c;
  }
}

// ------------------------------------------------------------------------ setup / loop
void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_POWER_SW, INPUT_PULLUP);
  irsend.begin();
  irrecv.enableIRIn();
  loadConfig();

  Serial.println("\nesp-hub client. Type HELP for provisioning commands.");
  printStatus();
  logEvent("boot", String("{\"reset_reason\":") + (int)esp_reset_reason() + "}");
}

void loop() {
  handleSerial();
  ensureWifi();

  if (cfg.ssid.length() == 0 || cfg.deviceId.length() == 0 ||
      (cfg.apiKey.length() == 0 && cfg.enrollCode.length() == 0)) {
    if (millis() - lastHint > 15000UL) {
      lastHint = millis();
      Serial.println("[setup] not provisioned. Use WIFI <ssid> <pass> and ENROLL <device_id> <code>. Type HELP.");
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    maintainAuth();
    connectMqtt();
    mqtt.loop();
    flushQueue();
  }

  handleButton();
  handleIrRx();

  if (millis() - lastStatePub > 60000UL) { lastStatePub = millis(); publishState(); }
}
