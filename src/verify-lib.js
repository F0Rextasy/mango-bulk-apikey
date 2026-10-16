'use strict';

/** Key verification against the Mango Inference API (shared by mint + CLI). */

const lib = require('./lib');

async function apiCall(proxy, key, pathname, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  return lib.httpReq(proxy, lib.API_BASE + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
    timeoutMs,
  });
}

/**
 * Verifies one key. Two levels:
 *   authOk — `GET /v1/models` answers 200 with a model list (key is real)
 *   chatOk — `POST /v1/chat/completions` answers 200 with content (account has
 *            balance; a zero-balance account still authenticates and gets 402)
 */
async function verifyKey(proxy, key, { model, timeoutMs = 90000 } = {}) {
  const models = await apiCall(proxy, key, '/models', { timeoutMs });
  const ids = models.json && Array.isArray(models.json.data) ? models.json.data.map((m) => m.id) : [];
  const authOk = models.status === 200 && ids.length > 0;
  const base = { status: models.status, authOk, models: ids, modelsRaw: models.json, exit: lib.proxyLabel(proxy) };
  if (!authOk) {
    return { ...base, ok: false, chatOk: false, error: models.status === 401 || models.status === 403 ? `auth ${models.status}` : `models ${models.status}: ${models.text.slice(0, 120)}` };
  }

  const chosen = model || ids.find((id) => /DeepSeek-V4-Pro/i.test(id)) || ids.find((id) => /GLM-5\.3/i.test(id)) || ids[0];
  const chat = await apiCall(proxy, key, '/chat/completions', {
    method: 'POST',
    body: {
      model: chosen,
      messages: [{ role: 'user', content: 'Reply with exactly: MANGO_OK' }],
      max_tokens: 24,
      temperature: 0,
    },
    timeoutMs,
  });
  const content =
    chat.json && chat.json.choices && chat.json.choices[0] && chat.json.choices[0].message ? chat.json.choices[0].message.content : null;
  const chatOk = chat.status === 200 && !!content;
  const chatError = chatOk ? null : (chat.json && chat.json.error && chat.json.error.code) || chat.text.slice(0, 160);
  return {
    ...base,
    ok: chatOk,
    model: chosen,
    chatOk,
    chatStatus: chat.status,
    chatError,
    snippet: content ? String(content).slice(0, 80) : null,
  };
}

module.exports = { apiCall, verifyKey };
