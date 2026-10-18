'use strict';

/**
 * Mango Inference mint — N accounts x 1 key, HTTP-only.
 *
 *   node src/mint.js --count 30 [--workers 3] [--start 0] [--pool <file>]
 *     [--preset=turbo|balanced|safe] [--gap <seconds>]
 *
 * Per account: fresh proxy exit, fresh mailbox, registerAction -> OTP ->
 * validateOtpAction -> documents -> completeProfileAction -> create key ->
 * live API verification. Keys land one-per-line in ../keys.txt, accounts in
 * ../accounts.json; every key is verified before it is written.
 *
 * Rate: one account per exit (never two accounts from the same exit).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const rsc = require('./rsc');
const verify = require('./verify-lib');

// Keep the fleet alive when one socket dies mid-run (an unhandled 'error' on a
// freed socket used to take the whole worker pool down with it).
process.on('uncaughtException', (e) => console.log(`WARN uncaught: ${String(e && e.message).slice(0, 180)}`));

const HERE = path.join(__dirname);
const KEYS_FILE = path.join(HERE, 'keys.txt');
const MIRROR_FILE = path.join(os.homedir(), 'mango-keys.txt');
const ACCOUNTS_FILE = path.join(HERE, 'accounts.json');
const STATE_FILE = path.join(lib.OUT, 'mint-state.json');
const KEYCFG_FILE = path.join(lib.OUT, 'key-creation.json');

const argv = process.argv.slice(2);
const argVal = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
// Run-shape presets (operator standard v3): `--preset=turbo|balanced|safe` sets the
// worker count (turbo = 5) and the pacing gap; an explicit `--workers` / `--gap`
// always wins, and with no `--preset` the historical counts are untouched.
const { presetArgv, resolvePreset } = require('./preset');
const gapArg = argVal('--gap', null);
const PRESET = resolvePreset({
  preset: presetArgv(argv) || argVal('--preset', null),
  conc: null,
  gap: gapArg == null ? null : parseFloat(gapArg),
  defaultConc: 3, // mango's historical worker count
});
const GAP_MS = PRESET.gap == null ? null : Math.max(0, PRESET.gap) * 1000;
const COUNT = parseInt(argVal('--count', '30'), 10);
const WORKERS = Math.max(1, Math.min(parseInt(argVal('--workers', String(PRESET.conc)), 10), 8));
const START = parseInt(argVal('--start', '0'), 10);
const POOL_FILE = argVal('--pool', null);
const POOL_CONC = Math.max(2, Math.min(parseInt(argVal('--pool-conc', '8'), 10), 16));
const REACH_LOG = argVal('--reach-log', null);
const SELF_IP = argVal('--self-ip', null);


const KEYCFG =
  lib.readJson(KEYCFG_FILE, null) || {
    kind: 'bff',
    path: '/api/bff/keys',
    method: 'POST',
    // observed in the console: client.post('/keys', { label, expires_in_days })
    body: 'default',
  };

// ------------------------------------------------------------------ artifacts

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendKey(key) {
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  const existing = readLines(KEYS_FILE);
  if (!existing.includes(key)) {
    fs.appendFileSync(KEYS_FILE, key + '\n');
    fs.appendFileSync(MIRROR_FILE, key + '\n');
  }
}

function readAccounts() {
  return lib.readJson(ACCOUNTS_FILE, []);
}

function recordAccount(acc) {
  const list = readAccounts();
  list.push(acc);
  lib.saveJson(ACCOUNTS_FILE, list);
}

const ORPHANS_FILE = path.join(lib.OUT, 'orphaned.json');

/** An account that got a session but no verified key — persisted so a later
 * run can resume it (login with the recorded password) instead of losing the
 * mailbox and the whole signup. */
function recordOrphan(o) {
  try {
    const list = lib.readJson(ORPHANS_FILE, []);
    list.push({ ...o, savedAt: new Date().toISOString() });
    lib.saveJson(ORPHANS_FILE, list);
  } catch {}
}

function readState() {
  return lib.readJson(STATE_FILE, { usedExits: [] });
}

function saveState(state) {
  lib.saveJson(STATE_FILE, state);
}

// --------------------------------------------------------------------- signup

/**
 * Hands out verified-live, never-reused proxy exits. A candidate is only
 * accepted after *this* run has (a) carried a real HTTP round-trip to the
 * Mango console on it — general internet liveness is not enough, many proxies
 * answer ipify and cannot reach the target — and (b) reported an exit IP that
 * is not our own line. Probes run in parallel batches so dead free proxies
 * cost ~one timeout per batch, not one per exit.
 */
class ExitProbe {
  constructor(pool, { selfIp, probeTimeout = 30000, concurrency = 96, reachFile = null } = {}) {
    this.pool = pool;
    this.selfIp = selfIp;
    this.probeTimeout = probeTimeout;
    this.concurrency = concurrency;
    this.reachFile = reachFile;
    this.i = 0;
    this.live = [];
    this.probing = null;
    this.taken = new Set();
    this.usedIps = new Set();
    this.dead = 0;
    this.reach = 0;
    this.probeUrl = `${lib.ORIGIN}/login`;
  }

  async _probeBatch() {
    const batch = [];
    while (batch.length < this.concurrency && this.i < this.pool.length) {
      const p = this.pool[this.i++];
      if (p) batch.push(p);
    }
    if (!batch.length) return;
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const res = await lib.httpReq(p, this.probeUrl, { timeoutMs: this.probeTimeout, headers: { Accept: 'text/html' } });
          if (!(res.status >= 200 && res.status < 400)) {
            this.dead++;
            return null;
          }
          const ip = await lib.exitIp(p, this.probeTimeout);
          if (this.selfIp && ip === this.selfIp) {
            this.dead++;
            return null;
          }
          this.reach++;
          return { proxy: p, ip };
        } catch {
          this.dead++;
          return null;
        }
      })
    );
    // one account per exit IP: a second line on an IP that already minted is noise
    for (const r of results) {
      if (!r || this.usedIps.has(r.ip)) continue;
      this.live.push(r);
      if (this.reachFile) {
        try {
          fs.appendFileSync(this.reachFile, `${lib.proxyLabel(r.proxy)}\n`);
        } catch {}
      }
    }
  }

  async take(label) {
    for (;;) {
      while (this.live.length) {
        const ex = this.live.shift();
        if (this.usedIps.has(ex.ip)) continue; // another account already minted on this IP
        this.taken.add(lib.proxyLabel(ex.proxy));
        this.usedIps.add(ex.ip);
        return ex;
      }
      if (this.i >= this.pool.length) throw new Error(`proxy pool exhausted (probed ${this.i}, dead ${this.dead})`);
      if (!this.probing) {
        this.probing = this._probeBatch().finally(() => {
          this.probing = null;
        });
      }
      await this.probing;
    }
  }
}

function randomName() {
  const first = ['Elif', 'Deniz', 'Mert', 'Zeynep', 'Kaan', 'Selin', 'Ege', 'Ada', 'Bora', 'Can'];
  const last = ['Yilmaz', 'Demir', 'Kaya', 'Aydin', 'Celik', 'Arslan', 'Dogan', 'Koc', 'Sahin', 'Ozkan'];
  return { firstName: first[Math.floor(Math.random() * first.length)], lastName: last[Math.floor(Math.random() * last.length)] };
}

/** Creates one account over HTTP and returns {key, ...}. Throws on any hard stop. */
async function createAccount(ctx, { slot, attempt }) {
  const tag = `slot${slot}/try${attempt}`;
  const log = (m) => lib.log(`[${tag}] ${m}`);

  const isNetErr = (e) =>
    /timeout|ECONN|socket|SOCKS|CONNECT|EAI_AGAIN|ENOTFOUND|EPIPE|destroyed|fetch failed|hang up/i.test(String(e && e.message));

  /** Takes the next verified-live exit (exclusive — never reused in this run). */
  async function takeLiveExit() {
    return ctx.pool.take(tag);
  }

  // 1. mailbox first: no proxy needed, and a dead mail path must not burn an exit
  const mailbox = await lib.newUsableMailbox('mailtrap');
  log(`mailbox ${mailbox.address} (${mailbox.provider})`);

  // 2. exit (by contract: one account per exit, never our own line)
  let { proxy, ip } = await takeLiveExit();
  log(`exit ${lib.proxyLabel(proxy)} (${ip})`);
  console.log(`… #${slot} başladı (${lib.proxyLabel(proxy)})`);

  /** Runs `fn(proxy)`; on a network-level failure moves to the next exit and retries. */
  const step = async (label, fn, { tries = 3 } = {}) => {
    for (let i = 0; i < tries; i++) {
      try {
        return await fn(proxy);
      } catch (e) {
        if (!isNetErr(e)) throw e;
        log(`${label}: network failure via ${lib.proxyLabel(proxy)} (${e.message.slice(0, 60)}) — switching exit`);
        const next = await takeLiveExit();
        proxy = next.proxy;
        ip = next.ip;
        log(`exit now ${lib.proxyLabel(proxy)} (${ip})`);
      }
    }
    throw new Error(`${label}: no exit survived ${tries} attempts`);
  };

  const jar = new lib.Jar();
  const P = lib.ORIGIN;

  // 3. register
  const reg = await step('register', (px) => rsc.callAction(px, jar, `${P}/login`, rsc.ACTIONS.register, [{ email: mailbox.address }]));
  const regParsed = rsc.parseActionResult(reg.text);
  if (!regParsed || regParsed.ok !== true) throw new Error(`register -> ${reg.status} ${JSON.stringify(regParsed) || reg.text.slice(0, 200)}`);
  log(`register ok (${reg.status})`);

  // 4. OTP from the mail
  const mail = await lib.waitForMail(
    mailbox,
    (m) => /\b\d{6}\b/.test(`${m.subject} ${m.text || ''} ${m.html || ''}`),
    { timeoutMs: 240000, pollMs: 5000, note: (m) => log(m.slice(0, 120)) }
  );
  if (!mail) throw new Error('no OTP mail within 240s');
  const blob = `${mail.subject} ${mail.text || ''} ${mail.html || ''}`;
  const otp = ([...new Set([...blob.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]))])[0];
  if (!otp) throw new Error('no 6-digit code in OTP mail');
  log(`otp ${otp} (from ${mail.from})`);

  // 5. validate OTP
  const val = await step('validateOtp', (px) => rsc.callAction(px, jar, `${P}/email-confirm`, rsc.ACTIONS.validateOtp, [{ otp }]));
  const valParsed = rsc.parseActionResult(val.text);
  if (!valParsed || valParsed.ok !== true) throw new Error(`validateOtp -> ${val.status} ${JSON.stringify(valParsed)}`);
  log('otp validated');

  // 6. documents + profile
  const docsRes = await step('documents', (px) => lib.httpReq(px, `${P}/api/bff/documents`, { headers: { Accept: 'application/json' }, jar, timeoutMs: 30000 }));
  const payload = docsRes.json && docsRes.json.data ? docsRes.json.data : docsRes.json;
  const items = (Array.isArray(payload) ? payload : (payload && payload.items) || []).filter((d) => d.audience === 'user');
  const acceptedVersionIds = selectConsentDocs(items, null);
  if (!acceptedVersionIds.length) throw new Error(`no acceptedVersionIds from /api/bff/documents (${docsRes.status})`);

  const { firstName, lastName } = randomName();
  const password = lib.randomPassword();
  const prof = await step('completeProfile', (px) =>
    rsc.callAction(px, jar, `${P}/email-confirm`, rsc.ACTIONS.completeProfile, [{ firstName, lastName, password, acceptedVersionIds }])
  );
  const profParsed = rsc.parseActionResult(prof.text);
  if (!profParsed || profParsed.ok !== true) throw new Error(`completeProfile -> ${prof.status} ${JSON.stringify(profParsed)}`);
  const hasSession = (jar.dump()['inference.mangoboost.io'] || {}).mb_access;
  if (!hasSession) throw new Error('no mb_access session cookie after completeProfile');
  log(`profile ok · session acquired`);

  // 7. key — the session is alive and no mail is involved any more, so this
  // step earns a much larger exit-switching budget than the early steps
  let key;
  try {
    key = await step('createKey', (px) => createKey(px, jar, log), { tries: 8 });
  } catch (e) {
    recordOrphan({ phase: 'createKey', email: mailbox.address, password, firstName, lastName, mailbox, exit: lib.proxyLabel(proxy), exitIp: ip, error: String(e.message).slice(0, 200) });
    throw e;
  }

  // 7b. billing snapshot — live evidence for the launch-credit question
  let billing = null;
  try {
    const bal = await lib.httpReq(proxy, `${P}/api/bff/billing/balance`, { headers: { Accept: 'application/json' }, jar, timeoutMs: 30000 });
    const offers = await lib.httpReq(proxy, `${P}/api/bff/billing/card-credit-offers`, { headers: { Accept: 'application/json' }, jar, timeoutMs: 30000 });
    const pick = (r) => (r && r.json && r.json.data ? r.json.data : r && r.json) || null;
    billing = { balance: pick(bal), offers: pick(offers), status: [bal.status, offers.status] };
  } catch (e) {
    billing = { error: String(e && e.message).slice(0, 160) };
  }
  log(`billing ${JSON.stringify(billing).slice(0, 220)}`);

  // 8. verify before it counts — auth level must pass; chat level recorded
  let v;
  try {
    v = await step('verify', (px) => verify.verifyKey(px, key, { timeoutMs: 90000 }), { tries: 5 });
  } catch (e) {
    recordOrphan({ phase: 'verify', email: mailbox.address, password, firstName, lastName, mailbox, key, exit: lib.proxyLabel(proxy), exitIp: ip, error: String(e.message).slice(0, 200) });
    throw e;
  }
  if (!v.authOk) throw new Error(`key ${key.slice(0, 6)}… failed live verification: ${v.status} ${v.error || v.snippet || ''}`);
  log(`key verified: models=${v.status}${v.chatOk ? ` chat=200 (${v.snippet})` : ` chat=${v.chatStatus} (${v.chatError})`}`);

  if (v.modelsRaw && v.modelsRaw.data) {
    const modelsFile = path.join(HERE, 'models.json');
    if (!fs.existsSync(modelsFile)) {
      lib.saveJson(modelsFile, { savedAt: new Date().toISOString(), baseUrl: lib.API_BASE, ...v.modelsRaw });
    }
  }

  return {
    key,
    mailbox: { address: mailbox.address, provider: mailbox.provider, token: mailbox.token },
    password,
    firstName,
    lastName,
    exit: lib.proxyLabel(proxy),
    exitIp: ip,
    billing,
    verify: { modelsStatus: v.status, chatStatus: v.chatStatus, chatOk: v.chatOk, chatError: v.chatError, model: v.model, snippet: v.snippet },
  };
}

/** Mirrors the app's selectConsentDocuments for the /api/bff/documents shape. */
function selectConsentDocs(list, region) {
  const keep = new Set();
  const groups = new Map();
  for (const d of list || []) {
    const vid = d.version_id || d.versionId;
    if (!d.variant_group && !d.variantGroup) {
      keep.add(vid);
      continue;
    }
    const g = d.variant_group || d.variantGroup;
    groups.set(g, [...(groups.get(g) || []), d]);
  }
  for (const arr of groups.values()) {
    const pick = (region ? arr.find((x) => (x.jurisdiction || null) === region) : undefined) || arr.find((x) => !x.jurisdiction);
    if (pick) keep.add(pick.version_id || pick.versionId);
  }
  return (list || []).map((d) => d.version_id || d.versionId).filter((v) => keep.has(v));
}

/**
 * Creates one API key on the /keys page. Shape is learned from
 * outputs/key-creation.json (written by keys-probe / the CDP capture); when the
 * console exposes a REST path we hit it directly, otherwise the server action.
 */
async function createKey(proxy, jar, log) {
  if (!KEYCFG) throw new Error('outputs/key-creation.json missing — run the keys probe first');
  const name = `mango-${lib.rand(6)}`;

  if (KEYCFG.kind === 'bff') {
    const body = KEYCFG.body === 'default' ? { label: name, expires_in_days: null } : KEYCFG.body ? KEYCFG.body(name) : { label: name };
    const res = await lib.httpReq(proxy, `${lib.ORIGIN}${KEYCFG.path}`, {
      method: KEYCFG.method || 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: lib.ORIGIN, Referer: `${lib.ORIGIN}/keys` },
      body,
      jar,
      timeoutMs: 45000,
    });
    if (res.status >= 400) throw new Error(`createKey bff -> ${res.status} ${res.text.slice(0, 200)}`);
    const key = res.json && res.json.data && res.json.data.key ? res.json.data.key : extractKey(res.text);
    if (!key) throw new Error(`createKey bff -> no key in response: ${res.text.slice(0, 300)}`);
    log(`key created via ${KEYCFG.path} (${res.status})`);
    return key;
  }

  if (KEYCFG.kind === 'action') {
    const res = await rsc.callAction(proxy, jar, `${lib.ORIGIN}${KEYCFG.path || '/keys'}`, KEYCFG.action, KEYCFG.args ? KEYCFG.args(name) : [{ name }], { timeoutMs: 45000 });
    if (res.status >= 400) throw new Error(`createKey action -> ${res.status} ${res.text.slice(0, 200)}`);
    const key = extractKey(res.text);
    if (!key) throw new Error(`createKey action -> no key in response: ${res.text.slice(0, 400)}`);
    log(`key created via action ${KEYCFG.action}`);
    return key;
  }

  throw new Error(`unknown key-creation kind: ${KEYCFG.kind}`);
}

/** Finds the minted secret in any create-key response (flight or JSON). */
function extractKey(text) {
  const blob = String(text || '');
  const patterns = [
    /"(?:key|api_key|apiKey|secret|token)"\s*:\s*"([A-Za-z0-9_\-.$]{20,120})"/,
    /\b(mg[a-zA-Z0-9_\-.]{20,120})\b/,
    /\b(sk-[a-zA-Z0-9_\-.]{20,120})\b/,
  ];
  for (const p of patterns) {
    const m = blob.match(p);
    if (m) return m[1];
  }
  return null;
}

// ----------------------------------------------------------------------- main

(async () => {
  const selfIp = SELF_IP || (await lib.ownIp());
  if (!selfIp) throw new Error('own IP could not be determined via any echo service — pass --self-ip or fix egress; refusing to mint without the own-line guard');
  if (SELF_IP) lib.log(`own-ip override via --self-ip: ${selfIp}`);
  const allPool = POOL_FILE ? lib.proxyLib.loadProxyList(POOL_FILE) : lib.loadPool();
  const state = readState();
  const usedExits = new Set(state.usedExits || []);
  // never reuse an exit that already minted an account (campaign says one per account/exit)
  const pool = allPool.filter((p) => !usedExits.has(lib.proxyLabel(p)));
  lib.log(`pool ${allPool.length} (unused ${pool.length}) · own ${selfIp} · count ${COUNT} · workers ${WORKERS}`);

  const ctx = {
    selfIp,
    // The probe class is `ExitProbe` (see above); `ExitPool` never existed, and
    // the stray bare `pool,` key above the real one left the ctx.pool slot
    // pointing at an undefined binding.
    pool: new ExitProbe(pool, { selfIp, concurrency: POOL_CONC, reachFile: REACH_LOG }),
  };
  // never mint a second account on an exit IP an earlier account already used
  for (const acc of readAccounts()) if (acc.exitIp) ctx.pool.usedIps.add(acc.exitIp);

  let done = 0;
  let failures = 0;
  const baseKeys = readLines(KEYS_FILE).length;

  // Fixed slot ids so retries are visible in the log.
  const slots = [];
  for (let i = 0; i < COUNT; i++) slots.push(START + i);

  const queue = slots.slice();
  const results = [];

  async function worker(w) {
    while (queue.length) {
      const slot = queue.shift();
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const acc = await createAccount(ctx, { slot, attempt });
          appendKey(acc.key);
          usedExits.add(acc.exit);
          saveState({ ...state, usedExits: [...usedExits] });
          recordAccount({
            n: readAccounts().length + 1,
            email: acc.mailbox.address,
            mailbox: acc.mailbox,
            password: acc.password,
            name: `${acc.firstName} ${acc.lastName}`,
            key: acc.key,
            keyPrefix: `${acc.key.slice(0, 8)}…${acc.key.slice(-4)}`,
            verify: acc.verify,
            billing: acc.billing || null,
            exit: acc.exit,
            exitIp: acc.exitIp,
            createdAt: new Date().toISOString(),
          });
          done++;
          lib.log(`worker${w} slot${slot} DONE (${done}/${COUNT})`);
          console.log(`✓ #${slot} KEY ALINDI: ${acc.key.slice(0, 22)}…   [${done} ok / ${done + failures} deneme]`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          lib.log(`worker${w} slot${slot} attempt${attempt} FAIL: ${e.message.slice(0, 220)}`);
          console.log(`✗ #${slot} key yok: ${String(e.message).slice(0, 200)}`);
          await lib.sleep(GAP_MS == null ? 4000 + Math.random() * 4000 : GAP_MS);
        }
      }
      if (lastErr) {
        failures++;
        results.push({ slot, ok: false, error: lastErr.message.slice(0, 200) });
      } else {
        results.push({ slot, ok: true });
      }
      // pacing gap between accounts when a preset / --gap asks for one
      if (GAP_MS) await lib.sleep(GAP_MS);
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
  lib.log(`run finished in ${Math.round((Date.now() - t0) / 1000)}s — ok ${done}, failed ${failures}, keys ${baseKeys} -> ${readLines(KEYS_FILE).length} · pool probed ${ctx.pool.i} (reach ${ctx.pool.reach}, dead ${ctx.pool.dead})`);
  console.log(`MINT ${done}/${COUNT} OK`);
  console.log(JSON.stringify({ done, failures, results }, null, 2));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('MINT FAIL', e.stack || e.message);
  process.exit(1);
});
