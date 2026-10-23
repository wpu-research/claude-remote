#!/usr/bin/env node
// Claude Remote — tmux oturumlarını telefondan izle/yönet. Bağımlılık yok.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const CONF_DIR = path.join(HOME, '.config', 'claude-remote');
const PORT = Number(process.env.PORT || 7681);
// cloudflared 127.0.0.1'e bağlanır; Tailscale varsa onu da dinle
const HOSTS = (process.env.HOST || [detectTailscaleIp(), '127.0.0.1'].filter(Boolean).join(',')).split(',');
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS ||
  ['Desktop/Urunler', 'Downloads/Projects', 'Desktop'].map(p => path.join(HOME, p)).join(':'))
  .split(':').filter(Boolean);

fs.mkdirSync(CONF_DIR, { recursive: true });
const TOKEN_FILE = path.join(CONF_DIR, 'token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

function detectTailscaleIp() {
  try {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      if (!name.startsWith('tailscale')) continue;
      const v4 = addrs.find(a => a.family === 'IPv4');
      if (v4) return v4.address;
    }
  } catch {}
  return null;
}

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('tmux kurulu değil: sudo apt install -y tmux'));
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

const TARGET_RE = /^[\w.\-:%@$]+$/;
function checkTarget(t) {
  if (typeof t !== 'string' || !TARGET_RE.test(t)) throw new Error('geçersiz hedef');
  return t;
}

async function listPanes() {
  const fmt = ['#{session_name}', '#{window_index}', '#{pane_index}', '#{pane_id}', '#{window_name}',
    '#{pane_current_command}', '#{pane_current_path}', '#{session_activity}', '#{session_attached}',
    '#{pane_active}', '#{window_active}'].join('\t');
  let out;
  try { out = await tmux(['list-panes', '-a', '-F', fmt]); }
  catch (e) { if (/no server running|error connecting/.test(e.message)) return []; throw e; }
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [session, win, pane, id, wname, cmd, cwd, activity, attached, paneActive, winActive] = line.split('\t');
    return { session, win: +win, pane: +pane, id, wname, cmd, cwd: cwd.replace(HOME, '~'),
      activity: +activity, attached: +attached > 0, active: paneActive === '1' && winActive === '1' };
  });
}

function listProjects() {
  const seen = new Set(), out = [];
  for (const root of PROJECT_ROOTS) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      if (seen.has(full)) continue;
      const marker = ['.git', 'CLAUDE.md', 'package.json', '_vault'].some(m => fs.existsSync(path.join(full, m)));
      if (!marker) continue;
      seen.add(full);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      out.push({ name: e.name, path: full, short: full.replace(HOME, '~'), mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const KEYS = new Set(['Enter', 'Escape', 'C-c', 'C-d', 'C-l', 'C-r', 'C-o', 'Tab', 'BTab', 'Up', 'Down',
  'Left', 'Right', 'BSpace', 'PPage', 'NPage', 'y', 'n', '1', '2', '3']);

// --- Claude oturum kayıtları (~/.claude/projects/*/<id>.jsonl) ---
const CLAUDE_DIR = path.join(HOME, '.claude');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readChunk(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Dosyanın sonundan `bytes` kadarını satır satır parse et (yarım ilk satır atılır)
function tailEntries(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const lines = readChunk(file, start, size - start).split('\n');
  if (start > 0) lines.shift();
  return parseLines(lines);
}
function headEntries(file, size, bytes) {
  const lines = readChunk(file, 0, Math.min(size, bytes)).split('\n');
  if (size > bytes) lines.pop();
  return parseLines(lines);
}
function parseLines(lines) {
  const out = [];
  for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

// Kullanıcının gerçekten yazdığı metin (sistem eklentileri, araç sonuçları hariç)
function humanText(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return null;
  const c = e.message && e.message.content;
  let t = typeof c === 'string' ? c
    : Array.isArray(c) && !c.some(x => x.type === 'tool_result') ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
  t = t.trim();
  if (!t || t.startsWith('<')) return null;
  return t;
}

const metaCache = new Map();
function sessionMeta(file, st) {
  const key = file + ':' + st.mtimeMs + ':' + st.size;
  const hit = metaCache.get(file);
  if (hit && hit.key === key) return hit.meta;
  const head = headEntries(file, st.size, 256 << 10);
  const tail = st.size > 256 << 10 ? tailEntries(file, st.size, 512 << 10) : head;
  const all = head.concat(tail);
  const cwd = (all.find(e => e.cwd) || {}).cwd || null;
  const titles = all.filter(e => e.type === 'ai-title');
  const firstPrompt = head.map(humanText).find(Boolean) || '';
  const lastPrompt = tail.map(humanText).filter(Boolean).pop() || firstPrompt;
  const meta = {
    id: path.basename(file, '.jsonl'), cwd,
    title: titles.length ? titles[titles.length - 1].aiTitle : firstPrompt.slice(0, 80) || '(boş oturum)',
    lastPrompt: lastPrompt.slice(0, 140), mtime: st.mtimeMs, size: st.size,
  };
  metaCache.set(file, { key, meta });
  return meta;
}

function sessionFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(CLAUDE_DIR, 'projects')); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(CLAUDE_DIR, 'projects', d);
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith('.jsonl') || !UUID_RE.test(f.slice(0, -6))) continue;
      const file = path.join(dir, f);
      try { out.push({ file, st: fs.statSync(file) }); } catch {}
    }
  }
  return out;
}
function findSessionFile(id) {
  if (!UUID_RE.test(id)) throw new Error('geçersiz oturum');
  const hit = sessionFiles().find(x => x.file.endsWith('/' + id + '.jsonl'));
  if (!hit) throw new Error('oturum bulunamadı');
  return hit;
}

// Şu an çalışan claude süreçleri: ~/.claude/sessions/<pid>.json
function liveClaude() {
  const map = new Map();
  let ents = [];
  try { ents = fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')); } catch { return map; }
  for (const f of ents) {
    if (!/^\d+\.json$/.test(f)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', f), 'utf8')); } catch { continue; }
    try {
      if (!fs.readFileSync(`/proc/${s.pid}/cmdline`, 'utf8').includes('claude')) continue;
    } catch { continue; }
    let tty = null;
    try { tty = fs.readlinkSync(`/proc/${s.pid}/fd/0`); } catch {}
    map.set(s.sessionId, { pid: s.pid, status: s.status, tty });
  }
  return map;
}
async function paneByTty() {
  const map = new Map();
  try {
    const out = await tmux(['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}']);
    for (const l of out.trim().split('\n')) { const [tty, t] = l.split('\t'); if (tty) map.set(tty, t); }
  } catch {}
  return map;
}

async function listClaude() {
  const live = liveClaude(), panes = await paneByTty();
  return sessionFiles()
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 300)
    .map(({ file, st }) => {
      const m = sessionMeta(file, st), l = live.get(m.id);
      return { ...m, cwd: m.cwd && m.cwd.replace(HOME, '~'), project: m.cwd ? path.basename(m.cwd) : '?',
        live: !!l, status: l ? l.status : null, tmux: l && l.tty ? panes.get(l.tty) || null : null };
    })
    .filter(m => m.live || m.size > 2000);
}

function toolInfo(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.description || input.command || input.file_path || input.pattern || input.url ||
    input.query || input.prompt || input.skill || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 120);
}

function chatItems(entries) {
  const items = [];
  for (const e of entries) {
    if (e.isSidechain) continue;
    const ht = humanText(e);
    if (ht) { items.push({ k: 'u', t: ht, ts: e.timestamp }); continue; }
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text.trim()) {
        const last = items[items.length - 1];
        if (last && last.k === 'a') last.t += '\n\n' + b.text.trim();
        else items.push({ k: 'a', t: b.text.trim(), ts: e.timestamp });
      } else if (b.type === 'tool_use') {
        items.push({ k: 't', n: b.name.replace(/^mcp__/, ''), t: toolInfo(b.input) });
      }
    }
  }
  return items;
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// cmd: yalnız izinli komutlar; prompt verilirse claude'a ilk mesaj olarak geçer
const CMDS = new Set(['', 'claude', 'claude --continue', 'claude --resume']);
async function startSession(b) {
  const cwd = path.resolve(String(b.cwd || HOME).replace(/^~/, HOME));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('klasör yok: ' + cwd);
  let cmd = String(b.cmd || '');
  if (!CMDS.has(cmd)) throw new Error('izinsiz komut');
  if (cmd === 'claude --resume') {
    if (!UUID_RE.test(b.resumeId || '')) throw new Error('geçersiz oturum');
    cmd += ' ' + b.resumeId;
  }
  let name = String(b.name || path.basename(cwd)).replace(/[^\w\-]/g, '-').slice(0, 40) || 'oturum';
  const existing = new Set((await listPanes()).map(p => p.session));
  for (let i = 2; existing.has(name); i++) name = name.replace(/-\d+$/, '') + '-' + i;
  const args = ['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '40'];
  if (cmd) {
    const prompt = String(b.prompt || '').trim();
    // claude bitince shell açık kalsın, oturum kaybolmasın
    args.push(`${cmd}${prompt ? ' ' + shq(prompt) : ''}; exec $SHELL -l`);
  }
  await tmux(args);
  return { ok: true, session: name };
}

const api = {
  'GET /api/panes': async () => listPanes(),
  'GET /api/projects': async () => listProjects(),
  // Canlı kartlar: tüm pane'ler + görünen ekranın sonu + varsa Claude oturum bilgisi, tek istekte
  'GET /api/live': async () => {
    const fmt = ['#{session_name}:#{window_index}.#{pane_index}', '#{pane_tty}', '#{pane_current_command}',
      '#{pane_current_path}', '#{session_activity}', '#{session_attached}', '#{session_created}'].join('\t');
    let out;
    try { out = await tmux(['list-panes', '-a', '-F', fmt]); }
    catch (e) { if (/no server running|error connecting/.test(e.message)) return []; throw e; }
    const live = liveClaude(), byTty = new Map();
    for (const [id, l] of live) if (l.tty) byTty.set(l.tty, { id, ...l });
    const panes = out.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
    return Promise.all(panes.map(async ([t, tty, cmd, cwd, activity, attached, created]) => {
      let text = '';
      try { text = (await tmux(['capture-pane', '-p', '-e', '-J', '-t', t])).replace(/\s+$/, ''); } catch {}
      const c = byTty.get(tty);
      let claude = null;
      if (c) {
        try { const { file, st } = findSessionFile(c.id); const m = sessionMeta(file, st); claude = { id: c.id, status: c.status, title: m.title }; }
        catch { claude = { id: c.id, status: c.status, title: '' }; }
      }
      return { t, cmd, cwd: cwd.replace(HOME, '~'), project: path.basename(cwd), activity: +activity,
        attached: +attached > 0, created: +created, claude, text: text.split('\n').slice(-60).join('\n') };
    }));
  },
  'GET /api/capture': async (q) => {
    const t = checkTarget(q.get('t'));
    const lines = Math.min(Number(q.get('lines') || 300), 3000);
    const text = await tmux(['capture-pane', '-p', '-e', '-J', '-t', t, '-S', String(-lines)]);
    return { text: text.replace(/\n+$/, '') };
  },
  'POST /api/send': async (_, b) => {
    const t = checkTarget(b.t);
    if (b.text) await tmux(['send-keys', '-t', t, '-l', String(b.text)]);
    if (b.enter) await tmux(['send-keys', '-t', t, 'Enter']);
    return { ok: true };
  },
  'POST /api/key': async (_, b) => {
    if (!KEYS.has(b.key)) throw new Error('izinsiz tuş');
    await tmux(['send-keys', '-t', checkTarget(b.t), b.key]);
    return { ok: true };
  },
  'POST /api/new': async (_, b) => startSession(b),
  'GET /api/claude': async () => listClaude(),
  'GET /api/chat': async (q) => {
    const { file, st } = findSessionFile(q.get('id'));
    const rev = st.mtimeMs + ':' + st.size;
    const l = liveClaude().get(q.get('id'));
    const tmuxT = l && l.tty ? (await paneByTty()).get(l.tty) || null : null;
    const state = { rev, live: !!l, status: l ? l.status : null, tmux: tmuxT };
    if (q.get('rev') === rev) return { same: true, ...state };
    const m = sessionMeta(file, st);
    const items = chatItems(tailEntries(file, st.size, 3 << 20)).slice(-150);
    return { ...state, title: m.title, cwd: m.cwd && m.cwd.replace(HOME, '~'), items };
  },
  'POST /api/resume': async (_, b) => {
    const { file, st } = findSessionFile(b.id);
    const m = sessionMeta(file, st);
    const l = liveClaude().get(b.id);
    if (l) {
      const t = l.tty && (await paneByTty()).get(l.tty);
      if (t) return { ok: true, target: t };
      if (!b.takeover) throw new Error('Bu oturum laptopta açık');
      // laptoptaki kopyayı kapat, sonra tmux'ta kaldığı yerden aç
      process.kill(l.pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        try { process.kill(l.pid, 0); } catch { break; }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    const r = await startSession({ cwd: m.cwd, cmd: 'claude --resume', resumeId: m.id, prompt: b.prompt });
    return { ok: true, target: r.session + ':0.0' };
  },
  'GET /api/roots': async () => PROJECT_ROOTS.map(r => ({ path: r, short: r.replace(HOME, '~') })),
  'POST /api/project': async (_, b) => {
    const name = String(b.name || '').trim();
    if (!/^[\w.\-]{1,60}$/.test(name) || name.startsWith('.')) throw new Error('proje adı: harf, rakam, - _ .');
    if (!PROJECT_ROOTS.includes(b.root)) throw new Error('geçersiz kök klasör');
    const dir = path.join(b.root, name);
    if (fs.existsSync(dir)) throw new Error('bu isimde klasör zaten var');
    fs.mkdirSync(dir, { recursive: true });
    await new Promise(r => execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir }, () => r()));
    return startSession({ cwd: dir, cmd: 'claude', prompt: b.prompt });
  },
  'POST /api/kill': async (_, b) => {
    await tmux(['kill-session', '-t', checkTarget(b.t)]);
    return { ok: true };
  },
};

function tokenOk(t) {
  const a = Buffer.from(String(t || '')), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)cr_token=([^;]+)/);
  return !!m && tokenOk(m[1]);
}

// Yanlış token denemesi: IP başına 15 dakikada 10
const fails = new Map();
function clientIp(req) { return req.headers['cf-connecting-ip'] || req.socket.remoteAddress; }
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

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const INDEX = path.join(__dirname, 'public', 'index.html');
const ICON = path.join(__dirname, 'public', 'icon.png');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  if (blocked(ip)) return send(res, 429, 'Çok fazla deneme', 'text/plain; charset=utf-8');
  // Ana ekran ikonu: iOS onu cookie'siz ister, gizli bir şey yok
  if (url.pathname === '/icon.png') return send(res, 200, fs.readFileSync(ICON), 'image/png', { 'Cache-Control': 'max-age=86400' });
  if (url.searchParams.has('token')) {
    if (!tokenOk(url.searchParams.get('token'))) { noteFail(ip); return send(res, 401, 'Yetkisiz', 'text/plain; charset=utf-8'); }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    // Yönlendirme yok: token adreste kalsın ki "Ana Ekrana Ekle" onu kaydetsin
    // (iOS'ta ana ekran uygulamasının cookie'leri Safari'den ayrı)
    return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8', {
      'Set-Cookie': `cr_token=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
    });
  }
  if (!authed(req)) {
    if (req.headers.cookie && /cr_token=/.test(req.headers.cookie)) noteFail(ip);
    return send(res, 401, 'Yetkisiz. Adresi token ile aç: /?token=...', 'text/plain; charset=utf-8');
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
  }
  const handler = api[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'yok' });
  if (req.method === 'POST' && req.headers['x-cr'] !== '1') return send(res, 403, { error: 'csrf' });

  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) return send(res, 413, { error: 'büyük' }); }
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'json' }); }
  }
  try { send(res, 200, await handler(url.searchParams, body)); }
  catch (e) { send(res, 400, { error: e.message }); }
});
for (const h of HOSTS) {
  http.createServer(server.listeners('request')[0]).listen(PORT, h, () => {
    console.log(`Claude Remote: http://${h}:${PORT}/?token=${TOKEN}`);
  });
}
