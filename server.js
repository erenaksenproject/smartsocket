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
// LOGIN SİSTEMİ + MAKS 3 OTURUM + TOKEN SÜRESİ
// =============================================================

const VALID_USER = "smartsocket";
const VALID_PASS = "panelpassword81";

let activeTokens = [];  // { token, createdAt }

// 1 saatlik token süresi
const TOKEN_LIFETIME = 60 * 60 * 1000;

// Hatalı giriş blok sistemi
let failCount = 0;
let blockedUntil = 0;

// Token temizleme (süresi dolanlar)
function cleanupExpiredTokens() {
  const now = Date.now();
  activeTokens = activeTokens.filter(t => now - t.createdAt < TOKEN_LIFETIME);
}

// En eski token’ı sil (maks 3 oturum için)
function pruneTokenLimit() {
  if (activeTokens.length > 3) {
    activeTokens.sort((a, b) => a.createdAt - b.createdAt); // en eski üstte
    activeTokens.shift(); // en eski token silinir
  }
}

// POST /api/login
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

    // yeni token oluştur
    const token = crypto.randomBytes(24).toString("hex");

    activeTokens.push({ token, createdAt: now });

    cleanupExpiredTokens();
    pruneTokenLimit();

    return res.json({ ok: true, token });
  }

  failCount++;

  if (failCount >= 3) {
    blockedUntil = Date.now() + 30000;
    failCount = 0;
    return res.status(403).json({ error: "blocked30" });
  }

  return res.status(401).json({ error: "wrong" });
});

// GET /api/check-token
app.get("/api/check-token", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const found = activeTokens.find(t => t.token === token);

  if (found) {
    return res.json({ ok: true });
  }

  return res.json({ ok: false });
});

// Yeni → Oturum kalan süre bilgisi
app.get("/api/session-info", (req, res) => {
  const token = req.headers["authorization"];
  cleanupExpiredTokens();

  const tk = activeTokens.find(t => t.token === token);

  if (!tk) {
    return res.json({ ok: false });
  }

  const now = Date.now();
  const remain = TOKEN_LIFETIME - (now - tk.createdAt);

  return res.json({
    ok: true,
    remainMs: remain
  });
});

// POST /api/logout
app.post("/api/logout", (req, res) => {
  const token = req.headers["authorization"];
  activeTokens = activeTokens.filter(t => t.token !== token);
  return res.json({ ok: true });
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

// 10 saniye veri gelmezse offline
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
