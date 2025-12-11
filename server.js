// ================= LOGIN + TOKEN DESTEKLİ SERVER ==================

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =============================================================
// LOGIN + MAKS 3 OTURUM + TOKEN SÜRESİ + CİHAZ TAKİBİ
// =============================================================

const VALID_USER = "smartsocket";
const VALID_PASS = "panelpassword81";

// activeTokens → Artık device info saklıyor
let activeTokens = [];  
// { token, createdAt, lastSeen, ip, userAgent, deviceName }

const TOKEN_LIFETIME = 60 * 60 * 1000; // 1 saat

let failCount = 0;
let blockedUntil = 0;

// Cihaz ismini user-agent'tan üret
function parseDeviceName(ua) {
  if (!ua) return "Bilinmeyen cihaz";

  if (ua.includes("Windows")) return "Windows PC";
  if (ua.includes("Mac OS")) return "Mac";
  if (ua.includes("Android")) return "Android Telefon";
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";

  return "Bilinmeyen cihaz";
}

// Süresi dolan tokenları sil
function cleanupExpiredTokens() {
  const now = Date.now();
  activeTokens = activeTokens.filter(t => now - t.createdAt < TOKEN_LIFETIME);
}

// Maksimum 3 oturum → En eskiyi sil
function pruneTokenLimit() {
  if (activeTokens.length > 3) {
    activeTokens.sort((a, b) => a.createdAt - b.createdAt);
    activeTokens.shift();
  }
}

// ---------- LOGIN ----------
app.post("/api/login", (req, res) => {
  const now = Date.now();

  // Blok kontrolü
  if (now < blockedUntil) {
    return res.status(403).json({
      error: "blocked",
      remain: Math.ceil((blockedUntil - now) / 1000)
    });
  }

  const { username, password } = req.body;

  if (username === VALID_USER && password === VALID_PASS) {
    failCount = 0;

    const token = crypto.randomBytes(24).toString("hex");

    const userAgent = req.headers["user-agent"] || "Bilinmeyen";
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    activeTokens.push({
      token,
      createdAt: now,
      lastSeen: now,
      ip,
      userAgent,
      deviceName: parseDeviceName(userAgent)
    });

    cleanupExpiredTokens();
    pruneTokenLimit();

    return res.json({ ok: true, token });
  }

  // Hatalı login
  failCount++;

  if (failCount >= 3) {
    blockedUntil = Date.now() + 30000;
    failCount = 0;
    return res.status(403).json({ error: "blocked30" });
  }

  return res.status(401).json({ error: "wrong" });
});

// ---------- TOKEN DOĞRULAMA ----------
app.get("/api/check-token", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const found = activeTokens.find(t => t.token === token);

  if (found) return res.json({ ok: true });
  return res.json({ ok: false });
});

// ---------- TOKEN SÜRE BİLGİSİ ----------
app.get("/api/session-info", (req, res) => {
  const token = req.headers["authorization"];
  cleanupExpiredTokens();

  const tk = activeTokens.find(t => t.token === token);
  if (!tk) return res.json({ ok: false });

  const now = Date.now();
  const remain = TOKEN_LIFETIME - (now - tk.createdAt);

  return res.json({
    ok: true,
    remainMs: remain
  });
});

// ---------- OTURUM PING (her 15 sn front-end gönderir) ----------
app.post("/api/ping", (req, res) => {
  const token = req.headers["authorization"];
  const now = Date.now();

  const tk = activeTokens.find(t => t.token === token);
  if (tk) tk.lastSeen = now;

  return res.json({ ok: true });
});

// ---------- ÇIKIŞ ----------
app.post("/api/logout", (req, res) => {
  const token = req.headers["authorization"];
  activeTokens = activeTokens.filter(t => t.token !== token);
  return res.json({ ok: true });
});

// ---------- YENİ: TÜM AKTİF OTURUMLARI GÖNDER ----------
app.get("/api/sessions", (req, res) => {
  cleanupExpiredTokens();

  const list = activeTokens.map(t => ({
    deviceName: t.deviceName,
    ip: t.ip,
    userAgent: t.userAgent,
    createdAt: t.createdAt,
    lastSeen: t.lastSeen
  }));

  return res.json({ ok: true, sessions: list });
});

// =============================================================
// SENSOR DATA & WEBSOCKET
// =============================================================

let lastData = {};
let lastTimestamp = 0;

app.post("/api/data", (req, res) => {
  const payload = req.body || {};
  lastData = payload;
  lastTimestamp = Date.now();

  const msg = JSON.stringify({
    type: "update",
    data: lastData,
    ts: lastTimestamp
  });

  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });

  return res.status(200).json({ status: "ok" });
});

app.get("/api/last", (req, res) =>
  res.json({ data: lastData, ts: lastTimestamp })
);

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "init",
    data: lastData,
    ts: lastTimestamp
  }));
});

// Offline bildirimi
setInterval(() => {
  if (Date.now() - lastTimestamp > 10000) {
    const msg = JSON.stringify({
      type: "offline",
      data: null,
      ts: lastTimestamp
    });

    wss.clients.forEach(c => {
      if (c.readyState === 1) c.send(msg);
    });
  }
}, 3000);

// =============================================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
