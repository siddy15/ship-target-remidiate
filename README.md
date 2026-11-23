# Ship, Target, Remediate (`launchdarkly-dev-abc`)

*A LaunchDarkly demo: release a feature, roll it back, target it, measure conversion, and remediate incidents safely with OpenTelemetry tracing, and a guardrailed AI Release Copilot.*

**The story.** ABC Company is a B2B enterprise cloud platform handling ~40,000 daily visitors across standard, QA, and VIP customer tiers. Its engineering and product teams want to ship a new **v2.0 Revamped Landing Hero & AI Cost Optimizer** without the usual deployment risk: test it on internal QA and selected customers first, turn it off instantly if P99 latency spikes, and measure whether the revamp lifts landing-page conversions. This app is their site, built to show how LaunchDarkly does each of those jobs—paired with Coralogix OpenTelemetry observability, LaunchDarkly AI Configs, and a human-in-the-loop AI Release Copilot.

| | |
|---|---|
| **Release, Rollback & Context Targeting** | **Experimentation, Telemetry & AI Guardrails** |
| Switch between Rohan (`Standard`), Sarah (`qa-sarah`), and John (`Premium`) in the top control bar—or toggle the flag in LaunchDarkly—to make the v2.0 AI Cloud card appear or vanish with **no page reload** (`<0.1ms` local SDK evaluation). | Click **Get Started Today** to stream conversion events (`landing-page-conversion`), simulate a `2,450ms` P99 latency spike into Coralogix OTel spans, chat with the **AI Release Copilot**, and approve a before/after diff card to remediate safely. |

---

## Quick start (under 10 minutes)

**You need:**
- **Node.js 18+** (tested on Node.js v26.13.0) and `npm`
- A free **[LaunchDarkly trial account](https://launchdarkly.com/start-trial/)** (includes feature flags, targeting rules, experimentation, and AI Configs)
- A modern desktop browser (Chrome, Edge, Safari, or Firefox)
- **Optional:** **LM Studio** (e.g., `google/gemma-4-12b-qat` on `http://localhost:1234/v1`) or **Ollama** (`http://localhost:11434/v1`) for live local LLM chat responses—with automatic topic-aware fallbacks if no local LLM server is running
- **Optional:** A **Coralogix account** for live OpenTelemetry trace correlation (`CORALOGIX_API_KEY`). Leave it unset and the entire web app, LaunchDarkly SDK, and AI Release Copilot still run locally.

```bash
git clone <your-public-github-repo-url> && cd launchdarkly-dev-abc
npm install
node server.js            # http://localhost:3000
```

Before opening `http://localhost:3000`, complete two 3-minute configuration steps below:
1. **Paste your LaunchDarkly Client-side ID** into `public/js/app.js` (line 1).
2. **Create one feature flag and one metric** (plus an optional `release-copilot-config` AI Config) in your LaunchDarkly dashboard.

---

## 1. Configure your SDK key in code

Open `public/js/app.js` and replace `CLIENT_SIDE_ID` with the **Client-side ID** from your LaunchDarkly environment (**Account settings → Projects → Environments**):

```javascript
// public/js/app.js
// Replace with your own LaunchDarkly environment Client-side ID
const CLIENT_SIDE_ID = '';
```

> **Note:** Only the **Client-side ID** belongs in `public/js/app.js` for browser evaluation. Never expose LaunchDarkly server-side SDK keys, AI SDK keys, or REST API tokens (`api-...`) in frontend files.

---

## 2. Create the LaunchDarkly flag & metric

Create the following resources in your LaunchDarkly project and target environment:

### Feature Flag: `revamped-landing-hero`
- **Flag Key:** `revamped-landing-hero`
- **Flag Type:** `Boolean` (`true` = v2.0 Revamped Experience, `false` = v1.0 Legacy Experience)
- **Client-side SDK availability:** Check **SDKs using Client-side ID**
- **Targeting Rules (with Targeting ON):**
  1. **Individual targeting:** Target context kind `user` with key `qa-sarah` → serve `true`
  2. **Rule-based targeting:** If context kind `user` has `user_tier` **is one of** `Premium` → serve `true`
  3. **Default rule (Fallthrough):** Serve `false` to all other users (such as Standard tier visitors)
  4. **Off variation:** Serve `false` when targeting is toggled OFF (acts as an instant global kill switch)

### Conversion Metric: `landing-page-conversion`
1. Go to **Metrics → Create metric** in LaunchDarkly.
2. **Event kind:** `Custom`
3. **Event key:** `landing-page-conversion`
4. **Metric definition:** `Count` events per `user`, then compute the `Average` (`higher is better`).
5. *(Optional)* Attach this metric to an experiment on `revamped-landing-hero` under the **Experimentation** tab to demonstrate experiment setup.

### AI Config (Optional): `release-copilot-config`
- **Config Key:** `release-copilot-config` (override via `LD_AI_CONFIG_KEY` if needed)
- Evaluates model parameters and system prompt context per user via `@launchdarkly/server-sdk-ai` in `utils/aiConfigService.js`, falling back cleanly to `DEFAULT_AI_CONFIG` when unconfigured.

> **Trial Workspace Note:** Webhook flag triggers are restricted to Enterprise / select plans and may not be available in a trial workspace. This demo uses live flag evaluations, incident simulation, and human-in-the-loop **AI Release Copilot** diff approvals so zero-redeploy remediation works cleanly on a trial account.

---

## LM Studio setup (recommended local LLM)

You can run the **AI Release Copilot** locally using **LM Studio** with an OpenAI-compatible server on port `1234`:

1. **Install & open LM Studio:** Download and install LM Studio from [lmstudio.ai](https://lmstudio.ai/).
2. **Download the model:** Search for and download `google/gemma-4-12b-qat` (or another instruction-tuned model that fits your available RAM/VRAM).
3. **Load the model & start the local server:**
   - Open the **Developer** / **Local Server** tab in LM Studio.
   - Select `google/gemma-4-12b-qat` and load it into memory (adjust context length / GPU offload if needed for smooth local speed).
   - Ensure the local server is running on port `1234` (`http://localhost:1234`).
4. **Verify the exposed model ID:**
   ```bash
   curl -s http://localhost:1234/v1/models
   ```
   Confirm the exact `id` string returned in `data[].id` and match it in `LOCAL_LLM_MODEL` (default: `google/gemma-4-12b-qat`).
5. **Start `server.js` pointing to LM Studio:**
   ```bash
   export LOCAL_LLM_BASE_URL="http://localhost:1234/v1"
   export LOCAL_LLM_MODEL="google/gemma-4-12b-qat"
   export LOCAL_LLM_TIMEOUT_MS="30000"
   node server.js
   ```

*(Prefer **Ollama** instead? Run Ollama locally, set `LOCAL_LLM_BASE_URL="http://localhost:11434/v1"`, and set `LOCAL_LLM_MODEL` to your pulled model tag. If neither local LLM server is running, `utils/aiConfigService.js` logs `[Local LLM Error]` and falls back to topic-aware responses.)*

---

## Coralogix OpenTelemetry setup (optional)

**Coralogix is optional.** Leave `CORALOGIX_API_KEY` unset and everything else works locally (the server prints a startup reminder and serves the app normally). To stream live traces enriched with `ld.context.key`, `ld.context.tier`, `ld.flag.key`, `ld.ai_config.*`, and simulated P99 incident spans into Coralogix:

| Environment Variable | Where to get it |
|---|---|
| `CORALOGIX_API_KEY` | Coralogix: **Data Flow → API Keys → Send-Your-Data Key** |
| `CORALOGIX_OTLP_ENDPOINT` | Coralogix OTLP HTTP ingress for your region (defaults to `https://ingress.ap1.coralogix.in:443/v1/traces`) |
| `PORT` | Optional HTTP server port (defaults to `3000`) |

---

## Pre-requisites
```bash
export PORT=3000
export LAUNCHDARKLY_SDK_KEY=""
export LOCAL_LLM_BASE_URL="http://localhost:1234/v1"
export LOCAL_LLM_MODEL="google/gemma-4-12b-qat"
export LOCAL_LLM_TIMEOUT_MS="30000"
export CORALOGIX_API_KEY=""
export CORALOGIX_OTLP_ENDPOINT="[https://ingress.ap1.coralogix.com:443/v1/traces](https://ingress.ap1.coralogix.com:443/v1/traces)"

node server.js
```

---

## Start over from scratch (instant demo reset)

At any point during a live walkthrough or testing session, press **`Shift + R`** anywhere on the page (outside text inputs or dropdowns):

- Calls `POST /api/demo/reset` to clear any active backend incident state
- Clears browser `localStorage` and `sessionStorage`
- Reloads cleanly back to **Visitor: Rohan (Standard Tier)** on `v1.0`

---

## Demo controls & API endpoints

| Control / Endpoint | What it does |
| :--- | :--- |
| **Persona Switcher** (Top Bar) | Switches active LaunchDarkly context (`Rohan` Standard, `Sarah` QA, `John` VIP Premium) via `ldClient.identify()` and logs local evaluation speed (`<0.1ms`) in DevTools Console. |
| **Get Started Today** button | Fires `ldClient.track('landing-page-conversion', { tier })` and increments the live **Events Tracked** counter badge next to the CTA. |
| **Run AI Cost Optimizer (Beta)** | Appears on `v2.0`; simulates a `2,450ms` P99 latency incident banner and marks `/api/evaluate-flag` OpenTelemetry spans as `ERROR` (`http.latency_ms: 2450`). |
| **AI Release Copilot & Diff Guardrail** | Supports multi-turn chat (`POST /api/ai/config-evaluate`), preset prompts, LM Studio/Ollama inference, and **Before / After Diff Cards** (`POST /api/ai/preview-change`) requiring human approval before applying changes. |
| **`Shift + R`** shortcut | One-keystroke full demo reset (`POST /api/demo/reset` + storage clear + reload). |

---

## Environment assumptions

To ensure anyone cloning this repository can run it cleanly without undocumented steps:

1. **Ports:** Port `3000` is available locally (or overridden via `PORT`); LM Studio defaults to `1234` and Ollama defaults to `11434` if running a local LLM.
2. **Outbound HTTPS:** The browser can reach LaunchDarkly's CDN (`unpkg.com/launchdarkly-js-client-sdk@3`) and LaunchDarkly streaming/event endpoints (`app.launchdarkly.com`, `clientstream.launchdarkly.com`, `events.launchdarkly.com`).
3. **No Database Required:** Demo incident state is held in memory inside `server.js` so there is zero external database setup.
4. **Hard Refresh & Server Restart on Edits:** Node caches `require()` modules until `server.js` is restarted, and browsers cache static files under `public/`—use `Cmd + Shift + R` (macOS) or `Ctrl + Shift + R` (Windows/Linux) after UI changes.

---

## How it fits together

```text
launchdarkly-dev-abc/
├── server.js                  # Express server, OpenTelemetry OTLP exporter, & demo/AI API routes
├── utils/
│   ├── aiConfigService.js     # LaunchDarkly AI Config evaluation, local LLM client, error logs, & fallbacks
│   └── aiGuardrail.js         # Schema validation & before/after diff generator for AI flag commands
├── DEMO_SCRIPT.md             # 5-minute live walkthrough script for SE presentations
├── README.md                  # Setup guide, architecture overview, & environment assumptions
└── public/
    ├── index.html             # Demo control bar, hero card, context inspector, & AI Copilot section
    ├── css/
    │   └── style.css          # v1.0 / v2.0 themes, glassmorphism cards, & alert animations
    └── js/
        ├── demoControls.js    # Demo controls, diff preview card helpers, & Shift + R reset
        └── app.js             # LaunchDarkly JS SDK init, context switching, chat thread, & tracking
```

---

## Learn more (5-minute live walkthrough)

See **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)** for a four-act live presentation flow covering:
1. **Speed & Scale:** Local SDK evaluation (`<0.1ms`) and multi-attribute context targeting (`Rohan` vs. `Sarah` vs. `John`).
2. **Real-Time Streaming & Conversion:** Zero-reload flag toggles (`ldClient.on('change')`) and live `landing-page-conversion` tracking.
3. **Observability & Governance:** Coralogix P99 span correlation, AI Config chat with local LLM, and human-in-the-loop AI Copilot diff approval.
4. **Instant Reset:** Returning to baseline with `Shift + R`.

---

## Where to Replace SDK keys
1. **Server-Side SDK Key (Environment Variable):**
   - Export `LAUNCHDARKLY_SDK_KEY` in your terminal before running `node server.js` (consumed in `server.js` and `utils/aiConfigService.js`).
2. **Client-Side ID (`public/js/app.js`):**
   - Open `public/js/app.js` and replace `CLIENT_SIDE_ID` on line 1 with your LaunchDarkly **`Test`** environment **Client-side ID**:
     ```javascript
     // Replace with your LaunchDarkly environment Client-side ID
     const CLIENT_SIDE_ID = '<YOUR_LAUNCHDARKLY_CLIENT_SIDE_ID>';
     ```

---

### Official LaunchDarkly Documentation Reference

- **SDKs Overview & Feature Matrix:** [LaunchDarkly SDKs Documentation](https://launchdarkly.com/docs/sdk) — covers client-side, server-side, mobile, and edge SDKs, supported languages, and feature parity.
- **Client-Side vs. Server-Side SDKs:** [Choosing an SDK Type](https://launchdarkly.com/docs/sdk/concepts/client-side-server-side) — explains client-side IDs vs. secret SDK keys, flag exposure, and context evaluation.
- **Flag Evaluation Rules:** [Flag Evaluation Rules in Server-Side SDKs](https://launchdarkly.com/docs/sdk/concepts/flag-evaluation-rules) — details prerequisites, individual targets, rule clauses, operators, and default rule fallthrough.
- **AI SDKs:** [LaunchDarkly AI SDKs Documentation](https://launchdarkly.com/docs/sdk/ai) — covers AI Config evaluation, model/prompt management, and metric/trace instrumentation.
- **Flag Triggers:** [LaunchDarkly Flag Triggers](https://launchdarkly.com/docs/home/releases/triggers) and [Flag Triggers REST API](https://launchdarkly.com/docs/api/flag-triggers) — explains remote webhook triggers, generic trigger payloads, and plan availability.