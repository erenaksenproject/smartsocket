// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // HTML burada olacak

// =====================================================
//  AYAR SİSTEMİ (Kalıcı settings.json)
// =====================================================
const SETTINGS_FILE = path.join(__dirname, "settings.json");

// Varsayılan ayarlar (dosya yoksa otomatik oluşur)
const defaultSettings = {
  theme: "dark",
  unitMode: "A_W", // A/W ya da mA/mW
  monitorNames: [
    "DC Soket Çıkışı 1",
    "DC Soket Çıkışı 2",
    "USB-A Portu 1",
    "USB-A Portu 2"
  ],
  updateDelayWarn: true
};

// Ayar dosyasını yükle veya oluştur
function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
      return defaultSettings;
    }

    const data = fs.readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(data);

  } catch (err) {
    console.error("Ayar yüklenemedi, varsayılanlar kullanıldı:", err);
    return defaultSettings;
  }
}

// Ayarları dosyaya kaydet
function saveSettings(newSettings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
}

let settings = loadSettings();

// Settings GET
app.get("/api/settings/get", (req, res) => {
  return res.json(settings);
});

// Settings SET
app.post("/api/settings/set", (req, res) => {
  const payload = req.body;
  settings = { ...settings, ...payload }; // Gelen değerleri üzerine yaz
  saveSettings(settings);

  // Tüm WebSocket istemcilere ayar güncelleme yayını
  const msg = JSON.stringify({ type: "settings", settings });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });

  return res.json({ status: "saved", settings });
});

// =====================================================
//  CANLI VERİ SİSTEMİ
// =====================================================
let lastData = {};
let lastTimestamp = 0;

// ESP8266 → POST JSON
app.post("/api/data", (req, res) => {
  const payload = req.body || {};
  lastData = payload;
  lastTimestamp = Date.now();

  // WebSocket üzerinden frontend'e gönder
  const msg = JSON.stringify({
    type: "update",
    data: lastData,
    ts: lastTimestamp
  });

  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });

  return res.status(200).json({ status: "ok" });
});

// Son veri isteyen istemciler için
app.get("/api/last", (req, res) => {
  return res.json({ data: lastData, ts: lastTimestamp });
});

// WebSocket bağlantısı
wss.on("connection", (ws) => {
  // İlk bağlanana hem veri hem ayarlar gönderiyoruz
  ws.send(JSON.stringify({
    type: "init",
    data: lastData,
    ts: lastTimestamp,
    settings
  }));
});

// 10 saniyeden uzun süre veri gelmezse offline bildir
setInterval(() => {
  if (Date.now() - lastTimestamp > 10000) {
    const msg = JSON.stringify({
      type: "offline",
      ts: lastTimestamp
    });

    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  }
}, 3000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
