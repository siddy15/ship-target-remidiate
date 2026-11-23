const CLIENT_SIDE_ID = '<Update the client Key>';

const PERSONAS = {
  standard: {
    kind: 'user',
    key: 'user-standard-901',
    name: 'Rohan Verma',
    user_tier: 'Standard',
    geography: 'IN'
  },
  qa: {
    kind: 'user',
    key: 'qa-sarah',
    name: 'Sarah Jenkins',
    user_tier: 'QA',
    geography: 'US'
  },
  premium: {
    kind: 'user',
    key: 'user-vip-505',
    name: 'John Holm',
    user_tier: 'Premium',
    geography: 'AU'
  }
};

let ldClient = null;
let currentContext = PERSONAS.standard;
let localDemoOverride = null;
let trackedEventsCount = 0;
let incidentActive = false;

function getCurrentFlagEnabled() {
  if (localDemoOverride !== null) return Boolean(localDemoOverride);
  if (ldClient) return Boolean(ldClient.variation('revamped-landing-hero', false));
  return false;
}

function updateConversionCounterUI() {
  const badge = document.getElementById('conversion-counter-badge');
  if (badge) {
    badge.textContent = `Events Tracked: ${trackedEventsCount}`;
  }
}

function syncAlertBanner(alertBanner) {
  if (!alertBanner) return;
  if (incidentActive) {
    alertBanner.textContent =
      'Incident Detected: P99 Latency spiked to 2,450ms in AI Cost Optimizer! Toggle flag OFF in LaunchDarkly or use AI Copilot to remediate immediately.';
    alertBanner.classList.remove('hidden');
  } else {
    alertBanner.textContent = '';
    alertBanner.classList.add('hidden');
  }
}

async function initLaunchDarkly() {
  updateConversionCounterUI();
  if (typeof window.refreshAiConfigMeta === 'function') {
    window.refreshAiConfigMeta();
  }

  try {
    ldClient = LDClient.initialize(CLIENT_SIDE_ID, currentContext);
    await ldClient.waitForInitialization();
    console.log('LaunchDarkly client initialized successfully.');
    evaluateAndRender();

    ldClient.on('change', () => {
      localDemoOverride = null;
      incidentActive = false;
      evaluateAndRender();
      if (typeof window.refreshAiConfigMeta === 'function') {
        window.refreshAiConfigMeta();
      }
    });
  } catch (error) {
    console.error('Failed to initialize LaunchDarkly client:', error);
  }
}

function evaluateAndRender() {
  const t0 = performance.now();
  const sdkVariation = ldClient ? ldClient.variation('revamped-landing-hero', false) : false;
  const isRevampedEnabled = localDemoOverride !== null ? localDemoOverride : sdkVariation;
  const evalDurationMs = (performance.now() - t0).toFixed(3);

  console.log(`⚡ [LD Local SDK Evaluation] revamped-landing-hero = ${isRevampedEnabled} in ${evalDurationMs}ms`);
  renderExperience(isRevampedEnabled);

  fetch(`/api/evaluate-flag?userKey=${currentContext.key}&tier=${currentContext.user_tier}`)
    .catch(err => console.error('Error logging span attributes:', err));
}

async function switchPersona() {
  const selectVal = document.getElementById('persona-select').value;
  currentContext = PERSONAS[selectVal];
  localDemoOverride = null;
  incidentActive = false;
  if (typeof window.refreshAiConfigMeta === 'function') {
    window.refreshAiConfigMeta();
  }
  if (ldClient) {
    await ldClient.identify(currentContext);
    evaluateAndRender();
  }
}

function renderExperience(isRevampedEnabled) {
  const hero = document.getElementById('hero-container');
  const badge = document.getElementById('flag-status-badge');
  const versionTag = document.getElementById('version-tag');
  const slaBadge = document.getElementById('sla-badge');
  const title = document.getElementById('hero-title');
  const subtitle = document.getElementById('hero-subtitle');
  const v2Box = document.getElementById('v2-feature-box');
  const betaBtn = document.getElementById('beta-bug-btn');
  const alertBanner = document.getElementById('alert-banner');
  const contextDisplay = document.getElementById('context-display');

  if (contextDisplay) {
    contextDisplay.textContent = JSON.stringify(currentContext, null, 2);
  }

  if (isRevampedEnabled) {
    hero.classList.add('revamped');
    badge.textContent = 'ON (TRUE)';
    badge.className = 'badge badge-on';
    versionTag.textContent = 'REVAMPED EXPERIENCE (v2.0 - PROGRESSIVE ROLLOUT)';
    slaBadge.classList.remove('hidden');
    title.textContent = 'Next-Gen AI Cloud by ABC Company';
    subtitle.textContent = 'Experience 10x faster deployments with zero-downtime progressive delivery powered by LaunchDarkly.';
    v2Box.classList.remove('hidden');
    betaBtn.classList.remove('hidden');
  } else {
    hero.classList.remove('revamped');
    badge.textContent = 'OFF (FALSE)';
    badge.className = 'badge badge-off';
    versionTag.textContent = 'LEGACY EXPERIENCE (v1.0)';
    slaBadge.classList.add('hidden');
    title.textContent = 'Welcome to ABC Company Enterprise Cloud';
    subtitle.textContent = 'Reliable infrastructure for growing teams. Standard deployment pipeline active.';
    v2Box.classList.add('hidden');
    betaBtn.classList.add('hidden');
  }

  syncAlertBanner(alertBanner);
}

function trackConversion() {
  if (ldClient) {
    ldClient.track('landing-page-conversion', { tier: currentContext.user_tier });
  }
  trackedEventsCount += 1;
  updateConversionCounterUI();

  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = `Tracked conversion event "landing-page-conversion" (#${trackedEventsCount}) for ${currentContext.name}!`;
    setTimeout(() => { toast.textContent = ''; }, 4000);
  }
}

async function simulateIncident() {
  incidentActive = true;
  syncAlertBanner(document.getElementById('alert-banner'));

  await fetch('/api/demo/incident', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: true })
  });
  evaluateAndRender();
}

window.triggerAICopilotPreview = async function (promptText) {
  const isKillSwitch = /kill|off|disable|rollback|stop/i.test(promptText);
  const rolloutMatch = promptText.match(/(\d+)\s*%/);
  const targetRollout = isKillSwitch ? 0 : (rolloutMatch ? parseInt(rolloutMatch[1], 10) : 25);

  const currentEnabled = getCurrentFlagEnabled();

  const aiCommand = {
    flagKey: 'revamped-landing-hero',
    enabled: !isKillSwitch,
    rollout: targetRollout,
    reason: promptText
  };

  const response = await fetch('/api/ai/preview-change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentFlagState: { enabled: currentEnabled, rollout: currentEnabled ? 100 : 0 },
      aiCommand
    })
  });

  const data = await response.json();
  if (data.status === 'pending_approval' && typeof window.renderAIDiffCard === 'function') {
    window.renderAIDiffCard('ai-diff-container', data.preview, async () => {
      if (isKillSwitch) {
        await fetch('/api/demo/incident', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: false })
        });
        incidentActive = false;
      }
      localDemoOverride = !isKillSwitch;
      evaluateAndRender();

      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = `AI Copilot applied safe mutation to "revamped-landing-hero" (${isKillSwitch ? 'OFF' : targetRollout + '%'}).`;
        setTimeout(() => { toast.textContent = ''; }, 4000);
      }
    });
  }
};

(function initAiReleaseCopilot() {
  const chatThread = document.getElementById('copilot-chat-thread');
  const promptInput = document.getElementById('copilot-prompt-input');
  const evaluateBtn = document.getElementById('copilot-evaluate-btn');
  const statusBadge = document.getElementById('copilot-status-badge');
  const metaModel = document.getElementById('meta-model');
  const metaVariation = document.getElementById('meta-variation');
  const metaSource = document.getElementById('meta-source');
  const inspectorModelPill = document.getElementById('ai-config-model-pill');

  const diffCard = document.getElementById('copilot-diff-card');
  const summaryEl = document.getElementById('copilot-summary');
  const impactEl = document.getElementById('copilot-impact');
  const currentTextEl = document.getElementById('diff-current-text');
  const proposedTextEl = document.getElementById('diff-proposed-text');
  const approveBtn = document.getElementById('copilot-approve-btn');
  const dismissBtn = document.getElementById('copilot-dismiss-btn');

  if (!promptInput || !evaluateBtn || !diffCard) return;

  let pendingRecommendation = null;
  let chatHistory = [];

  function applyMetadataPills(payload = {}) {
    if (payload.model) {
      if (metaModel) metaModel.textContent = `Model: ${payload.model}`;
      if (inspectorModelPill) inspectorModelPill.textContent = payload.model;
    }
    if (payload.variation && metaVariation) {
      metaVariation.textContent = `Variation: ${payload.variation}`;
    }
    if (payload.source && metaSource) {
      metaSource.textContent = `Source: ${payload.source}`;
    }
  }

  window.refreshAiConfigMeta = async function () {
    try {
      const params = new URLSearchParams({
        userKey: currentContext.key,
        name: currentContext.name,
        tier: currentContext.user_tier,
        geography: currentContext.geography
      });
      const res = await fetch(`/api/ai/config-meta?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        applyMetadataPills(data);
      }
    } catch (_) {
      // Non-blocking metadata refresh
    }
  };

  function appendChatBubble(role, text) {
    if (!chatThread || !text) return;

    const bubble = document.createElement('div');
    bubble.style.padding = '8px 12px';
    bubble.style.borderRadius = '8px';
    bubble.style.fontSize = '13px';
    bubble.style.lineHeight = '1.45';
    bubble.style.maxWidth = '85%';
    bubble.style.whiteSpace = 'pre-wrap';

    if (role === 'user') {
      bubble.style.alignSelf = 'flex-end';
      bubble.style.background = '#1e3a8a';
      bubble.style.color = '#ffffff';
    } else {
      bubble.style.alignSelf = 'flex-start';
      bubble.style.background = '#ffffff';
      bubble.style.color = '#0f172a';
      bubble.style.border = '1px solid #cbd5e1';
    }

    bubble.textContent = text;
    chatThread.appendChild(bubble);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function renderDiffCard(payload) {
    const rec = payload.recommendation || {};
    pendingRecommendation = rec;

    applyMetadataPills(payload);
    if (statusBadge) {
      statusBadge.textContent = rec.requiresApproval ? 'Diff Ready (Approval Needed)' : 'Replied';
    }

    const assistantMessage = payload.reply || payload.summary || payload.advisoryNote || '';
    summaryEl.textContent = assistantMessage;
    impactEl.textContent = rec.impactNote || '';

    currentTextEl.textContent = `${rec.flagKey || 'revamped-landing-hero'}: ${rec.currentValue ? 'ON (true)' : 'OFF (false)'}`;
    proposedTextEl.textContent = `${rec.flagKey || 'revamped-landing-hero'}: ${rec.proposedValue ? 'ON (true)' : 'OFF (false)'}`;

    if (rec.requiresApproval) {
      approveBtn.classList.remove('hidden');
      diffCard.classList.remove('hidden');
    } else {
      approveBtn.classList.add('hidden');
      diffCard.classList.add('hidden');
    }
  }

  async function runCopilotPreview(promptText) {
    const trimmed = (promptText || '').trim();
    if (!trimmed) return;

    appendChatBubble('user', trimmed);
    promptInput.value = '';
    statusBadge.textContent = 'Thinking...';
    evaluateBtn.disabled = true;

    try {
      const response = await fetch('/api/ai/config-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: currentContext,
          prompt: trimmed,
          history: chatHistory,
          currentFlagState: getCurrentFlagEnabled(),
          incidentActive
        })
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Evaluation failed');
      }

      const assistantReply = data.reply || data.summary || data.advisoryNote || 'Done.';
      appendChatBubble('assistant', assistantReply);

      chatHistory.push({ role: 'user', content: trimmed });
      chatHistory.push({ role: 'assistant', content: assistantReply });
      if (chatHistory.length > 12) {
        chatHistory = chatHistory.slice(-12);
      }

      renderDiffCard(data);
    } catch (err) {
      const errMsg = err.message || 'Could not evaluate AI Config.';
      statusBadge.textContent = 'Evaluation Error';
      appendChatBubble('assistant', `Error: ${errMsg}`);
      approveBtn.classList.add('hidden');
      diffCard.classList.add('hidden');
    } finally {
      evaluateBtn.disabled = false;
      promptInput.focus();
    }
  }

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset') || '';
      runCopilotPreview(preset);
    });
  });

  evaluateBtn.addEventListener('click', () => {
    runCopilotPreview(promptInput.value);
  });

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCopilotPreview(promptInput.value);
    }
  });

  approveBtn.addEventListener('click', async () => {
    if (!pendingRecommendation || !pendingRecommendation.requiresApproval) return;

    localDemoOverride = Boolean(pendingRecommendation.proposedValue);
    if (!pendingRecommendation.proposedValue) {
      incidentActive = false;
      await fetch('/api/demo/incident', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      }).catch(() => {});
    }

    evaluateAndRender();
    statusBadge.textContent = 'Applied';
    approveBtn.classList.add('hidden');

    const confirmationText = `Applied guardrail change: ${pendingRecommendation.flagKey} set to ${pendingRecommendation.proposedValue ? 'ON (true)' : 'OFF (false)'}.`;
    summaryEl.textContent = confirmationText;
    appendChatBubble('assistant', confirmationText);
  });

  dismissBtn.addEventListener('click', () => {
    pendingRecommendation = null;
    diffCard.classList.add('hidden');
    statusBadge.textContent = 'Dismissed';
  });
})();

window.addEventListener('DOMContentLoaded', initLaunchDarkly);
