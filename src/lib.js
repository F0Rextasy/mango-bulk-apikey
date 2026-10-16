'use strict';

/**
 * Shared plumbing for the Mango Inference mint:
 *  - proxy pool (live list) + proxied HTTP with a cookie jar
 *  - temp-mailbox brokers (mailtrap / inboxes.com)
 *  - Chrome + CDP page driver with network capture
 *
 * Egress: every request that touches mangoboost goes through a pool proxy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const proxyLib = require('./proxy');
const { CDP } = require('./cdp');

const HERE = path.join(__dirname);
const OUT = path.join(HERE, 'outputs');
const ORIGIN = 'https://inference.mangoboost.io';
const API_BASE = 'https://api.mangoboost.io/v1';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const UA_METADATA = {
  brands: [
    { brand: 'Not_A Brand', version: '24' },
    { brand: 'Chromium', version: '141' },
    { brand: 'Google Chrome', version: '141' },
  ],
  fullVersionList: [
    { brand: 'Not_A Brand', version: '24.0.0.0' },
    { brand: 'Chromium', version: '141.0.0.0' },
    { brand: 'Google Chrome', version: '141.0.0.0' },
  ],
  fullVersion: '141.0.0.0',
  platform: 'Windows',
  platformVersion: '10.0.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false,
};

const BROKER_MAILTRAP = 'http://127.0.0.1:9700';
const BROKER_INBOXES = 'http://127.0.0.1:9701';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.random().toString(36).slice(2, 2 + n);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.appendFileSync(path.join(OUT, 'mango.log'), line + '\n');
  } catch {}
}

// ------------------------------------------------------------------- proxies

const POOL_FILES = [
  path.join(__dirname, 'proxies.txt'),
  path.join(__dirname, 'out', 'proxy-live-pool-recheck-live.txt'),
  path.join(__dirname, 'out', 'proxy-live-pool-live.txt'),
  path.join(__dirname, 'out', 'pilot-proxies.txt'),
  path.join(__dirname, 'out', 'proxy-candidates-fresh.txt'),
];

/** Loads the proxy pool from the first file that parses, then appends the rest (deduped). */
function loadPool() {
  const seen = new Set();
  const out = [];
  for (const f of POOL_FILES) {
    let list = [];
    try {
      list = proxyLib.loadProxyList(f);
    } catch {
      continue;
    }
    for (const p of list) {
      if (proxyLib.isLocalHost && proxyLib.isLocalHost(p.host)) continue;
      const key = `${p.protocol}://${p.host}:${p.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function proxyLabel(p) {
  return p ? `${p.protocol}://${p.host}:${p.port}` : '(none)';
}

/** One exit check: returns the egress IP as the site would see it. Falls back
 * across echo services so an ipify throttle does not read as a dead proxy. */
const ECHO_SERVICES = [
  'https://api.ipify.org/?format=text',
  'https://ifconfig.me/ip',
  'https://ipinfo.io/ip',
  'https://checkip.amazonaws.com',
  'https://ident.me',
];
async function exitIp(proxy, timeoutMs = 12000) {
  let last = null;
  for (const url of ECHO_SERVICES) {
    try {
      const text = await proxyLib.fetchText(proxy, url, { timeoutMs });
      const ip = (String(text || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || '';
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
      last = `bad answer from ${url}: ${String(text || '').slice(0, 60)}`;
    } catch (e) {
      last = `${url}: ${String(e.message).slice(0, 60)}`;
    }
  }
  throw new Error(`no echo answered (${last})`);
}

/** Finds a pool entry that (a) tunnels and (b) is not our own line. */
async function pickExit(pool, { start = 0, selfIp = null, timeoutMs = 12000 } = {}) {
  if (!Array.isArray(pool)) throw new Error(`pickExit: pool is ${typeof pool}`);
  if (!pool.length) throw new Error('pickExit: empty pool');
  if (!Number.isFinite(start)) start = 0;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[(start + i) % pool.length];
    if (!p) {
      log(`pickExit: undefined entry at ${(start + i) % pool.length} (pool ${pool.length}, start ${start})`);
      continue;
    }
    try {
      const ip = await exitIp(p, timeoutMs);
      if (selfIp && ip === selfIp) {
        log(`exit ${proxyLabel(p)} -> ${ip} == own line, skip`);
        continue;
      }
      return { proxy: p, ip };
    } catch (e) {
      log(`exit dead ${proxyLabel(p)}: ${e.message.slice(0, 60)}`);
    }
  }
  throw new Error('no working exit in pool');
}

async function ownIp() {
  for (let round = 1; round <= 3; round++) {
    for (const url of ECHO_SERVICES) {
      try {
        const text = await proxyLib.fetchText(null, url, { timeoutMs: 8000 });
        const ip = (String(text || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || '';
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
      } catch {}
    }
    await sleep(2000);
  }
  return null;
}

// ----------------------------------------------------------- HTTP (proxied)

/** Tiny cookie jar keyed by host. */
class Jar {
  constructor() {
    this.cookies = new Map(); // host -> Map(name -> value)
  }
  setFromResponse(host, setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const raw of list) {
      const [pair] = String(raw).split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!this.cookies.has(host)) this.cookies.set(host, new Map());
      this.cookies.get(host).set(name, value);
    }
  }
  header(host) {
    const m = this.cookies.get(host);
    if (!m || !m.size) return '';
    return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(host, name) {
    const m = this.cookies.get(host);
    return m ? m.get(name) : undefined;
  }
  dump() {
    const out = {};
    for (const [h, m] of this.cookies) out[h] = Object.fromEntries(m);
    return out;
  }
  load(dump) {
    for (const [h, m] of Object.entries(dump || {})) this.cookies.set(h, new Map(Object.entries(m)));
  }
}

/**
 * One HTTP round-trip through `proxy` (or direct when null). Returns
 * { status, headers, text, json }. Follows redirects when `follow` is set,
 * keeping cookies.
 */
function httpReq(proxy, url, { method = 'GET', headers = {}, body, timeoutMs = 30000, jar, follow = 0, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload =
      body === undefined || body === null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { 'User-Agent': UA, ...headers };
    if (payload && !Object.keys(finalHeaders).some((h) => h.toLowerCase() === 'content-length')) {
      finalHeaders['Content-Length'] = payload.length;
    }
    if (jar) {
      const c = jar.header(u.hostname);
      if (c) finalHeaders.Cookie = finalHeaders.Cookie ? `${finalHeaders.Cookie}; ${c}` : c;
    }
    const req = lib.request(
      {
        method,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        agent: agent || (proxy ? proxyLib.createAgent(proxy) : undefined),
        headers: finalHeaders,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (jar) jar.setFromResponse(u.hostname, res.headers['set-cookie']);
          if (follow > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = new URL(res.headers.location, url).toString();
            const m = res.statusCode === 303 ? 'GET' : method;
            return resolve(
              httpReq(proxy, next, { method: m, headers, body: m === 'GET' ? undefined : body, timeoutMs, jar, follow: follow - 1, agent })
            );
          }
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json, url });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------- mail provider

// Mailboxes come from three interchangeable sources, tried in order:
//   1. Mailtrap directly  — needs MAILTRAP_TOKEN (env) or a token file;
//      every account gets its own inbox in the "river-bulk" folder.
//   2. The local inbox broker on :9700 / :9701 — same providers behind a daemon,
//      with proxy-aware retries (workspace convenience).
//   3. inboxes.com — public API, no account: any local part on one of its
//      domains is already an inbox; the "token" is the address itself.
// A mailbox record keeps everything the three need: { provider, address, token,
// base? } — `base` set means "talk to the broker", otherwise call the API directly.

const MAILTRAP_API = 'https://mailtrap.io/api';
const MAILTRAP_FOLDER = 'river-bulk';

/** Optional: route mailbox API calls through a proxy (`MANGO_MAIL_PROXY=<line>`)
 * — the same free-exit continuity problems that hit the mint hit the mail API. */
let mailProxyObj;
function mailProxy() {
  if (mailProxyObj === undefined) {
    mailProxyObj = null;
    const line = process.env.MANGO_MAIL_PROXY;
    if (line) {
      try {
        mailProxyObj = proxyLib.parseProxy(line.trim());
      } catch {
        mailProxyObj = null;
      }
    }
  }
  return mailProxyObj;
}

function mailtrapToken() {
  if (process.env.MAILTRAP_TOKEN) return process.env.MAILTRAP_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.river-mailtrap-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function mailtrapApi(method, endpoint, body) {
  const headers = { Authorization: `Bearer ${mailtrapToken()}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await httpReq(null, MAILTRAP_API + endpoint, { method, headers, body: body || undefined, timeoutMs: 30000 });
      if (res.status >= 400) throw new Error(`mailtrap ${method} ${endpoint} -> ${res.status}: ${res.text.slice(0, 120)}`);
      return res.json;
    } catch (e) {
      lastErr = e;
      if (/-> 4\d\d/.test(String(e.message))) throw e; // a real API answer, not transport
      await sleep(2000);
    }
  }
  throw lastErr;
}

async function inboxesApi(pathname) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await httpReq(null, `https://inboxes.com/api/v2/${pathname}`, { headers: { Accept: 'application/json' }, timeoutMs: 25000 });
      if (res.status >= 400) throw new Error(`inboxes.com ${pathname} -> ${res.status}`);
      if (!res.json) throw new Error(`inboxes.com ${pathname} -> non-JSON (${res.text.slice(0, 80)})`);
      return res.json;
    } catch (e) {
      lastErr = e;
      await sleep(2000);
    }
  }
  throw lastErr;
}

let mtFolderId = null;

async function mailtrapCreate() {
  if (!mailtrapToken()) throw new Error('no mailtrap token');
  if (!mtFolderId) {
    const folders = await mailtrapApi('GET', '/inbound/folders');
    const list = Array.isArray(folders) ? folders : folders.folders || [];
    const found = list.find((f) => f.name === MAILTRAP_FOLDER);
    mtFolderId = found ? found.id : (await mailtrapApi('POST', '/inbound/folders', { name: MAILTRAP_FOLDER })).id;
  }
  const inbox = await mailtrapApi('POST', `/inbound/folders/${mtFolderId}/inboxes`, { name: `mn${rand(6)}` });
  return { provider: 'mailtrap', address: inbox.address, token: String(inbox.id) };
}

function mailtrapMessages(data) {
  return (Array.isArray(data) ? data : data.data || []).map((m) => ({
    id: String(m.id),
    subject: m.subject || '',
    from: m.from_email || m.from || '',
    text: m.text_body || '',
    html: m.html_body || '',
  }));
}

async function mailtrapList(mailbox) {
  return mailtrapMessages(await mailtrapApi('GET', `/inbound/inboxes/${mailbox.token}/messages`));
}

async function mailtrapRead(mailbox, id) {
  const m = await mailtrapApi('GET', `/inbound/inboxes/${mailbox.token}/messages/${id}`);
  return mailtrapMessages([m])[0];
}

let inboxesDomains = null;

async function inboxesCreate() {
  if (!inboxesDomains) {
    const json = await inboxesApi('domain');
    const list = (json.domains || json || []).map((d) => d.qdn || d.domain || d).filter(Boolean);
    if (!list.length) throw new Error('inboxes.com published no domains');
    inboxesDomains = list;
  }
  const address = `mn${rand(7)}@${inboxesDomains[Math.floor(Math.random() * inboxesDomains.length)]}`;
  return { provider: 'inboxes', address, token: address };
}

async function inboxesList(mailbox) {
  const json = await inboxesApi(`inbox/${encodeURIComponent(mailbox.address)}`);
  const msgs = json.msgs || json.messages || [];
  return msgs.map((m) => ({ id: String(m.uid || m.id), subject: m.s || m.subject || '', from: m.f || m.from || '', text: m.ph || '', html: '' }));
}

async function inboxesRead(mailbox, id) {
  const m = await inboxesApi(`message/${encodeURIComponent(id)}`);
  return { id: String(m.uid || id), subject: m.s || m.subject || '', from: m.f || m.from || '', text: m.text || '', html: m.html || '' };
}

async function brokerJson(base, pathname, { method = 'GET', timeoutMs = 45000 } = {}) {
  const res = await httpReq(null, base + pathname, { method, timeoutMs });
  if (res.status !== 200 || !res.json) throw new Error(`broker ${base}${pathname} -> ${res.status}: ${res.text.slice(0, 120)}`);
  return res.json;
}

async function brokerCreate(base) {
  // the broker may walk its proxy chain on the first call — give it room
  const out = await brokerJson(base, '/create', { method: 'POST', timeoutMs: 150000 });
  if (!out.address || !out.token) throw new Error(`broker ${base} answered ${JSON.stringify(out).slice(0, 120)}`);
  return { address: out.address, token: out.token, base };
}

/** Tries every mailbox source in order and returns the first that answers. */
async function newMailbox(prefer = 'mailtrap') {
  const attempts = mailboxAttempts(prefer);
  let lastErr;
  for (const [name, fn] of attempts) {
    try {
      const mb = await fn();
      return { provider: mb.provider || (name.includes('inboxes') ? 'inboxes' : 'mailtrap'), ...mb };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`no mailbox provider: ${lastErr && lastErr.message}`);
}

function mailboxAttempts(prefer = 'mailtrap') {
  const brokerFirst = [['broker-mailtrap', async () => ({ provider: 'mailtrap', ...(await brokerCreate(BROKER_MAILTRAP)) })], ['native-mailtrap', () => mailtrapCreate()]];
  // with a mail proxy configured, the direct API is under our control and the
  // broker's own proxy chain only adds latency — flip the order
  const mailtrapOrder = mailProxy() ? [brokerFirst[1], brokerFirst[0]] : brokerFirst;
  const inboxesFirst = [['native-inboxes', () => inboxesCreate()], ['broker-inboxes', async () => ({ provider: 'inboxes', ...(await brokerCreate(BROKER_INBOXES)) })]];
  return prefer === 'inboxes' ? [...inboxesFirst, ...mailtrapOrder] : [...mailtrapOrder, ...inboxesFirst];
}

/** Same, but the mailbox must also list successfully before it is handed out. */
async function newUsableMailbox(prefer = 'mailtrap') {
  const errors = [];
  for (let round = 1; round <= 2; round++) {
    for (const [name, fn] of mailboxAttempts(prefer)) {
      try {
        const mb = await fn();
        const usable = { provider: mb.provider || (name.includes('inboxes') ? 'inboxes' : 'mailtrap'), ...mb };
        await listMail(usable);
        return usable;
      } catch (e) {
        errors.push(`${name}: ${String(e && e.message).slice(0, 90)}`);
      }
    }
    await sleep(4000);
  }
  throw new Error(`no usable mailbox — ${errors.slice(-6).join(' | ')}`);
}

async function listMail(mailbox) {
  if (mailbox.base) return (await brokerJson(mailbox.base, `/list?token=${encodeURIComponent(mailbox.token)}`)).messages || [];
  return mailbox.provider === 'mailtrap' ? mailtrapList(mailbox) : inboxesList(mailbox);
}

async function readMail(mailbox, id) {
  if (mailbox.base) return brokerJson(mailbox.base, `/read?id=${encodeURIComponent(id)}&token=${encodeURIComponent(mailbox.token)}`);
  return mailbox.provider === 'mailtrap' ? mailtrapRead(mailbox, id) : inboxesRead(mailbox, id);
}

/** Polls the mailbox until `test(message)` passes. Returns the message. */
async function waitForMail(mailbox, test, { timeoutMs = 150000, pollMs = 5000, note } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = new Set();
  while (Date.now() < deadline) {
    let msgs = [];
    try {
      msgs = await listMail(mailbox);
    } catch (e) {
      if (note) note(`mail list error: ${e.message.slice(0, 80)}`);
    }
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      let full = m;
      try {
        full = await readMail(mailbox, m.id);
      } catch {}
      if (test(full)) return full;
    }
    await sleep(pollMs);
  }
  return null;
}

/** All http(s) links in a mail body, decoded, deduped. */
function extractLinks(msg) {
  const blob = `${msg.html || ''}\n${msg.text || ''}`;
  const hrefs = [...blob.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const bare = [...blob.matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map((m) => m[0]);
  const all = [...hrefs, ...bare]
    .map((s) => s.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/'))
    .map((s) => s.replace(/[).,;]+$/, ''));
  return [...new Set(all)];
}

// ------------------------------------------------------------------- chrome

function launchChrome(port, profileDir, { headless = true } = {}) {
  const flags = [
    headless ? '--headless=new' : '--start-maximized',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--disable-breakpad',
    '--disable-default-apps',
    '--no-service-autorun',
    '--metrics-recording-only',
    '--disable-blink-features=AutomationControlled',
    '--password-store=basic',
    '--lang=en-US',
    '--window-size=1366,900',
    'about:blank',
  ];
  const child = spawn(CHROME, flags, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {}
    await sleep(600);
  }
  return false;
}

/** Attaches to an already-running debug port, otherwise launches Chrome. */
async function ensureChrome(port, profileDir, { headless = true } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) return 'attached';
  } catch {}
  launchChrome(port, profileDir, { headless });
  if (!(await waitForPort(port))) throw new Error(`chrome did not open port ${port}`);
  return 'launched';
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.s = sessionId;
  }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.s);
    if (r.exceptionDetails) {
      throw new Error(`eval: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''}`.slice(0, 300));
    }
    return r.result.value;
  }
  async goto(url, { waitMs = 0 } = {}) {
    await this.cdp.send('Page.navigate', { url }, this.s);
    if (waitMs) await sleep(waitMs);
  }
  async body() {
    try {
      return await this.eval('document.body ? document.body.innerText : ""');
    } catch {
      return '';
    }
  }
  async html() {
    try {
      return await this.eval('document.documentElement ? document.documentElement.outerHTML : ""');
    } catch {
      return '';
    }
  }
  async url() {
    try {
      return await this.eval('location.href');
    } catch {
      return '';
    }
  }
  async waitFor(expr, { timeoutMs = 30000, pollMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(expr);
        if (v) return v;
      } catch {}
      await sleep(pollMs);
    }
    return null;
  }
  async rect(finder) {
    return this.eval(
      `(() => { try { const el = ${finder}; if (!el) return null; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left }; } catch (e) { return null; } })()`
    );
  }
  async mouseClick(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, this.s);
    await sleep(40 + Math.random() * 90);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, this.s);
    await sleep(50 + Math.random() * 80);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, this.s);
  }
  async click(finder, { scroll = true } = {}) {
    if (scroll) {
      try {
        await this.eval(`(() => { const el = ${finder}; if (el) el.scrollIntoView({block:'center'}); return !!el; })()`);
        await sleep(120);
      } catch {}
    }
    const r = await this.rect(finder);
    if (!r) return false;
    await this.mouseClick(r.x, r.y);
    return true;
  }
  async type(selector, text, { clear = true } = {}) {
    if (!(await this.click(`document.querySelector(${JSON.stringify(selector)})`))) return false;
    await sleep(90);
    if (clear) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, this.s);
      await sleep(60);
    }
    const chunks = text.match(/.{1,4}/g) || [text];
    for (const ch of chunks) {
      await this.cdp.send('Input.insertText', { text: ch }, this.s);
      await sleep(25 + Math.random() * 55);
    }
    const got = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : null; })()`);
    if (got !== text) {
      await this.eval(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); el.focus(); d.set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
      );
    }
    return true;
  }
  /** Human-ish per-key typing (fires real keydown/input events). */
  async typeKeys(selector, text, { clear = true } = {}) {
    if (!(await this.click(`document.querySelector(${JSON.stringify(selector)})`))) return false;
    await sleep(120);
    if (clear) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, this.s);
      await sleep(80);
    }
    for (const ch of String(text)) {
      const code = /[0-9]/.test(ch) ? `Digit${ch}` : /[a-zA-Z]/.test(ch) ? `Key${ch.toUpperCase()}` : '';
      const vk = /[0-9]/.test(ch) ? 48 + Number(ch) : /[a-zA-Z]/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, text: ch, unmodifiedText: ch }, this.s);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk }, this.s);
      await sleep(30 + Math.random() * 50);
    }
    return true;
  }
  /** Clicks the Turnstile widget if one is present (real click). */
  async pokeTurnstile() {
    const info = await this.eval(
      `(() => { const f = [...document.querySelectorAll('iframe')].find(f => /challenges\\.cloudflare\\.com/.test(f.src || '')); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`
    );
    if (!info || info.w < 10) return false;
    await this.mouseClick(info.x + Math.min(30, info.w / 2), info.y + info.h / 2);
    return true;
  }
}

/**
 * Opens an isolated browser context (its own proxy + storage) and wires up
 * network capture: every request whose URL matches `capture` is recorded with
 * method/headers/postData, responses by requestId.
 */
async function openContext(cdp, proxy, { capture } = {}) {
  const ctx = await cdp.createBrowserContext(proxy ? { proxyServer: proxyLib.browserUrl(proxy) } : {});
  const { targetId, sessionId } = await cdp.newPage({ browserContextId: ctx, url: 'about:blank' });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US,en', platform: 'Win32', userAgentMetadata: UA_METADATA }, sessionId);
  const detachProxyAuth = proxy && proxy.username ? await proxyLib.attachProxyAuth(cdp, sessionId, proxy) : async () => {};
  const net = { requests: [], responses: [] };
  const want = capture || (() => true);
  cdp.on(
    'Network.requestWillBeSent',
    (p) => {
      if (!want(p.request.url)) return;
      net.requests.push({
        method: p.request.method,
        url: p.request.url,
        headers: p.request.headers,
        postData: p.request.postData || '',
        type: p.type,
        ts: Date.now(),
      });
    },
    sessionId
  );
  cdp.on(
    'Network.responseReceived',
    (p) => {
      if (!want(p.response.url)) return;
      net.responses.push({ url: p.response.url, status: p.response.status, requestId: p.requestId, type: p.type, ts: Date.now() });
    },
    sessionId
  );
  const page = new Page(cdp, sessionId);
  page.responseBody = async (requestId) => {
    const r = await cdp.send('Network.getResponseBody', { requestId }, sessionId).catch(() => null);
    if (!r) return '';
    return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
  };
  page.cookies = async () => {
    const r = await cdp.send('Network.getCookies', {}, sessionId).catch(() => null);
    return (r && r.cookies) || [];
  };
  page.setCookies = async (cookies) => {
    for (const c of cookies) {
      await cdp
        .send('Network.setCookie', { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', url: `https://${String(c.domain).replace(/^\./, '')}${c.path || '/'}` }, sessionId)
        .catch(() => {});
    }
  };
  return { ctx, targetId, sessionId, page, net, detachProxyAuth };
}

/**
 * Clicks `finder` repeatedly until `checkExpr` is truthy — survives React
 * hydration lag on first paint.
 */
async function clickUntil(page, finder, checkExpr, { attempts = 12, gapMs = 1100 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await page.click(finder).catch(() => {});
    await sleep(gapMs);
    const ok = await page.eval(`(() => { try { return !!(${checkExpr}); } catch (e) { return false; } })()`).catch(() => false);
    if (ok) return true;
  }
  return false;
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function randomPassword() {
  const words = ['Mango', 'River', 'Nova', 'Lumen', 'Delta', 'Orbit', 'Quartz', 'Vega', 'Juno', 'Kappa'];
  return `${words[Math.floor(Math.random() * words.length)]}!${rand(4)}${Math.floor(Math.random() * 90 + 10)}`;
}

module.exports = {
  HERE,
  OUT,
  ORIGIN,
  API_BASE,
  CHROME,
  UA,
  UA_METADATA,
  BROKER_MAILTRAP,
  BROKER_INBOXES,
  POOL_FILES,
  sleep,
  rand,
  now,
  log,
  loadPool,
  proxyLabel,
  exitIp,
  pickExit,
  ownIp,
  Jar,
  httpReq,
  newMailbox,
  newUsableMailbox,
  listMail,
  readMail,
  waitForMail,
  extractLinks,
  launchChrome,
  waitForPort,
  ensureChrome,
  Page,
  openContext,
  clickUntil,
  saveJson,
  readJson,
  randomPassword,
  proxyLib,
  CDP,
  os,
};
