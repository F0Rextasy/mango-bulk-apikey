'use strict';

/**
 * CLI key verification against the Mango Inference API.
 *
 *   node src/verify.js --key <key> [--model deepseek-ai/DeepSeek-V4-Pro-0813]
 *   node src/verify.js --file ../keys.txt
 *
 * Every call exits through a pool proxy. `GET /v1/models` is saved to
 * ../models.json on the first success.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const vlib = require('./verify-lib');

const HERE = path.join(__dirname);
const MODELS_FILE = path.join(HERE, 'models.json');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

(async () => {
  const pool = lib.loadPool();
  const self = await lib.ownIp();
  const key = arg('--key');
  const file = arg('--file');
  const model = arg('--model');

  const keys = key ? [key] : file ? fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  if (!keys.length) {
    console.error('usage: node src/verify.js --key <key> | --file <keys.txt>');
    process.exit(2);
  }

  const results = [];
  let exitCursor = 0;
  for (const k of keys) {
    let r = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      let picked;
      try {
        picked = await lib.pickExit(pool, { selfIp: self, start: exitCursor++ });
      } catch (e) {
        r = { ok: false, error: `no exit: ${e.message.slice(0, 120)}` };
        break;
      }
      lib.log(`verify ${k.slice(0, 4)}...${k.slice(-4)} via ${lib.proxyLabel(picked.proxy)} (${picked.ip}) try${attempt}`);
      try {
        r = await vlib.verifyKey(picked.proxy, k, { model });
        if (r.status !== undefined) break; // got an HTTP answer; retrying won't help
      } catch (e) {
        r = { ok: false, error: e.message.slice(0, 200), exit: lib.proxyLabel(picked.proxy) };
        lib.log(`  network error: ${r.error}`);
      }
    }
    r.key = k;
    results.push(r);
    lib.log(`  -> ${r.ok ? 'OK' : 'FAIL'} status=${r.status} model=${r.model || '-'} ${r.snippet || r.error || ''}`);
    if (r.ok && r.modelsRaw && r.modelsRaw.data && !fs.existsSync(MODELS_FILE)) {
      lib.saveJson(MODELS_FILE, { savedAt: new Date().toISOString(), baseUrl: lib.API_BASE, ...r.modelsRaw });
      lib.log(`  models.json saved (${r.modelsRaw.data.length} models)`);
    }
  }
  console.log(JSON.stringify(results.map((r) => ({ key: r.key.slice(0, 4) + '...' + r.key.slice(-4), ok: r.ok, status: r.status, model: r.model })), null, 2));
  process.exit(results.some((r) => r.ok) ? 0 : 1);
})().catch((e) => {
  console.error('VERIFY FAIL', e.stack || e.message);
  process.exit(1);
});
