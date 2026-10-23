#!/usr/bin/env node
// Claude Remote relay — Railway'de çalışır. Laptoptaki ajan buraya WebSocket ile bağlanır,
// tarayıcı istekleri o bağlantı üzerinden laptoptaki panele iletilir. Laptopta port açılmaz.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const WEB_TOKEN = process.env.WEB_TOKEN;       // tarayıcının girişte kullandığı token
const AGENT_SECRET = process.env.AGENT_SECRET; // laptop ajanının kimliği
if (!WEB_TOKEN || WEB_TOKEN.length < 20 || !AGENT_SECRET || AGENT_SECRET.length < 20) {
  console.error('WEB_TOKEN ve AGENT_SECRET (en az 20 karakter) gerekli');
  process.exit(1);
}

function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Yanlış token denemesi: IP başına 15 dakikada 10
const fails = new Map();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function blocked(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.since > 15 * 60e3) { fails.delete(ip); return false; }
  return f.n >= 10;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.since > 15 * 60e3) fails.set(ip, { n: 1, since: Date.now() });
  else f.n++;
}

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

// --- ajan bağlantısı ---
let agent = null;
const pending = new Map();

function forward(msg) {
  return new Promise((resolve, reject) => {
    if (!agent) return reject(new Error('offline'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 30e3);
    pending.set(id, { resolve, reject, timer });
    agent.send(JSON.stringify({ id, ...msg }));
  });
}

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font:16px system-ui;background:#0d1117;color:#c9d1d9;padding:24px">
<h3>Laptop çevrimdışı</h3><p>Bilgisayar kapalı ya da internete bağlı değil. Açılınca bu sayfa kendiliğinden çalışır.</p>
<script>setTimeout(()=>location.reload(),10000)</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  if (url.pathname === '/healthz') return send(res, 200, agent ? 'agent: on' : 'agent: off');
  if (blocked(ip)) return send(res, 429, 'Çok fazla deneme');

  let setCookie = null;
  if (url.pathname !== '/icon.png') {
    if (url.searchParams.has('token')) {
      if (!safeEq(url.searchParams.get('token'), WEB_TOKEN)) { noteFail(ip); return send(res, 401, 'Yetkisiz'); }
      // Token adreste kalır (iOS ana ekran uygulaması Safari cookie'lerini görmez)
      setCookie = `cr_web=${WEB_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
      url.searchParams.delete('token');
    } else {
      const m = (req.headers.cookie || '').match(/(?:^|;\s*)cr_web=([^;]+)/);
      if (!m || !safeEq(m[1], WEB_TOKEN)) {
        if (m) noteFail(ip);
        return send(res, 401, 'Yetkisiz. Adresi token ile aç: /?token=...');
      }
    }
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) return send(res, 413, 'büyük'); chunks.push(c); }

  try {
    const r = await forward({
      method: req.method, path: url.pathname + url.search,
      xcr: req.headers['x-cr'] || null, ctype: req.headers['content-type'] || null,
      body: chunks.length ? Buffer.concat(chunks).toString('base64') : null,
    });
    const extra = { 'X-Content-Type-Options': 'nosniff' };
    if (r.cache) extra['Cache-Control'] = r.cache;
    if (setCookie) extra['Set-Cookie'] = setCookie;
    res.writeHead(r.status, { 'Content-Type': r.ctype || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra });
    res.end(Buffer.from(r.body || '', 'base64'));
  } catch (e) {
    if (e.message === 'offline') {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return send(res, 503, OFFLINE, 'text/html; charset=utf-8');
      return send(res, 503, JSON.stringify({ error: 'Laptop çevrimdışı' }), 'application/json; charset=utf-8');
    }
    send(res, 504, JSON.stringify({ error: 'Laptop yanıt vermedi' }), 'application/json; charset=utf-8');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 });
server.on('upgrade', (req, socket, head) => {
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (new URL(req.url, 'http://x').pathname !== '/_agent' || !safeEq(auth, AGENT_SECRET)) {
    noteFail(clientIp(req));
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    if (agent) agent.terminate();
    agent = ws;
    ws.alive = true;
    console.log('ajan bağlandı');
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
    });
    ws.on('close', () => {
      if (agent === ws) { agent = null; console.log('ajan ayrıldı'); }
    });
  });
});

// Ölü bağlantıları temizle
setInterval(() => {
  if (!agent) return;
  if (!agent.alive) { agent.terminate(); return; }
  agent.alive = false;
  agent.ping();
}, 25e3);

server.listen(PORT, '::', () => console.log(`relay :${PORT}`));
