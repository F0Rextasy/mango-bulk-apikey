<div align="center">

```
███╗   ███╗ █████╗ ███╗   ██╗ ██████╗  ██████╗
████╗ ████║██╔══██╗████╗  ██║██╔════╝ ██╔═══██╗
██╔████╔██║███████║██╔██╗ ██║██║  ███╗██║   ██║
██║╚██╔╝██║██╔══██║██║╚██╗██║██║   ██║██║   ██║
██║ ╚═╝ ██║██║  ██║██║ ╚████║╚██████╔╝╚██████╔╝
╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝
```

# mango-bulk-apikey

**Bulk-create Mango (mangoboost.io) accounts with auto-generated API keys — OpenAI-compatible inference + 9Router connector.**

[![Node](https://img.shields.io/badge/Node-%E2%89%A518-3DA639?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue?style=for-the-badge)](#)
[![License](https://img.shields.io/badge/license-MIT-6ea8fe?style=for-the-badge)](LICENSE)
[![Models](https://img.shields.io/badge/models-6%20served-412991?style=for-the-badge)](src/models.json)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-connect-to-9router)

[🛠 Quick start](#-quick-start) · [✅ Verified](#-verified-working--every-key-is-tested) · [🧭 How it works](#-how-it-works) · [🤖 Models & free tier](#-models--free-tier) · [🔌 9Router](#-connect-to-9router) · [⚙️ Options](#️-options) · [🛰️ Proxies](#️-behind-a-proxy) · [🐞 Issues](#-issues)

</div>

---

> **Mint as many accounts/keys as you need — there is no cap.** `--count N` (default `30`)
> accepts any N; N accounts, N keys, one account per key.

## ✨ What this does

Mango Inference (MangoBoost) hands every account its own API key, created inside a console whose
sign-up is an e-mail, a six-digit code from the inbox, then name / password / consent, then the key.
Doing that by hand is fine for one account and hopeless for thirty.

This tool walks the whole path unattended — **plain HTTP against the console's own routes, no
browser, no phone step, no card at sign-up** — over your proxy list, and records a key only after
the live API answers with it. The wallet lives on the **account** and a fresh one starts empty
(see [Models & free tier](#-models--free-tier)), so the useful unit is *one account per key*: N keys
means N accounts.

```
proxies.txt ─▶ exit probe: does this exit reach inference.mangoboost.io/login right now?
                    │
                    ▼
      mailbox  ──▶ POST /login            register            → {ok:true}
               ──▶ inbox                 "Your Mango Inference verification code" (6 digits)
               ──▶ POST /email-confirm    validateOtp         → {ok:true}
               ──▶ GET  /api/bff/documents                    (consent versions)
               ──▶ POST /email-confirm    completeProfile     → session cookie mb_access
               ──▶ POST /api/bff/keys     {label, expires_in_days:null} → 201 + plaintext key
               ──▶ GET  https://api.mangoboost.io/v1/models   → 200 = the key is live
                              │
                              ▼
                 keys.txt — one verified key per line
```

## 🛠 Quick start

```bash
git clone https://github.com/F0Rextasy/mango-bulk-apikey.git
cd mango-bulk-apikey

# 1) your proxy list, one exit per line (http://, socks5://, socks4:// or bare host:port)
printf 'socks5://127.0.0.1:1080\n' > proxies.txt

# 2) mint — any N, 30 is just the default sample
node src/cli.js mint --count 30 --workers 3

# 3) re-check keys later through fresh exits
node src/cli.js verify --file keys.txt
```

Everything the tools write lands **next to the code**: `src/keys.txt`, `src/accounts.json`,
`src/outputs/` — and the model catalogue they read is `src/models.json`. The pool is read from
`src/proxies.txt` (`--pool <file>` overrides).

Prefer a menu?
 `node src/launcher.js` offers **mint · verify · settings** and remembers your count and
concurrency in `launcher.config.json`.

What lands on disk while it runs:

| Path | Content |
| --- | --- |
| `keys.txt` | the keys, **one per line**, appended the moment a key verifies (git-ignored) |
| `%USERPROFILE%\mango-keys.txt` | a mirror of the same list, outside the repo |
| `accounts.json` | one record per account: mailbox, password, name, key, exit, verification result (git-ignored) |
| [`models.json`](src/models.json) | `GET /v1/models` as answered by a minted key |
| `outputs/` | per-run log, mint state, half-accounts (git-ignored) |

## ✅ Verified working — every key is tested

| Check | Call | Result |
| --- | --- | --- |
| Whole sign-up chain, per account | register → OTP → profile → key, each server action answering `{ok:true}` | one fresh account, one key |
| Key is live at mint time — run for **every** key before it is written | `GET https://api.mangoboost.io/v1/models` | **200** + the 6-model list; a key that fails this is never written to `keys.txt` |
| Key re-check later | `node src/cli.js verify --file keys.txt` | walks the whole list through fresh exits; dead keys move to `keys.invalid.txt` |
| Chat on a fresh account | `POST /v1/chat/completions` | **402 `insufficient_balance`** — the *key* authenticates, the *account wallet* is empty until it is funded |
| Key creation | `POST /api/bff/keys` | **201** `{key, key_prefix, key_suffix, expires_at}` — `expires_at` ≈ +1 year |

## 🧭 How it works

Every auth/console mutation is a Next.js **server action**: `POST https://inference.mangoboost.io/<page>`
with header `Next-Action: <id>`, `Content-Type: text/plain;charset=UTF-8`, body = a JSON args array.
The action's return value arrives as a `{ok, error?}` object inside the RSC flight stream:

| # | Step | Call | Answer |
| --- | --- | --- | --- |
| 1 | register | `POST /login` · `Next-Action` · `[{"email":"…"}]` | `{ok:true}` + cookie `mb_pending_email` |
| 2 | OTP mail | from the panel’s own sender, subject “Your Mango Inference verification code” | 6-digit code, usually seconds |
| 3 | validate OTP | `POST /email-confirm` · `[{"otp":"123456"}]` | `{ok:true}` + cookie `mb_reg` |
| 4 | documents | `GET /api/bff/documents` | consent versions to accept |
| 5 | complete profile | `POST /email-confirm` · `[{firstName,lastName,password,acceptedVersionIds}]` | `{ok:true}` + session cookie `mb_access` |
| 6 | create key | `POST /api/bff/keys` `{"label":"mango-xxxxxx","expires_in_days":null}` | `201 {data:{id,key,…}}` |
| 7 | verify | `GET https://api.mangoboost.io/v1/models` with the key | `200` + model list → the key is live |

Operational notes:

* **The key is shown once.** The create-key response is the only copy of the plaintext
  (`{key, key_prefix, key_suffix}` + *“Save this key… You won't see it again”*); the console only
  shows prefix/suffix afterwards. `keys.txt` receives it the moment it verifies.
* **Checkpointed per account:** a key is appended to `keys.txt` + `accounts.json` the moment it
  verifies, and existing lines are never rewritten — a dying exit costs one attempt, not the batch.
* **Half-accounts are kept:** if the session was acquired but the key step never finished, the
  account (e-mail + password + mailbox) is persisted to `outputs/orphaned.json` instead of being lost.
* **402 on chat is not a key defect:** a fresh account's wallet is empty while the same key answers
  `200` on `/v1/models`. Fund the account to spend — [details below](#-models--free-tier).

## 🤖 Models & free tier

`GET https://api.mangoboost.io/v1/models` with a minted key serves **6 ids** (captured in
[`models.json`](src/models.json); every entry carries `context_window`, `max_output_tokens`,
`supported_features` and a `cost` block):

| Model id | Family | Status |
| --- | --- | --- |
| `deepseek-ai/DeepSeek-V4-Pro-0813` | DeepSeek | available — the verifier's default chat model |
| `moonshotai/Kimi-K3` | Moonshot | available |
| `zai-org/GLM-5.3` | Z.ai | available |
| `zai-org/GLM-5.2` | Z.ai | available |
| `zai-org/GLM-5.2-FP8` | Z.ai | deprecated |
| `minimax/MiniMax-M3` | MiniMax | available |

All six report a 1,048,576-token context window. **Authentication works immediately** —
`/v1/models` answers `200` for every key this tool writes.

**What a fresh account's free tier looks like — measured on every minted account:**

| Call | Result |
| --- | --- |
| `GET /api/bff/billing/balance` | `{"balance":"0.00","promotional_balance":"0.00"}` — the wallet starts empty |
| `POST /v1/chat/completions` | `402 {"code":"insufficient_balance"}` |
| `GET /api/bff/billing/card-credit-offers` | a **$10.00 “Launch bonus”** offer — *card required* |

So: the **key** is live from the first second, and **inference starts the moment the account's
wallet is funded** — the billing page's card-gated $10 launch bonus, or any credit/voucher you add.
Because the wallet lives on the account, *one account per key* is what scales: a new account is a
new wallet, and the tool mints as many as you ask for.

```bash
curl https://api.mangoboost.io/v1/chat/completions \
  -H "Authorization: Bearer <one of your keys>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-ai/DeepSeek-V4-Pro-0813","messages":[{"role":"user","content":"hi"}]}'
```

## 🔌 Connect to 9Router

The keys this tool mints are ordinary OpenAI-compatible credentials, so a local
9Router instance can serve them like any other provider: one `openai-compatible`
node for Mango (mangoboost.io), one connection per key.

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key <key>            # or env NINEROUTER_API_KEY
```

The launcher menu and the CLI dispatcher drive the same connector:

```bash
node src/launcher.js --connect-9router    # asks for base URL, password and key (the key is not echoed)
node src/cli.js connect --api-key <key>   # the same task, non-interactive
node src/connect-9router.js --help        # every flag and default
```

Defaults: base `http://localhost:20128`, password `123456`, model prefix
`mango`, node `mango`, upstream `https://api.mangoboost.io/v1`, default model
`deepseek-ai/DeepSeek-V4-Pro-0813`. Register another minted key with `--name "<label 2>"` — the node stays and
every key becomes another connection 9Router can load-balance across. Then pick a model inside
9Router:

```
mango/deepseek-ai/DeepSeek-V4-Pro-0813
mango/zai-org/GLM-5.3
```

## ⚙️ Options

```bash
node src/cli.js mint   --count 30 --workers 3     # create fresh accounts, one key each
node src/cli.js verify --file keys.txt            # re-check keys already on disk
node src/cli.js help                              # tasks and flags
```

| Task | Flags |
| --- | --- |
| `mint` | `--count N` (default `30`, any N — no cap) · `--workers N` (1–8, default `3`) · `--start N` (first slot number in the log) · `--pool <file>` (point at a specific list; `proxies.txt` is the convention) · `--pool-conc N` (parallel pool probes, 2–16, default `8`) · `--reach-log <file>` (append every accepted exit) · `--self-ip <ip>` (own-IP guard override) |
| `verify` | `--file <path>` (a key list) · `--key <key>` (a single key) · `--model <id>` (chat model for the completion step) |

`node src/launcher.js` drives the same tasks with a menu (defaults: count `30`, concurrency `2`) and
stores what you answer in `launcher.config.json`. The pool file is `proxies.txt`; every exit is
probed at the point of use, so a list that has aged still works — it just takes longer.

## 🛰️ Behind a proxy

`proxies.txt`, one exit per line. Accepted shapes (blank lines and `#` comments are skipped):

```
socks5://127.0.0.1:1080
http://user:pass@10.0.0.1:3128
user:pass@10.0.0.2:1080
10.0.0.3:8080:user:pass
10.0.0.4|3128|user|pass
10.0.0.5:3128          # bare host:port defaults to http://
```

* **Point-of-use probe:** an exit is accepted only when *this run* has carried a real HTTP
  round-trip to `inference.mangoboost.io/login` on it. General internet liveness is not enough.
* **Own-IP guard (fail-closed):** the exit's egress IP is checked through several echo services and
  compared with your own line; an exit that maps to your IP is dropped, and the mint refuses to
  start at all if your own IP cannot be determined (pass `--self-ip` if the echo services are flaky).
* **One account per exit IP**, and no exit is reused inside a run.
* **Public lists are volatile:** a line that answers now can be gone minutes later, so the tool
  re-probes at the point of use and re-picks a fresh exit whenever a step dies at the network level.
  `--reach-log <file>` appends every accepted exit, so you can keep the survivors.

## 🐞 Issues

Mango changed the action ids, the consent documents, the key endpoint or the rate limits? The tool
stops at that step and says so. **[Open an issue](../../issues)**
with the command you ran and the exact output — the `outputs/` logs make failures reproducible
without leaking a key. PRs are welcome.

## 📄 License

[MIT](LICENSE) © 2026 mango-bulk-apikey contributors — use it on accounts you are allowed to create.

---

