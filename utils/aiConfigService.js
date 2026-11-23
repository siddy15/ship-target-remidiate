// utils/aiConfigService.js
const { init } = require('@launchdarkly/node-server-sdk');
const { initAi } = require('@launchdarkly/server-sdk-ai');
const { trace } = require('@opentelemetry/api');

const AI_CONFIG_KEY = process.env.LD_AI_CONFIG_KEY || 'release-copilot-config';
// LM Studio default: http://localhost:1234/v1 | Ollama default: http://localhost:11434/v1
const LOCAL_LLM_BASE_URL = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');
const LOCAL_LLM_MODEL_OVERRIDE = process.env.LOCAL_LLM_MODEL || 'google/gemma-4-12b-qat';
const LOCAL_LLM_TIMEOUT_MS = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 50000;

const DEFAULT_AI_CONFIG = {
  enabled: true,
  model: {
    name: 'google/gemma-4-12b-qat',
    parameters: {
      temperature: 0.2,
      max_tokens: 300
    }
  },
  messages: [
    {
      role: 'system',
      content:
        'You are a concise, risk-aware Release Copilot for ABC Company. Answer release engineering questions conversationally, and recommend safe flag rollouts or kill-switch rollbacks with latency/SLA context.'
    }
  ]
};

let ldServerClient = null;
let ldAiClient = null;
let initPromise = null;

async function getAIClient() {
  const sdkKey = process.env.LAUNCHDARKLY_SDK_KEY;
  if (!sdkKey) return null;

  if (!initPromise) {
    initPromise = (async () => {
      const client = init(sdkKey);
      await client.waitForInitialization({ timeout: 5 });
      ldServerClient = client;
      ldAiClient = initAi(client);
      return ldAiClient;
    })().catch((err) => {
      console.warn('[AI Config] LD Server AI SDK init fallback:', err.message);
      return null;
    });
  }

  return initPromise;
}

function formatLocalLlmError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return `Request timed out after ${LOCAL_LLM_TIMEOUT_MS}ms (12B model may still be loading into memory)`;
  }
  const causeCode = err.cause?.code || err.code;
  if (causeCode) {
    return `${err.message} (${causeCode})`;
  }
  return err.message || String(err);
}

function buildTopicAwareFallback({ cleanPrompt, safeContext, currentFlagState, incidentActive, wantsRollback }) {
  const flagStateLabel = currentFlagState ? 'ON (true)' : 'OFF (false)';

  if (wantsRollback) {
    return `Detected elevated risk for ${safeContext.name} (${safeContext.user_tier}). Recommend setting "revamped-landing-hero" to OFF via the diff guardrail below to protect P99 latency and SLA.`;
  }

  if (/sarah|rohan|john|why|targeting|rule|tier|vip|premium|qa|context/i.test(cleanPrompt)) {
    return `Targeting rules evaluate LaunchDarkly context attributes (such as key and user_tier). Currently viewing ${safeContext.name} (${safeContext.user_tier}, ${safeContext.geography}), where "revamped-landing-hero" is ${flagStateLabel}.`;
  }

  if (/metric|watch|monitor|coralogix|otel|latency|error|25%|rollout|canary/i.test(cleanPrompt)) {
    return `Before expanding rollout to 25%, monitor P99 latency, error/5xx rates, and "landing-page-conversion" events in Coralogix alongside per-tier flag evaluations (currently ${flagStateLabel}).`;
  }

  if (/guardrail|governance|approve|approval|diff|risk|safe|rollback/i.test(cleanPrompt)) {
    return `All flag mutations require human approval via the before/after diff preview before modifying runtime state. Active context: ${safeContext.name} (${safeContext.user_tier}), incident active: ${incidentActive ? 'yes' : 'no'}.`;
  }

  return `Active context is ${safeContext.name} (${safeContext.user_tier}) with "revamped-landing-hero" ${flagStateLabel}. Ask about targeting rules, rollout metrics, governance guardrails, or kill-switch rollback.`;
}

async function queryLocalLLM({ modelName, systemPrompt, history = [], userPrompt, parameters = {} }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_LLM_TIMEOUT_MS);

  const sanitizedHistory = Array.isArray(history)
    ? history
        .filter(
          (msg) =>
            msg &&
            (msg.role === 'user' || msg.role === 'assistant') &&
            typeof msg.content === 'string' &&
            msg.content.trim().length > 0
        )
        .slice(-6)
        .map((msg) => ({ role: msg.role, content: msg.content.trim() }))
    : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...sanitizedHistory,
    { role: 'user', content: userPrompt }
  ];

  const targetModel = LOCAL_LLM_MODEL_OVERRIDE || modelName;
  const endpoint = `${LOCAL_LLM_BASE_URL}/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local-dev'
      },
      body: JSON.stringify({
        model: targetModel,
        messages,
        temperature: parameters.temperature ?? 0.2,
        max_tokens: parameters.max_tokens ?? 300
      }),
      signal: controller.signal
    });

    const rawBody = await response.text();
    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (_) {
      parsedBody = null;
    }

    if (!response.ok) {
      const apiErrMsg = parsedBody?.error?.message || parsedBody?.error || rawBody.slice(0, 200);
      throw new Error(`HTTP ${response.status} from ${endpoint} (model="${targetModel}"): ${apiErrMsg}`);
    }

    const reply = parsedBody?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error(`Empty completion content from ${endpoint} (model="${targetModel}")`);
    }

    return {
      reply,
      resolvedModel: parsedBody?.model || targetModel,
      provider: 'local-llm-live'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function evaluateReleaseAIConfig(context, promptText, options = {}) {
  const activeSpan = trace.getActiveSpan();
  const cleanPrompt = typeof promptText === 'string' ? promptText.trim() : '';
  const history = Array.isArray(options.history) ? options.history : [];

  const safeContext = {
    kind: 'user',
    key: context?.key || 'user-standard-901',
    name: context?.name || 'Rohan Verma',
    user_tier: context?.user_tier || 'Standard',
    geography: context?.geography || 'IN'
  };

  let resolvedConfig = DEFAULT_AI_CONFIG;
  let source = 'local-default-fallback';

  const aiClient = await getAIClient();
  if (aiClient && typeof aiClient.completionConfig === 'function') {
    try {
      const evaluated = await aiClient.completionConfig(
        AI_CONFIG_KEY,
        safeContext,
        DEFAULT_AI_CONFIG,
        { prompt: cleanPrompt, tier: safeContext.user_tier }
      );
      if (evaluated && evaluated.model) {
        resolvedConfig = evaluated;
        source = 'launchdarkly-ai-config';
      }
    } catch (err) {
      console.warn('[AI Config] LaunchDarkly completionConfig fallback:', err.message);
    }
  }

  let modelName = LOCAL_LLM_MODEL_OVERRIDE || resolvedConfig.model?.name || 'google/gemma-4-12b-qat';
  const variationKey =
    resolvedConfig.variationKey ||
    resolvedConfig._ldMeta?.variationKey ||
    (source === 'launchdarkly-ai-config' ? 'ld-configured-variation' : 'default-variation');

  const baseSystemPrompt =
    (resolvedConfig.messages && resolvedConfig.messages[0]?.content) ||
    DEFAULT_AI_CONFIG.messages[0].content;

  const incidentActive = Boolean(options.incidentActive);
  const currentFlagState = Boolean(options.currentFlagState);

  const enrichedSystemPrompt = `${baseSystemPrompt}
Current runtime telemetry:
- Active User: ${safeContext.name} (${safeContext.key}, tier: ${safeContext.user_tier}, geo: ${safeContext.geography})
- Flag "revamped-landing-hero": ${currentFlagState ? 'ON (true)' : 'OFF (false)'}
- Active Incident Alert: ${incidentActive ? 'YES (P99 latency spike 2,450ms)' : 'NO (healthy)'}
Keep responses concise (under 4 sentences) and directly answer the user's question.`;

  const wantsRollback =
    incidentActive ||
    /\b(kill|off|disable|rollback|stop|latency|p99|revert|incident)\b/i.test(cleanPrompt);

  let chatReply = '';
  let inferenceProvider = 'deterministic-fallback';

  try {
    const llmResult = await queryLocalLLM({
      modelName,
      systemPrompt: enrichedSystemPrompt,
      history,
      userPrompt: cleanPrompt,
      parameters: resolvedConfig.model?.parameters
    });
    chatReply = llmResult.reply;
    modelName = llmResult.resolvedModel;
    inferenceProvider = llmResult.provider;
  } catch (err) {
    const formattedErr = formatLocalLlmError(err);
    console.error(`[Local LLM Error] ${formattedErr}`);
    chatReply = buildTopicAwareFallback({
      cleanPrompt,
      safeContext,
      currentFlagState,
      incidentActive,
      wantsRollback
    });
  }

  if (activeSpan) {
    activeSpan.setAttribute('ld.ai_config.key', AI_CONFIG_KEY);
    activeSpan.setAttribute('ld.ai_config.source', source);
    activeSpan.setAttribute('gen_ai.request.model', modelName);
    activeSpan.setAttribute('gen_ai.system', inferenceProvider);
    activeSpan.setAttribute('ld.context.key', safeContext.key);
  }

  const proposedFlagValue = wantsRollback ? false : currentFlagState;
  const requiresApproval = wantsRollback && currentFlagState !== proposedFlagValue;

  return {
    ok: true,
    configKey: AI_CONFIG_KEY,
    variation: variationKey,
    source: `${source} (${inferenceProvider})`,
    enabled: resolvedConfig.enabled !== false,
    model: modelName,
    reply: chatReply,
    summary: chatReply,
    recommendation: {
      actionType: wantsRollback ? 'kill_switch_off' : 'no_flag_mutation',
      flagKey: 'revamped-landing-hero',
      currentValue: currentFlagState,
      proposedValue: proposedFlagValue,
      requiresApproval,
      impactNote: wantsRollback
        ? 'Zero-redeploy rollback; switches impacted traffic back to v1.0 baseline and clears incident alert.'
        : 'Conversational check only; existing flag targeting remains unchanged.'
    }
  };
}

module.exports = {
  evaluateReleaseAIConfig,
  AI_CONFIG_KEY
};