const { init } = require('@launchdarkly/node-server-sdk');
const { initAi } = require('@launchdarkly/server-sdk-ai');
const { trace } = require('@opentelemetry/api');

const AI_CONFIG_KEY = process.env.LD_AI_CONFIG_KEY || 'release-copilot-config';
// LM Studio default: http://localhost:1234/v1 | Ollama default: http://localhost:11434/v1
const LOCAL_LLM_BASE_URL = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');
const LOCAL_LLM_MODEL_OVERRIDE = process.env.LOCAL_LLM_MODEL || 'qwen/qwen3.5-9b';
const LOCAL_LLM_TIMEOUT_MS = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 120000;

// Used when LaunchDarkly is unavailable or has no matching AI configuration.
const DEFAULT_AI_CONFIG = {
  enabled: true,
  model: {
    name: 'qwen/qwen3.5-9b',
    parameters: {
      temperature: 0.2,
      max_tokens: 1500
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
// Share initialization across concurrent calls so the SDK is initialized only once.
let initPromise = null;
// Coalesce identical concurrent prompts to avoid duplicate local model work.
const inFlightRequests = new Map();

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
      // Allow callers to continue with the local default configuration if LD init fails.
      console.warn('[AI Config] LD Server AI SDK init fallback:', err.message);
      return null;
    });
  }

  return initPromise;
}

function formatLocalLlmError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return `Request timed out after ${LOCAL_LLM_TIMEOUT_MS}ms (${LOCAL_LLM_MODEL_OVERRIDE} may still be loading or reasoning)`;
  }
  const causeCode = err.cause?.code || err.code;
  if (causeCode) {
    return `${err.message} (${causeCode})`;
  }
  return err.message || String(err);
}

// Provide a topic-specific response when the local model cannot be reached.
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
  const targetModel = LOCAL_LLM_MODEL_OVERRIDE || modelName;
  const dedupeKey = `${targetModel}::${userPrompt}`;

  if (inFlightRequests.has(dedupeKey)) {
    return inFlightRequests.get(dedupeKey);
  }

  const requestPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LOCAL_LLM_TIMEOUT_MS);

    // Keep only recent user/assistant turns with usable text; discard system messages from history.
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

    // The current prompt is appended below, so avoid sending it twice if callers included it in history.
    if (
      sanitizedHistory.length > 0 &&
      sanitizedHistory[sanitizedHistory.length - 1].role === 'user' &&
      sanitizedHistory[sanitizedHistory.length - 1].content === userPrompt
    ) {
      sanitizedHistory.pop();
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...sanitizedHistory,
      { role: 'user', content: userPrompt }
    ];

    const endpoint = `${LOCAL_LLM_BASE_URL}/chat/completions`;
    // Keep generation within a useful minimum and a bounded maximum token budget.
    const effectiveMaxTokens = Math.min(Math.max(parameters.max_tokens ?? 1500, 1500), 2048);

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
          max_tokens: effectiveMaxTokens,
          chat_template_kwargs: { enable_thinking: true }
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

      const choiceMsg = parsedBody && parsedBody.choices && parsedBody.choices[0] ? parsedBody.choices[0].message : null;
      const rawContent = choiceMsg?.content?.trim() || '';

      // Some local models return reasoning separately; others wrap it in <think> tags.
      const closedThinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
      const unclosedThinkMatch = !closedThinkMatch ? rawContent.match(/<think>([\s\S]*)$/i) : null;
      const reasoning = (
        choiceMsg?.reasoning_content ||
        closedThinkMatch?.[1] ||
        unclosedThinkMatch?.[1] ||
        ''
      ).trim();

      // Return only the user-facing completion, not any reasoning text embedded in content.
      const reply = rawContent
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/gi, '')
        .trim();

      if (!reply) {
        throw new Error(
          reasoning
            ? `Model spent all ${effectiveMaxTokens} tokens on thinking before producing a final reply`
            : `Empty completion content from ${endpoint} (model="${targetModel}")`
        );
      }

      return {
        reply,
        reasoning,
        resolvedModel: parsedBody?.model || targetModel,
        provider: 'local-llm-live'
      };
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  inFlightRequests.set(dedupeKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    inFlightRequests.delete(dedupeKey);
  }
}

async function evaluateReleaseAIConfig(context, promptText, options = {}) {
  const activeSpan = trace.getActiveSpan();
  const cleanPrompt = typeof promptText === 'string' ? promptText.trim() : '';
  const history = Array.isArray(options.history) ? options.history : [];

  // Fill missing context attributes so both config evaluation and prompts have stable values.
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
      // Configuration evaluation failures should not prevent the local fallback from answering.
      console.warn('[AI Config] LaunchDarkly completionConfig fallback:', err.message);
    }
  }

  let modelName = LOCAL_LLM_MODEL_OVERRIDE || resolvedConfig.model?.name || 'qwen/qwen3.5-9b';
  const variationKey =
    resolvedConfig.variationKey ||
    resolvedConfig._ldMeta?.variationKey ||
    (source === 'launchdarkly-ai-config' ? 'ld-configured-variation' : 'default-variation');

  const baseSystemPrompt =
    (resolvedConfig.messages && resolvedConfig.messages[0] && resolvedConfig.messages[0].content) ||
    DEFAULT_AI_CONFIG.messages[0].content;

  const incidentActive = Boolean(options.incidentActive);
  const currentFlagState = Boolean(options.currentFlagState);

  // Treat incidents and explicit risk/rollback language as recommendations to switch the flag off.
  const wantsRollback =
    incidentActive ||
    /\b(kill|off|disable|rollback|stop|latency|p99|revert|incident)\b/i.test(cleanPrompt);

  const proposedFlagValue = wantsRollback ? false : currentFlagState;
  // Approval is needed only when this recommendation would actually change the current flag value.
  const requiresApproval = wantsRollback && currentFlagState !== proposedFlagValue;

  // Guard: do not invoke LM Studio if prompt is empty (e.g., dropdown change)
  if (!cleanPrompt) {
    return {
      ok: true,
      configKey: AI_CONFIG_KEY,
      variation: variationKey,
      source: `${source} (skipped-empty-prompt)`,
      enabled: resolvedConfig.enabled !== false,
      model: modelName,
      reply: '',
      reasoning: '',
      summary: '',
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

  const enrichedSystemPrompt = `${baseSystemPrompt}
Current runtime telemetry:
- Active User: ${safeContext.name} (${safeContext.key}, tier: ${safeContext.user_tier}, geo: ${safeContext.geography})
- Flag "revamped-landing-hero": ${currentFlagState ? 'ON (true)' : 'OFF (false)'}
- Active Incident Alert: ${incidentActive ? 'YES (P99 latency spike 2,450ms)' : 'NO (healthy)'}
Keep responses concise (under 4 sentences) and directly answer the user's question. Keep your internal thinking brief (under 150 words) and do not draft multiple versions.`;

  let chatReply = '';
  let chatReasoning = '';
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
    chatReasoning = llmResult.reasoning || '';
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

  // Attach configuration and inference details to the active OpenTelemetry span for diagnostics.
  if (activeSpan) {
    activeSpan.setAttribute('ld.ai_config.key', AI_CONFIG_KEY);
    activeSpan.setAttribute('ld.ai_config.source', source);
    activeSpan.setAttribute('gen_ai.request.model', modelName);
    activeSpan.setAttribute('gen_ai.system', inferenceProvider);
    activeSpan.setAttribute('ld.context.key', safeContext.key);
  }

  return {
    ok: true,
    configKey: AI_CONFIG_KEY,
    variation: variationKey,
    source: `${source} (${inferenceProvider})`,
    enabled: resolvedConfig.enabled !== false,
    model: modelName,
    reply: chatReply,
    reasoning: chatReasoning,
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
