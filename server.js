// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // HTML burada olmalı: /public/index.html

let lastData = {};
let lastTimestamp = 0;

// ESP'den gelen POST verisi
app.post("/api/data", (req, res) => {
  const payload = req.body || {};
  lastData = payload;
  lastTimestamp = Date.now();

  // Tüm WebSocket istemcilerine gönder
  const msg = JSON.stringify({ type: "update", data: lastData, ts: lastTimestamp });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });

  return res.status(200).json({ status: "ok" });
});

// İstemcilerin son veriyi çekmesi
app.get("/api/last", (req, res) => res.json({ data: lastData, ts: lastTimestamp }));

// Yeni WebSocket bağlantısı
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", data: lastData, ts: lastTimestamp }));
});

// 10 saniyeden uzun süredir veri gelmezse offline bildirimi
setInterval(() => {
  if (Date.now() - lastTimestamp > 10000) {
    const msg = JSON.stringify({ type: "offline", data: null, ts: lastTimestamp });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  }
}, 3000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
