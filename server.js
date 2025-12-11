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
// LOGIN SİSTEMİ
// =============================================================

const VALID_USER = "smartsocket";
const VALID_PASS = "panelpassword81";

let activeTokens = new Set();
let failCount = 0;
let blockedUntil = 0;

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
    const token = crypto.randomBytes(24).toString("hex");
    activeTokens.add(token);

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
  const token = req.headers["authorization"];

  if (activeTokens.has(token)) {
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false });
});

// POST /api/logout
app.post("/api/logout", (req, res) => {
  const token = req.headers["authorization"];
  activeTokens.delete(token);
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

  const msg = JSON.stringify({ type: "update", data: lastData, ts: lastTimestamp });

  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });

  return res.status(200).json({ status: "ok" });
});

app.get("/api/last", (req, res) =>
  res.json({ data: lastData, ts: lastTimestamp })
);

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", data: lastData, ts: lastTimestamp }));
});

setInterval(() => {
  if (Date.now() - lastTimestamp > 10000) {
    const msg = JSON.stringify({ type: "offline", data: null, ts: lastTimestamp });
    wss.clients.forEach(c => {
      if (c.readyState === 1) c.send(msg);
    });
  }
}, 3000);

// =============================================================

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
