// ================= LOGIN + TOKEN + YETKİLİ CİHAZ DESTEKLİ SERVER ==================

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =============================================================
// YETKİLİ CİHAZ ("TRUSTED DEVICE") DOSYASI
// =============================================================
const trustedFile = path.join(__dirname, "trustedDevice.json");

// Eğer yoksa oluştur
if (!fs.existsSync(trustedFile)) {
  fs.writeFileSync(trustedFile, JSON.stringify({ deviceHash: null }, null, 2));
}

function loadTrusted() {
  return JSON.parse(fs.readFileSync(trustedFile, "utf8"));
}

function saveTrusted(hash) {
  fs.writeFileSync(trustedFile, JSON.stringify({ deviceHash: hash }, null, 2));
}

// =============================================================
// LOGIN SİSTEMİ
// =============================================================

const VALID_USER = "smartsocket";
const VALID_PASS = "panelpassword81";

let activeTokens = [];
// { token, createdAt, userAgent, ip, isTrusted }

const TOKEN_LIFETIME = 60 * 60 * 1000; // 1 saat
const DEVICE_LIMIT = 5;

// Hatalı giriş blok sistemi
let failCount = 0;
let blockedUntil = 0;

// Token temizle (süresi dolmuş olanlar)
function cleanupExpiredTokens() {
  const now = Date.now();
  activeTokens = activeTokens.filter((t) => {
    if (t.isTrusted) return true; // YETKİLİ cihaz süresiz
    return now - t.createdAt < TOKEN_LIFETIME;
  });
}

// Limit kontrolü — sadece normal cihazlara uygulanır
function pruneTokenLimit() {
  const normalTokens = activeTokens.filter((t) => !t.isTrusted);

  if (normalTokens.length > DEVICE_LIMIT) {
    const sorted = normalTokens.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sorted[0].token;
    activeTokens = activeTokens.filter((t) => t.token !== toRemove);
  }
}

// Cihaz hash hesaplama (SADECE User-Agent => IP DEĞİŞSE DE AYNI CİHAZ)
function getDeviceHash(req) {
  const ua = req.headers["user-agent"] || "unknown";

  return crypto
    .createHash("sha256")
    .update(ua)
    .digest("hex");
}

// =============================================================
// POST /api/login
// =============================================================
app.post("/api/login", (req, res) => {
  const now = Date.now();

  if (now < blockedUntil) {
    return res.status(403).json({
      error: "blocked",
      remain: Math.ceil((blockedUntil - now) / 1000),
    });
  }

  const { username, password } = req.body;

  if (username !== VALID_USER || password !== VALID_PASS) {
    failCount++;
    if (failCount >= 3) {
      blockedUntil = Date.now() + 30000;
      failCount = 0;
      return res.status(403).json({ error: "blocked30" });
    }
    return res.status(401).json({ error: "wrong" });
  }

  // ŞİFRE DOĞRU → devam
  failCount = 0;

  const deviceHash = getDeviceHash(req);
  const trusted = loadTrusted();

  let isTrusted = false;

  if (!trusted.deviceHash) {
    // İlk kez giriş → Bu cihaz YETKİLİ olur
    saveTrusted(deviceHash);
    isTrusted = true;
    console.log(">>> Bu cihaz YETKİLİ olarak kaydedildi.");
  } else if (trusted.deviceHash === deviceHash) {
    // Zaten yetkili cihaz
    isTrusted = true;
  }

  // Token oluştur
  const token = crypto.randomBytes(24).toString("hex");

  const ipHeader = req.headers["x-forwarded-for"];
  const ip =
    (ipHeader && ipHeader.split(",")[0].trim()) ||
    req.socket.remoteAddress ||
    "unknown";

  activeTokens.push({
    token,
    createdAt: now,
    userAgent: req.headers["user-agent"] || "unknown",
    ip,
    isTrusted,
  });

  cleanupExpiredTokens();
  pruneTokenLimit();

  return res.json({ ok: true, token, isTrusted });
});

// =============================================================
// TOKEN KONTROL
// =============================================================
app.get("/api/check-token", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const found = activeTokens.find((t) => t.token === token);

  if (found) return res.json({ ok: true, isTrusted: found.isTrusted });
  return res.json({ ok: false });
});

// =============================================================
// OTURUM BİLGİSİ
// =============================================================
app.get("/api/session-info", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const tk = activeTokens.find((t) => t.token === token);

  if (!tk) return res.json({ ok: false });

  if (tk.isTrusted) {
    return res.json({
      ok: true,
      remainMs: Infinity,
      isTrusted: true,
    });
  }

  const now = Date.now();
  const remainMs = TOKEN_LIFETIME - (now - tk.createdAt);

  return res.json({
    ok: true,
    remainMs,
    isTrusted: false,
  });
});

// =============================================================
// OTURUM SÜRESİ UZATMA → SADECE NORMAL CİHAZ
// =============================================================
app.post("/api/extend-session", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const tk = activeTokens.find((t) => t.token === token);

  if (!tk) return res.json({ ok: false });
  if (tk.isTrusted) return res.json({ ok: false }); // YETKİLİ cihazın süresi uzamaz, zaten sınırsız

  tk.createdAt = Date.now();
  return res.json({ ok: true });
});

// =============================================================
// AKTİF OTURUMLAR
// =============================================================
app.get("/api/active-sessions", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const caller = activeTokens.find((t) => t.token === token);
  if (!caller) return res.status(401).json({ ok: false });

  const now = Date.now();

  const sessions = activeTokens.map((t) => ({
    token: t.token,
    ip: t.ip,
    userAgent: t.userAgent,
    isTrusted: t.isTrusted,
    createdAt: t.createdAt,
    remainMs: t.isTrusted ? Infinity : TOKEN_LIFETIME - (now - t.createdAt),
  }));

  return res.json({ ok: true, sessions });
});

// =============================================================
// OTURUM SONLANDIRMA
// =============================================================
app.post("/api/logout", (req, res) => {
  const token = req.headers["authorization"];
  activeTokens = activeTokens.filter((t) => t.token !== token);
  return res.json({ ok: true });
});

app.post("/api/logout-token", (req, res) => {
  cleanupExpiredTokens();

  const callerToken = req.headers["authorization"];
  const caller = activeTokens.find((t) => t.token === callerToken);
  if (!caller) return res.status(401).json({ ok: false });

  const target = activeTokens.find((t) => t.token === req.body.token);

  if (target?.isTrusted) {
    return res.json({ ok: false, msg: "Yetkili cihaz kapatılamaz!" });
  }

  activeTokens = activeTokens.filter((t) => t.token !== req.body.token);
  return res.json({ ok: true });
});

// =============================================================
// SENSOR DATA + WEBSOCKET
// =============================================================

let lastData = {};
let lastTimestamp = 0;

app.post("/api/data", (req, res) => {
  lastData = req.body || {};
  lastTimestamp = Date.now();

  const msg = JSON.stringify({
    type: "update",
    data: lastData,
    ts: lastTimestamp,
  });

  wss.clients.forEach((c) => c.readyState === 1 && c.send(msg));
  res.json({ status: "ok" });
});

app.get("/api/last", (req, res) =>
  res.json({ data: lastData, ts: lastTimestamp })
);

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      data: lastData,
      ts: lastTimestamp,
    })
  );
});

// Offline kontrolü
setInterval(() => {
  if (Date.now() - lastTimestamp > 10000) {
    const msg = JSON.stringify({ type: "offline", data: null });
    wss.clients.forEach((c) => c.readyState === 1 && c.send(msg));
  }
}, 3000);

// =============================================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
