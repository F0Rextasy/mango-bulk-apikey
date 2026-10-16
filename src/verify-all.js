'use strict';

/**
 * Batch re-verification of the whole key list.
 *
 *   node src/verify-all.js [--pool <file>] [--keys <file>] [--workers 4]
 *
 * Every key is checked live (GET /v1/models + POST /v1/chat/completions)
 * through pool proxies — one exit per key, a fresh exit on every network
 * failure. Keys that no longer authenticate are moved out of `keys.txt` into
 * `keys.invalid.txt` (with the exact error), the `%USERPROFILE%` mirror is
 * rewritten to match, and `accounts.json` gets a fresh `lastVerify` block per
 * account. Exit code 0 when every key passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const vlib = require('./verify-lib');
const proxyLib = require('./proxy');

const HERE = path.join(__dirname);
const KEYS_FILE = path.join(HERE, 'keys.txt');
const INVALID_FILE = path.join(HERE, 'keys.invalid.txt');
const MIRROR_FILE = path.join(os.homedir(), 'mango-keys.txt');
const ACCOUNTS_FILE = path.join(HERE, 'accounts.json');

const argv = process.argv.slice(2);
const argVal = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const KEYS_IN = path.resolve(argVal('--keys', KEYS_FILE));
const POOL_FILE = argVal('--pool', null);
const WORKERS = Math.max(1, Math.min(parseInt(argVal('--workers', '4'), 10), 8));

const readLines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

(async () => {
  const keys = readLines(KEYS_IN);
  if (!keys.length) throw new Error(`no keys in ${KEYS_IN}`);
  const selfIp = await lib.ownIp();
  const pool = (POOL_FILE ? proxyLib.loadProxyList(path.resolve(POOL_FILE)) : lib.loadPool()).filter(Boolean);
  lib.log(`verify-all: ${keys.length} keys · pool ${pool.length} · own ${selfIp} · workers ${WORKERS}`);
  if (pool.length < WORKERS) throw new Error(`pool too small (${pool.length})`);

  let cursor = 0;
  const results = new Array(keys.length);
  let idx = 0;
  async function worker(w) {
    while (idx < keys.length) {
      const i = idx++;
      const key = keys[i];
      const short = `${key.slice(0, 8)}…${key.slice(-4)}`;
      let r = null;
      for (let attempt = 1; attempt <= 6; attempt++) {
        const p = pool[cursor++ % pool.length];
        try {
          r = await vlib.verifyKey(p, key, { timeoutMs: 60000 });
          if (r.status !== undefined) break; // HTTP answer received, retry won't change it
        } catch (e) {
          lib.log(`[w${w}] ${short} network error via ${lib.proxyLabel(p)} (${String(e.message).slice(0, 60)})`);
          r = null;
        }
      }
      if (!r) r = { status: 0, authOk: false, error: 'no exit survived 6 attempts' };
      r.key = key;
      results[i] = r;
      lib.log(
        `[w${w}] ${short} ${r.authOk ? 'OK' : 'FAIL'} models=${r.status} chat=${r.chatStatus !== undefined ? r.chatStatus : '-'} ${r.chatError || r.snippet || r.error || ''}`
      );
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));

  const ok = results.filter((r) => r.authOk);
  // an HTTP answer that is not OK means the key is really invalid; no answer at
  // all (status 0) is an exit problem — the key stays in keys.txt
  const bad = results.filter((r) => !r.authOk && r.status !== 0);
  const indeterminate = results.filter((r) => !r.authOk && r.status === 0);
  const chatOk = results.filter((r) => r.chatOk);

  const keep = results.filter((r) => r.authOk || r.status === 0);
  fs.writeFileSync(KEYS_FILE, keep.map((r) => r.key).join('\n') + (keep.length ? '\n' : ''));
  fs.writeFileSync(
    INVALID_FILE,
    bad.map((r) => `${r.key}\t${r.status}\t${(r.error || r.chatError || 'auth failed').replace(/[\r\n\t]+/g, ' ').slice(0, 200)}`).join('\n') + (bad.length ? '\n' : '')
  );
  try {
    fs.writeFileSync(MIRROR_FILE, keep.map((r) => r.key).join('\n') + (keep.length ? '\n' : ''));
  } catch (e) {
    lib.log(`mirror write failed: ${e.message}`);
  }

  // accounts.json: refresh verification data
  const accounts = lib.readJson(ACCOUNTS_FILE, []);
  const byKey = new Map(results.map((r) => [r.key, r]));
  for (const acc of accounts) {
    const r = byKey.get(acc.key);
    if (!r) {
      acc.lastVerify = { at: new Date().toISOString(), missing: true };
      continue;
    }
    acc.verify = { modelsStatus: r.status, chatStatus: r.chatStatus, chatOk: r.chatOk, chatError: r.chatError, model: r.model, snippet: r.snippet };
    acc.lastVerify = {
      at: new Date().toISOString(),
      authOk: r.authOk,
      indeterminate: r.status === 0,
      error: r.authOk ? null : r.error || `models ${r.status}`,
    };
    if (!r.authOk && r.status !== 0) acc.invalid = true;
    else delete acc.invalid;
  }
  lib.saveJson(ACCOUNTS_FILE, accounts);

  const summary = {
    keys: keys.length,
    authOk: ok.length,
    chatOk: chatOk.length,
    invalid: bad.length,
    indeterminate: indeterminate.length,
    invalidKeys: bad.map((r) => ({ key: `${r.key.slice(0, 8)}…${r.key.slice(-4)}`, status: r.status, error: (r.error || '').slice(0, 120) })),
    indeterminateKeys: indeterminate.map((r) => `${r.key.slice(0, 8)}…${r.key.slice(-4)}`),
  };
  lib.log(`verify-all done: ${ok.length}/${keys.length} authOk · ${chatOk.length} chatOk · ${bad.length} invalid · ${indeterminate.length} indeterminate`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => {
  console.error('VERIFY-ALL FAIL', e.stack || e.message);
  process.exit(2);
});
