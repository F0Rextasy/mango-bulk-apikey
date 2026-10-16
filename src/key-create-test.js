'use strict';

/**
 * Creates one key for the signed-in account via the console BFF and prints the
 * response verbatim, plus a look at the credit/billing shapes.
 *
 *   node src/key-create-test.js [name]
 */

const path = require('path');
const lib = require('./lib');

const STATE_FILE = path.join(lib.OUT, 'http-signup-state.json');

(async () => {
  const name = process.argv[2] || `mango-${lib.rand(6)}`;
  const state = lib.readJson(STATE_FILE, null);
  if (!state || !state.jar) throw new Error('no jar in http-signup-state.json');
  const jar = new lib.Jar();
  jar.load(state.jar);

  // the account's original exit may have died — fall back to the next live one
  const pool = lib.loadPool();
  const selfIp = await lib.ownIp();
  const preferred = lib.proxyLib.parseProxy(state.exit);
  let proxy = preferred;
  try {
    await lib.exitIp(preferred, 8000);
    lib.log(`using original exit ${state.exit}`);
  } catch {
    const picked = await lib.pickExit(pool, { selfIp });
    proxy = picked.proxy;
    lib.log(`original exit dead; using ${lib.proxyLabel(proxy)} (${picked.ip})`);
  }

  const res = await lib.httpReq(proxy, `${lib.ORIGIN}/api/bff/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: lib.ORIGIN, Referer: `${lib.ORIGIN}/keys` },
    body: { name },
    jar,
    timeoutMs: 45000,
  });
  lib.log(`POST /api/bff/keys -> ${res.status}`);
  lib.log(`  body: ${res.text.replace(/\s+/g, ' ').slice(0, 600)}`);

  if (res.status < 400 && res.json) {
    lib.saveJson(path.join(lib.OUT, 'key-create-result.json'), res.json);
    state.jar = jar.dump();
    state.keyCreated = res.json;
    lib.saveJson(STATE_FILE, state);
  }

  // credit / balance shapes
  const probes = ['/api/bff/billing/balance', '/api/bff/billing/summary', '/api/bff/orgs/' + 'PLACEHOLDER' + '/balance'];
  const orgs = lib.readJson(path.join(lib.OUT, 'bff_api_bff_orgs.json'), null);
  const orgId = orgs && orgs.data && orgs.data.items && orgs.data.items[0] && orgs.data.items[0].id;
  const list = [...probes.slice(0, 2)];
  if (orgId) list.push(`/api/bff/orgs/${orgId}/balance`, `/api/bff/billing/orgs/${orgId}`);
  for (const p of list) {
    try {
      const r2 = await lib.httpReq(proxy, `${lib.ORIGIN}${p}`, { headers: { Accept: 'application/json' }, jar, timeoutMs: 20000 });
      lib.log(`${p} -> ${r2.status} ${r2.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    } catch (e) {
      lib.log(`${p} -> ERR ${e.message.slice(0, 70)}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('KEY CREATE TEST FAIL', e.stack || e.message);
  process.exit(1);
});
