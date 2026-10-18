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

**Bulk-create Mango (mangoboost.io) accounts with auto-generated API keys — OpenAI-compatible inference (DeepSeek, Kimi, GLM, MiniMax) + 9Router connector.**

[![Node](https://img.shields.io/badge/Node-%E2%89%A518-3DA639?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue?style=for-the-badge)](#)
[![License](https://img.shields.io/badge/license-MIT-6ea8fe?style=for-the-badge)](LICENSE)
[![Models](https://img.shields.io/badge/models-6%20served-412991?style=for-the-badge)](https://inference.mangoboost.io)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6?style=for-the-badge)](#-connect-to-9router)
[![X](https://img.shields.io/badge/X-%40bigbullapp-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/bigbullapp)

[🛠 Quick start](#-quick-start) · [🎁 Free tier](#-free-tier--how-much-you-get) · [🤖 Models](#-models--all-6-of-them) · [🧪 Use the API](#-how-to-use-the-api) · [✅ Verified](#-verified-working--every-key-is-tested) · [🧭 How it works](#-how-it-works) · [🔌 9Router](#-connect-to-9router) · [⚙️ Options](#️-cli-options) · [🛰️ Proxies](#️-behind-a-proxy) · [🐞 Issues](#-issues)

</div>

---

## ✨ Why this exists

Mango Inference (MangoBoost) hands every account its own API key, created inside a console whose sign-up is an e-mail, a six-digit code from the inbox, then name / password / consent, then the key. The console is a Next.js App Router app on Google Cloud Run — every auth step is a **server action** (`POST /login` / `POST /email-confirm` with `Next-Action`, `Content-Type: text/plain;charset=UTF-8`). Doing that by hand is fine for one account and hopeless for thirty. This tool walks the whole path unattended — **plain HTTP, no browser, no phone, no card at sign-up** — over your proxy list, and only records a key after `GET /v1/models` answers 200 for it.

## 🎁 Free tier — how much you get

**A fresh Mango account's key authenticates immediately; inference needs the account's wallet funded.**

| Item | Measured (18 accounts, 2026-10-14) |
| --- | --- |
| Key live at mint time | `GET https://api.mangoboost.io/v1/models` **200** — every key written is live on that call |
| Wallet on a fresh account | `GET /api/bff/billing/balance` → `{"balance":"0.00","promotional_balance":"0.00"}` — starts empty |
| Chat on a fresh account | `POST /v1/chat/completions` **402** `{"code":"insufficient_balance"}` — the *key* is good, the *wallet* is empty |
| Card-gated offer | `GET /api/bff/billing/card-credit-offers` lists a **$10.00 "Launch bonus"** — *card required* |
| Key expiry | `POST /api/bff/keys` → `201` `{"key":…, "expires_at": "≈ +1 year"}` — `expires_in_days: null` gives ~1-year validity |
| The unit that scales | **one account = one key** → `--count N` is really "N wallets" (the wallet lives on the account) |

So: the **key** is live from the first second, and **inference starts the moment the account's wallet is funded** — the billing page's card-gated $10 launch bonus, or any credit you add.

> 💡 The free tier is set by Mango and can change. Check the live numbers at [inference.mangoboost.io](https://inference.mangoboost.io) — and let the tool's own gate decide:

```bash
node src/cli.js verify --file src/keys.txt   # every key is re-tested against the live API
```

## 🤖 Models — all 6 of them

`GET https://api.mangoboost.io/v1/models` with a minted key serves **6 ids** (captured in [`src/models.json`](src/models.json); every entry carries `context_window`, `max_output_tokens`, `supported_features` and a `cost` block):

| Model ID | Family | Status | Context |
| --- | --- | --- | --- |
| `deepseek-ai/DeepSeek-V4-Pro-0813` | DeepSeek | available — verifier's default | 1,048,576 |
| `moonshotai/Kimi-K3` | Moonshot | available | 1,048,576 |
| `zai-org/GLM-5.3` | Z.ai | available | 1,048,576 |
| `zai-org/GLM-5.2` | Z.ai | available | 1,048,576 |
| `zai-org/GLM-5.2-FP8` | Z.ai | deprecated | 1,048,576 |
| `minimax/MiniMax-M3` | MiniMax | available | 1,048,576 |

Authentication works immediately — `/v1/models` answers **200** for every key this tool writes. Chat answers **402** `insufficient_balance` until the account's wallet is funded (see above) — that is the wallet, not the key.

## 🧪 How to use the API

The base URL is **`https://api.mangoboost.io/v1`** — OpenAI-compatible, so anything that speaks OpenAI works (SDKs, Cursor, OpenCode, Kilo Code, …).

```bash
curl https://api.mangoboost.io/v1/chat/completions \
  -H "Authorization: Bearer <one of your keys>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-ai/DeepSeek-V4-Pro-0813","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://api.mangoboost.io/v1", api_key="<your key>")
print(client.chat.completions.create(model="deepseek-ai/DeepSeek-V4-Pro-0813",
      messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

On a fresh (unfunded) account this answers `402 insufficient_balance` — the key authenticates, the wallet is empty.

## 🛠 Quick start

```bash
# clone this repository (or download the ZIP), then:
cd mango-bulk-apikey

# 1) your proxy list, one exit per line (http://, socks5://, socks4:// or bare host:port)
printf 'socks5://127.0.0.1:1080\n' > src/proxies.txt

# 2) mint — any N, 30 is just the default sample
node src/cli.js mint --count 30 --workers 3

# 3) re-check keys later through fresh exits
node src/cli.js verify --file src/keys.txt
```

Everything the tools write lands **next to the code**: `src/keys.txt`, `src/accounts.json`, `src/outputs/` — and the catalogue they read is `src/models.json`. The pool is read from `src/proxies.txt` (`--pool <file>` overrides). Prefer a menu? `node src/launcher.js` offers **mint · verify · settings** and remembers your count and concurrency in `launcher.config.json`.

### 🖱️ The launcher

```bash
node src/launcher.js
```

A menu over **mint · verify · settings**: it asks for `count` (keys per run, default 30) and `workers` (1–8, default 3), keeps them in `launcher.config.json`, and spawns `node src/cli.js <task>` with the right flags. Menu item **4** registers one key with 9Router.

## ✅ Verified working — every key is tested

Measured **2026-10-14 – 2026-10-15**: **18 keys, 18 distinct accounts** (one key per account), all live-verified at mint time. Spot re-checks later the same day confirmed the state.

| Check | Call | Result |
| --- | --- | --- |
| Whole sign-up chain, per account | register → OTP → profile → key, each server action answering `{ok:true}` | one fresh account, one key |
| Key is live at mint time — run for **every** key before it is written | `GET https://api.mangoboost.io/v1/models` | **200** + the 6-model list; a key that fails this is never written to `keys.txt` |
| Chat on a fresh account | `POST /v1/chat/completions` | **402** `{"code":"insufficient_balance"}` — the *key* authenticates, the *account wallet* is empty |
| Key creation | `POST /api/bff/keys` | **201** `{"key", "key_prefix", "key_suffix", "expires_at"}` — `expires_at` ≈ +1 year |
| Re-check later | `node src/cli.js verify --file src/keys.txt` | walks the whole list through fresh exits; dead keys move to `keys.invalid.txt` |

## 🧭 How it works

```
inbox (one address per account)                                  a fresh address per account
   │
   ├─▶ sign-up: Mango page → e-mail address → code / link from the inbox
   ├─▶ session: the account's cookies or access token in hand
   ├─▶ key mint: the account's key endpoint → plaintext key returned once (written to disk immediately)
   └─▶ live proof: POST https://api.mangoboost.io/v1/chat/completions → real content = the key is live
```

Every auth/console mutation is a Next.js **server action**: `POST https://inference.mangoboost.io/<page>` with header `Next-Action: <id>`, `Content-Type: text/plain;charset=UTF-8`, body = a JSON args array. The action's return value arrives as `{ok, error?}` in the RSC flight stream.

| # | Step | Call | Answer |
| --- | --- | --- | --- |
| 1 | Register | `POST /login` · `Next-Action` · `[{"email":"…"}]` | `{ok:true}` + cookie `mb_pending_email` |
| 2 | OTP mail | from `no-reply@mangoboost.io`, subject "Your Mango Inference verification code" | 6-digit code, ~5–60 s |
| 3 | Validate OTP | `POST /email-confirm` · `[{"otp":"123456"}]` | `{ok:true}` + cookie `mb_reg` |
| 4 | Documents | `GET /api/bff/documents` | consent versions to accept |
| 5 | Complete profile | `POST /email-confirm` · `[{firstName,lastName,password,acceptedVersionIds}]` | `{ok:true}` + session cookie `mb_access` |
| 6 | Create key | `POST /api/bff/keys` `{"label":"mango-…","expires_in_days":null}` | **201** `{data:{id,key,…}}` |
| 7 | Verify | `GET https://api.mangoboost.io/v1/models` with the key | **200** + model list → key is live |

**The key is shown once.** The create-key response is the only copy of the plaintext (`{key, key_prefix, key_suffix}` + *"Save this key… You won't see it again"*); the console only shows prefix/suffix afterwards. Orphaned sessions (session acquired but key never finished) are persisted to `src/outputs/orphaned.json`.

## ⚙️ CLI options

All code lives in `src/` — run it from the repository root as `node src/<file>.js`; data files (`src/keys.txt`, `src/proxies.txt`, `src/accounts.json`, `src/outputs/`) sit next to the code.

| Tool | Flags |
| --- | --- |
| `src/mint.js` | `--count N` (30) · `--workers N` (1–8, default 3) · `--start N` · `--pool <file>` · `--pool-conc N` (2–16, default 8) · `--reach-log <file>` · `--self-ip <ip>` |
| `src/verify.js` | `--file <path>` · `--key <key>` · `--model <id>` |
| `src/launcher.js` | interactive: mint / verify / settings — `count` and `concurrency` (passed on as `--workers`) persist in `launcher.config.json` |

Turbo önerilir (5); daha fazlası zayıf bilgisayarda yük/ban riski.

## 🛰️ Behind a proxy

* `src/proxies.txt`, one exit per line. Accepted lines (blank lines and `#` comments skipped): `socks5://127.0.0.1:1080`, `http://user:pass@10.0.0.1:3128`, `user:pass@10.0.0.2:1080`, `10.0.0.3:8080:user:pass`, `10.0.0.4|3128|user|pass`, `10.0.0.5:3128` (bare host:port defaults to `http://`).
* **Point-of-use probe:** an exit is accepted only when *this run* has carried a real HTTP round-trip to `inference.mangoboost.io/login` on it.
* **Own-IP guard (fail-closed):** the exit's egress IP is checked through several echo services and compared with your own line; an exit that maps to your IP is dropped, and the mint refuses to start if your own IP cannot be determined (`--self-ip` overrides).
* **One account per exit IP**, and no exit is reused inside a run.
* **The key is shown once** — `keys.txt` receives it the moment it verifies; `accounts.json` carries the mailbox, password, name, key, exit and verification result. Orphaned sessions go to `src/outputs/orphaned.json`.

## 📄 Files

| Path | Contents |
| --- | --- |
| `src/keys.txt` | one live-verified key per line — git-ignored |
| `src/accounts.json` | one record per account: mailbox, password, name, key, exit, verification — git-ignored |
| `src/models.json` | `GET /v1/models` as answered by a minted key — git-ignored |
| `src/proxies.txt` | your exits, one per line — git-ignored |
| `%USERPROFILE%\mango-keys.txt` | mirror of `src/keys.txt` outside the repo |
| `src/outputs/` | per-run logs, mint state, half-accounts — git-ignored |
| `src/mint.js` · `src/verify.js` | the two engines the CLI dispatches to |
| `src/connect-9router.js` | registers the keys as 9Router connections |

## 🔌 Connect to 9Router

[9Router](https://9router.com) is a self-hosted, OpenAI-compatible router. Mango is OpenAI-compatible, so register it once and use every key:

```bash
node src/connect-9router.js --base http://localhost:20128 --password 123456 --api-key <your key>
```

Each run registers one key as a connection of the `mango` provider node; call it again with the next key to add another (`--model <id>` overrides the default). Then pick a model inside 9Router:

```
mango/deepseek-ai/DeepSeek-V4-Pro-0813
mango/zai-org/GLM-5.3
mango/minimax/MiniMax-M3
```

Defaults: `--base http://localhost:20128`, `--password 123456`, `--prefix mango`, `--base-url https://api.mangoboost.io/v1`, default model `deepseek-ai/DeepSeek-V4-Pro-0813`.

## 🔑 What one key gets you

| | |
| --- | --- |
| 🏢 Provider | **Mango** — [inference.mangoboost.io](https://inference.mangoboost.io) |
| 🎁 What the provider gives | 6 models (DeepSeek-V4-Pro, Kimi-K3, GLM-5.3, MiniMax-M3) · authentic keys, inference spend-gated until the account wallet is funded |
| 🔑 What one key gets you | one API key scoped to its own account: the 6 model ids on the endpoint below, at your plan's limits. The quota lives on the **account**, which is exactly why this tool creates one account per key |
| 🌐 API shape | OpenAI-compatible: `POST https://api.mangoboost.io/v1/chat/completions` |
| 🔒 Your data | only inference.mangoboost.io and the inbox backend you configure are contacted; keys stay on your machine |

## 🐞 Issues

Mango changed the action ids, the consent documents, the key endpoint or the rate limits? The tool stops at that step and says so. **[Open an issue](../../issues)** with the command you ran and the exact output — the `src/outputs/` logs make failures reproducible without leaking a key. PRs are welcome.

## 📄 License

MIT © 2026 — see [LICENSE](LICENSE).

<div align="center">

**[MIT](LICENSE)** © 2026 mango-bulk-apikey contributors

</div>
