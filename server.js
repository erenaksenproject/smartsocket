// ================= LOGIN + TOKEN DESTEKLİ SERVER ==================

import express from "express";                   // Web sunucusu oluşturmak için Express
import http from "http";                         // HTTP sunucusu için Node modülü
import { WebSocketServer } from "ws";            // Canlı veri iletişimi için WebSocket
import cors from "cors";                         // Tarayıcıdan gelen isteklere izin verir
import path from "path";                         // Dosya yolu işlemleri için
import { fileURLToPath } from "url";             // ES module için __dirname oluşturmak
import crypto from "crypto";                     // Güvenli token üretmek için

const __filename = fileURLToPath(import.meta.url);    // Dosya yolunu alır
const __dirname = path.dirname(__filename);           // Bulunduğu klasörün yolu

const app = express();                         // Express uygulaması oluştur
const server = http.createServer(app);         // Express ile çalışan HTTP sunucusu
const wss = new WebSocketServer({ server });   // HTTP sunucusu üzerinde WebSocket aç

app.use(cors());                               // CORS aktif (tarayıcı izinleri)
app.use(express.json());                       // JSON gövdesini okumak için
app.use(express.static(path.join(__dirname, "public"))); // /public klasörünü webden erişilebilir yap

// =============================================================
// LOGIN SİSTEMİ + MAKS 3 OTURUM + TOKEN SÜRESİ + CİHAZ BİLGİLERİ
// =============================================================

const VALID_USER = "smartsocket";               // Geçerli kullanıcı adı
const VALID_PASS = "panelpassword81";           // Geçerli şifre

// activeTokens: her giriş için bir kayıt tutar
// { token, createdAt, userAgent, ip }
let activeTokens = [];                          // Aktif oturum listesi

const TOKEN_LIFETIME = 60 * 60 * 1000;          // Token 1 saat geçerli

// Hatalı giriş kontrol sistemi
let failCount = 0;                              // Üst üste hatalı giriş sayısı
let blockedUntil = 0;                           // Bloke süresi dolana kadar giriş kapalı

// Süresi dolan token’ları temizle
function cleanupExpiredTokens() {
  const now = Date.now();
  activeTokens = activeTokens.filter(
    (t) => now - t.createdAt < TOKEN_LIFETIME   // Süresi geçenleri listeden çıkar
  );
}

// En fazla 3 aktif oturum olsun, fazlaları düşür
function pruneTokenLimit() {
  if (activeTokens.length <= 3) return;
  activeTokens.sort((a, b) => a.createdAt - b.createdAt); // En eski başa
  while (activeTokens.length > 3) {
    activeTokens.shift();                                  // En eski oturumu sil
  }
}

// POST /api/login → giriş işlemi
app.post("/api/login", (req, res) => {
  const now = Date.now();

  // Blok kontrolü (çok fazla yanlış giriş)
  if (now < blockedUntil) {
    return res.status(403).json({
      error: "blocked",
      remain: Math.ceil((blockedUntil - now) / 1000),  // Kaç saniye kaldığını döner
    });
  }

  const { username, password } = req.body;     // Gönderilen kullanıcı bilgileri

  if (username === VALID_USER && password === VALID_PASS) {
    failCount = 0;                              // Başarılı giriş → hata sayısını sıfırla

    const token = crypto.randomBytes(24).toString("hex"); // Güvenli token üret

    // IP adresi al
    const ipHeader = req.headers["x-forwarded-for"];
    const ip =
      (ipHeader && ipHeader.split(",")[0].trim()) ||
      req.socket.remoteAddress ||
      "unknown";

    const userAgent = req.headers["user-agent"] || "unknown"; // Cihaz bilgisi

    activeTokens.push({
      token,
      createdAt: now,
      userAgent,
      ip,
    });

    cleanupExpiredTokens();   // Süresi dolan token'ları temizle
    pruneTokenLimit();        // En fazla 3 oturum olsun

    return res.json({ ok: true, token }); // Giriş başarılı → token döner
  }

  // Hatalı giriş
  failCount++;
  if (failCount >= 3) {
    blockedUntil = Date.now() + 30000; // 3 yanlış → 30 sn engelle
    failCount = 0;
    return res.status(403).json({ error: "blocked30" });
  }

  return res.status(401).json({ error: "wrong" }); // Yanlış şifre
});

// GET /api/check-token → token geçerli mi?
app.get("/api/check-token", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];     // Header’dan token al
  const found = activeTokens.find((t) => t.token === token);

  if (found) {
    return res.json({ ok: true });                // Token geçerli
  }
  return res.json({ ok: false });                 // Geçersiz token
});

// GET /api/session-info → kalan süreyi döner
app.get("/api/session-info", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const tk = activeTokens.find((t) => t.token === token);

  if (!tk) {
    return res.json({ ok: false });
  }

  const now = Date.now();
  const remainMs = TOKEN_LIFETIME - (now - tk.createdAt); // Kalan süre hesapla

  return res.json({
    ok: true,
    remainMs,
  });
});

// POST /api/extend-session → oturumu uzat
app.post("/api/extend-session", (req, res) => {
  cleanupExpiredTokens();

  const token = req.headers["authorization"];
  const tk = activeTokens.find((t) => t.token === token);

  if (!tk) return res.json({ ok: false });

  tk.createdAt = Date.now();    // Süreyi yenile
  return res.json({ ok: true });
});

// GET /api/active-sessions → bağlı tüm cihazları getir
app.get("/api/active-sessions", (req, res) => {
  cleanupExpiredTokens();

  const callerToken = req.headers["authorization"];
  const caller = activeTokens.find((t) => t.token === callerToken);

  if (!caller) return res.status(401).json({ ok: false }); // Yetkisiz istek

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

// POST /api/logout → sadece kendi oturumunu kapatır
app.post("/api/logout", (req, res) => {
  const token = req.headers["authorization"];
  activeTokens = activeTokens.filter((t) => t.token !== token); // Token'i listeden çıkar
  return res.json({ ok: true });
});

// POST /api/logout-token → panelden seçilen oturumu kapat
app.post("/api/logout-token", (req, res) => {
  cleanupExpiredTokens();

  const callerToken = req.headers["authorization"];
  const caller = activeTokens.find((t) => t.token === callerToken);

  if (!caller) {
    return res.status(401).json({ ok: false });
  }

  const tokenToDrop = req.body?.token;
  if (!tokenToDrop) return res.status(400).json({ ok: false });

  activeTokens = activeTokens.filter((t) => t.token !== tokenToDrop); // Oturumu düşür
  return res.json({ ok: true });
});

// =============================================================
// SENSOR DATA & WEBSOCKET
// =============================================================

let lastData = {};              // Son gelen sensör verisi
let lastTimestamp = 0;          // Son veri zamanı

// POST /api/data → ESP8266 buraya veri gönderir
app.post("/api/data", (req, res) => {
  const payload = req.body || {}; // Gönderilen JSON
  lastData = payload;
  lastTimestamp = Date.now();

  const msg = JSON.stringify({
    type: "update",
    data: lastData,
    ts: lastTimestamp,
  });

  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg); // Tüm bağlı web istemcilerine gönder
  });

  return res.status(200).json({ status: "ok" });
});

// Son veriyi isteyen endpoint
app.get("/api/last", (req, res) =>
  res.json({ data: lastData, ts: lastTimestamp })
);

// WebSocket bağlantısı kurulunca ilk veriyi gönder
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      data: lastData,
      ts: lastTimestamp,
    })
  );
});

// 10 saniye veri gelmezse "offline" bildir
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
}, 3000); // 3 saniyede bir kontrol

// =============================================================

const PORT = process.env.PORT || 10000;     // Port ayarı (Render vb. için)
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`) // Sunucu çalıştı mesajı
);
