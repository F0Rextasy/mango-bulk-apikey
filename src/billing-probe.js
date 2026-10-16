'use strict';

/**
 * Billing/credit view for the signed-in account, with exit fallback.
 *
 *   node src/billing-probe.js
 */

const path = require('path');
const lib = require('./lib');

const STATE_FILE = path.join(lib.OUT, 'http-signup-state.json');

(async () => {
  const state = lib.readJson(STATE_FILE, null);
  if (!state || !state.jar) throw new Error('no jar in http-signup-state.json');
  const jar = new lib.Jar();
  jar.load(state.jar);
  const pool = lib.loadPool();
  const selfIp = await lib.ownIp();

  let cursor = 0;
  async function get(p, { method = 'GET', body } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let picked;
      try {
        picked = await lib.pickExit(pool, { selfIp, start: cursor++ });
      } catch (e) {
        return { status: 0, text: `no exit: ${e.message}` };
      }
      try {
        const res = await lib.httpReq(picked.proxy, `${lib.ORIGIN}${p}`, {
          method,
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', Origin: lib.ORIGIN } : {}) },
          body,
          jar,
          timeoutMs: 25000,
        });
        return res;
      } catch (e) {
        // network failure — try the next exit
      }
    }
    return { status: 0, text: 'all exits failed' };
  }

  const paths = [
    '/api/bff/billing/balance',
    '/api/bff/billing/profile',
    '/api/bff/billing/card-credit-offers',
    '/api/bff/billing/history',
    '/api/bff/billing/credit/purchases',
    '/api/bff/billing/payment-methods',
  ];
  for (const p of paths) {
    const res = await get(p);
    lib.log(`${p} -> ${res.status} ${String(res.text).replace(/\s+/g, ' ').slice(0, 320)}`);
    if (res.status === 200 && res.json) lib.saveJson(path.join(lib.OUT, `billing${p.replace(/\//g, '_')}.json`), res.json);
  }
  process.exit(0);
})().catch((e) => {
  console.error('BILLING PROBE FAIL', e.stack || e.message);
  process.exit(1);
});
