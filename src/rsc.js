'use strict';

/**
 * Next.js server-action caller for inference.mangoboost.io.
 *
 * The console is a Next.js App Router app: every auth/console mutation is a
 * server action invoked by POSTing to a page URL with a `Next-Action` header
 * and a JSON args array as the body. This module replays exactly that over
 * proxied HTTP so the mint does not need a browser per account.
 *
 * Action ids come from the client chunks (see outputs/plan-chunk-a.js etc.).
 */

const lib = require('./lib');

const ACTIONS = {
  register: '4074cfd928c57eb25b01e657649e180b9ada2b0cf5',
  login: '40b9894cdbd2b1c632251bf3b49f247fdd124716cb',
  validateOtp: '40aa6325588282ab774463aa7a4fa14a8b6fc990d3',
  resendOtp: '004d4f6ade5a53488062c087fd7dfb18ad9a4221d4',
  completeProfile: '40578d2d5b52ba60c66faa467498e68176ec79324c',
};

/**
 * POSTs a server action. `pageUrl` must be the URL of the page whose form
 * triggers it (Next derives the action context from the path).
 */
async function callAction(proxy, jar, pageUrl, actionId, args, { timeoutMs = 60000, extraHeaders = {}, follow = 0 } = {}) {
  return lib.httpReq(proxy, pageUrl, {
    method: 'POST',
    headers: {
      'Next-Action': actionId,
      Accept: 'text/x-component',
      'Content-Type': 'text/plain;charset=UTF-8',
      Origin: lib.ORIGIN,
      Referer: pageUrl,
      'Accept-Language': 'en-US,en;q=0.9',
      ...extraHeaders,
    },
    body: JSON.stringify(args),
    jar,
    timeoutMs,
    follow,
  });
}

/** Pulls the action's return value out of the RSC flight stream. */
function parseActionResult(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const tag = line.slice(0, i);
    const payload = line.slice(i + 1);
    if (!/^\d+$/.test(tag)) continue;
    if (payload.startsWith('{') || payload.startsWith('[')) {
      try {
        out.push(JSON.parse(payload));
      } catch {}
    }
  }
  // the action's return value is the first object that carries ok/error/code
  return out.find((v) => v && typeof v === 'object' && ('ok' in v || 'error' in v || 'code' in v)) || out[0] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ACTIONS, callAction, parseActionResult, sleep };
