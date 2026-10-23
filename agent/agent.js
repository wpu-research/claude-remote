#!/usr/bin/env node
// Claude Remote ajanı — laptopta çalışır, Railway relay'e dışarıya doğru bağlanır ve
// gelen istekleri yerel panele (127.0.0.1:7681) iletir. Ayarlar ~/.config/claude-remote/relay.json
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const CONF_DIR = path.join(os.homedir(), '.config', 'claude-remote');
const conf = JSON.parse(fs.readFileSync(process.env.RELAY_CONF || path.join(CONF_DIR, 'relay.json'), 'utf8'));
const LOCAL_TOKEN = fs.readFileSync(path.join(CONF_DIR, 'token'), 'utf8').trim();
const LOCAL_PORT = Number(process.env.PORT || 7681);

function local(m) {
  return new Promise(resolve => {
    const body = m.body ? Buffer.from(m.body, 'base64') : null;
    const headers = { Cookie: `cr_token=${LOCAL_TOKEN}`, 'X-Forwarded-Proto': 'https' };
    if (m.xcr) headers['X-CR'] = m.xcr;
    if (m.ctype) headers['Content-Type'] = m.ctype;
    if (body) headers['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port: LOCAL_PORT, method: m.method, path: m.path, headers, timeout: 25e3 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ctype: res.headers['content-type'],
        cache: res.headers['cache-control'], body: Buffer.concat(chunks).toString('base64') }));
    });
    req.on('error', e => resolve({ status: 502, ctype: 'application/json', body: Buffer.from(JSON.stringify({ error: 'panel: ' + e.message })).toString('base64') }));
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
    if (body) req.write(body);
    req.end();
  });
}

let delay = 1000;
function connect() {
  const ws = new WebSocket(conf.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/_agent', {
    headers: { Authorization: `Bearer ${conf.agentSecret}` },
  });
  let alive;
  ws.on('open', () => {
    console.log('relay bağlandı:', conf.url);
    delay = 1000;
    alive = setInterval(() => ws.ping(), 20e3);
  });
  ws.on('message', async data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    // Yalnız panelin kendi yolları; relay ele geçirilse bile başka yere istek atılmaz
    if (typeof m.path !== 'string' || !m.path.startsWith('/') || !['GET', 'POST'].includes(m.method)) return;
    const r = await local(m);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: m.id, ...r }));
  });
  ws.on('close', () => {
    clearInterval(alive);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30e3);
  });
  ws.on('error', e => console.error('relay hatası:', e.message));
}
connect();
