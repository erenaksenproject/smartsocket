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
// LOGIN SİSTEMİ + MAKS 3 OTURUM + TOKEN SÜRESİ + CİHAZ BİLGİLERİ
// =============================================================

const VALID_USER = "smartsocket";
const VALID_PASS = "panelpassword81";

// activeTokens: her giriş için bir kayıt
// { token, createdAt, userAgent, ip }
let activeTokens = [];

// 1 saatlik token süresi
const TOKEN_LIFETIME = 60 * 60 * 1000;

// Hatalı giriş blok sistemi
let failCount = 0;
let blockedUntil = 0;

// Süresi dolan token’ları temizle
function cleanupExpiredTokens() {
  const now = Date.now();
  activeTokens = activeTokens.filter(
    (t) => now - t.createdAt < TOKEN_LIFETIME
  );
}

// En fazla 3 aktif oturum kalsın (en eskileri sil)
function pruneTokenLimit() {
  if (activeTokens.length <= 3) return;
  activeTokens.sort((a, b) => a.createdAt - b.createdAt);
  while (activeTokens.length > 3) {
    activeTokens.shift();
  }
}

// POST /api/login
app.post("/api/login", (req, res) => {
  const now = Date.now();

  // Blok kontrolü
  if (now < blockedUntil) {
    return res.status(403).json({
      error: "blocked",
      remain: Math.ceil((blockedUntil - now) / 1000),
    });
  }

  const { username, password } = req.body;

  if (username === VALID_USER && password === VALID_PASS) {
    failCount = 0;

    const token = crypto.randomBytes(24).toString("hex");

    const ipHeader = req.headers["x-forwarded-for"];
    const ip =
      (ipHeader && ipHeader.split(",")[0].trim()) ||
      req.socket.remoteAddress ||
      "unknown";

    const userAgent = req.headers["user-agent"] || "unknown";

    activeTokens.push({
      token,
      createdAt: now,
      userAgent,
      ip,
    });

    cleanupExpiredTokens();
    pruneTokenLimit();

    return res.json({ ok: true, token });
  }

  // Hatalı şifre
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
  const found = activeTokens.find((t) => t.token === token);

  if (found) {
    return res.json({ ok: true });
  }
  return res.json({ ok: false });
});

// GET /api/session-info  → kalan süre (ms)
app.get("/api/session-info", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const tk = activeTokens.find((t) => t.token === token);

  if (!tk) {
    return res.json({ ok: false });
  }

  const now = Date.now();
  const remainMs = TOKEN_LIFETIME - (now - tk.createdAt);

  return res.json({
    ok: true,
    remainMs,
  });
});

// POST /api/extend-session → “Devam Et” tıklayınca süreyi yenile
app.post("/api/extend-session", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const tk = activeTokens.find((t) => t.token === token);

  if (!tk) {
    return res.json({ ok: false });
  }

  tk.createdAt = Date.now();
  return res.json({ ok: true });
});

// GET /api/active-sessions → bağlı bütün cihazlar
app.get("/api/active-sessions", (req, res) => {
  cleanupExpiredTokens();

  const callerToken = req.headers["authorization"];
  const caller = activeTokens.find((t) => t.token === callerToken);
  if (!caller) {
    return res.status(401).json({ ok: false });
  }

  const now = Date.now();
  const sessions = activeTokens.map((t) => ({
    token: t.token,
    ip: t.ip,
    userAgent: t.userAgent,
    createdAt: t.createdAt,
    remainMs: TOKEN_LIFETIME - (now - t.createdAt),
  }));

  return res.json({ ok: true, sessions });
});

// POST /api/logout → sadece kendi oturumunu kapat
app.post("/api/logout", (req, res) => {
  const token = req.headers["authorization"];
  activeTokens = activeTokens.filter((t) => t.token !== token);
  return res.json({ ok: true });
});

// POST /api/logout-token → panelden seçilen herhangi bir token’ı düşür
app.post("/api/logout-token", (req, res) => {
  cleanupExpiredTokens();

  const callerToken = req.headers["authorization"];
  const caller = activeTokens.find((t) => t.token === callerToken);
  if (!caller) {
    return res.status(401).json({ ok: false });
  }

  const tokenToDrop = req.body?.token;
  if (!tokenToDrop) {
    return res.status(400).json({ ok: false });
  }

  activeTokens = activeTokens.filter((t) => t.token !== tokenToDrop);
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
    ts: lastTimestamp,
  });

  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });

  return res.status(200).json({ status: "ok" });
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

// 10 saniye veri gelmezse offline bildir
setInterval(() => {
  if (Date.now() - lastTimestamp > 10000) {
    const msg = JSON.stringify({
      type: "offline",
      data: null,
      ts: lastTimestamp,
    });

    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(msg);
    });
  }
}, 3000);

// =============================================================

const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
