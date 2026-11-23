// public/js/demoControls.js

// 1. Global Shift + R Shortcut for One-Click Demo Reset
window.addEventListener('keydown', async (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

  if (e.shiftKey && e.key === 'R') {
    e.preventDefault();
    try {
      await fetch('/api/demo/reset', { method: 'POST' });
    } catch (err) {
      console.warn('Reset API call failed, clearing client state:', err);
    }
    localStorage.clear();
    sessionStorage.clear();
    window.location.reload();
  }
});

// Helper to render active LaunchDarkly AI Config metadata above the diff card
window.renderAIConfigBadge = function (containerId, aiConfigData) {
  const container = document.getElementById(containerId);
  if (!container || !aiConfigData) return;

  const existing = container.querySelector('.ai-config-meta');
  if (existing) existing.remove();

  const meta = document.createElement('div');
  meta.className = 'ai-config-meta';
  meta.style.cssText = `
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(14, 116, 144, 0.16);
    border: 1px solid rgba(56, 189, 248, 0.35);
    color: #e0f2fe;
    font-size: 0.76rem;
    line-height: 1.4;
  `;

  meta.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:3px;">
      <strong>AI Config: <code>${aiConfigData.configKey || 'release-copilot-config'}</code></strong>
      <span style="background:rgba(56,189,248,0.18); color:#7dd3fc; padding:1px 6px; border-radius:999px; font-family:monospace; font-size:0.68rem;">
        ${aiConfigData.model || 'gpt-4o-mini'}
      </span>
    </div>
    <div style="color:#bae6fd; font-size:0.72rem;">
      Source: <code>${aiConfigData.source || 'local-default-fallback'}</code>
    </div>
  `;

  container.appendChild(meta);
};

// 2. Render Visual Diff Preview Card inside the AI Copilot Drawer
window.renderAIDiffCard = function (containerId, diffData, onApplyCallback) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const existing = container.querySelector('.ai-diff-card');
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.className = 'ai-diff-card';
  card.style.cssText = `
    border: 1px solid #6366f1;
    padding: 12px;
    border-radius: 8px;
    background: #1e1b4b;
    color: #f8fafc;
    margin-top: 8px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 0.85rem;
  `;

  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
      <strong>Proposed Flag Mutation</strong>
      <span style="background:#4338ca; padding:2px 8px; border-radius:999px; font-size:0.7rem;">Diff Guardrail</span>
    </div>
    <div style="margin-bottom:6px; color:#cbd5e1;">Target: <code>${diffData.flagKey}</code></div>
    <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:8px;">"${diffData.reason}"</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; background:#0f172a; padding:8px; border-radius:6px; font-family:monospace; font-size:0.78rem; margin-bottom:10px;">
      <div>
        <div style="color:#94a3b8;">CURRENT</div>
        <div style="color:#f87171;">enabled: ${diffData.before.enabled}</div>
        <div style="color:#f87171;">rollout: ${diffData.before.rollout}%</div>
      </div>
      <div>
        <div style="color:#94a3b8;">PROPOSED</div>
        <div style="color:#4ade80;">enabled: ${diffData.after.enabled}</div>
        <div style="color:#4ade80;">rollout: ${diffData.after.rollout}%</div>
      </div>
    </div>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="cancel-ai-diff-btn" style="background:transparent; color:#94a3b8; border:1px solid #475569; padding:5px 10px; border-radius:4px; cursor:pointer;">Cancel</button>
      <button id="apply-ai-diff-btn" style="background:#4f46e5; color:#fff; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-weight:600;">Apply Changes</button>
    </div>
  `;

  container.appendChild(card);

  card.querySelector('#cancel-ai-diff-btn').onclick = () => card.remove();
  card.querySelector('#apply-ai-diff-btn').onclick = async () => {
    const btn = card.querySelector('#apply-ai-diff-btn');
    btn.disabled = true;
    btn.textContent = 'Applying...';
    await onApplyCallback();
    card.innerHTML = `<div style="color:#4ade80; font-weight:600;">Change verified & applied for <code>${diffData.flagKey}</code>!</div>`;
  };
};

// 3. Self-contained Floating AI Release Copilot Widget (Zero HTML edits required)
window.addEventListener('DOMContentLoaded', () => {
  const widget = document.createElement('div');
  widget.id = 'ai-copilot-widget';
  widget.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; width: 360px; z-index: 9999;
    background: #0f172a; color: #f8fafc; border: 1px solid #334155;
    border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.4);
    font-family: system-ui, -apple-system, sans-serif; overflow: hidden;
  `;

  widget.innerHTML = `
    <div id="ai-copilot-header" style="background:#1e293b; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
      <span style="font-weight:600; font-size:0.9rem;">AI Release Copilot <span style="font-size:0.7rem; color:#38bdf8;">(Guardrailed)</span></span>
      <span id="ai-copilot-toggle" style="font-size:0.8rem; color:#94a3b8;">▼</span>
    </div>
    <div id="ai-copilot-body" style="padding:12px;">
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px;">
        <button class="ai-chip" data-prompt="Trip kill switch for revamped-landing-hero due to P99 latency spike" style="background:#1e293b; color:#f87171; border:1px solid #7f1d1d; padding:4px 8px; border-radius:6px; font-size:0.72rem; cursor:pointer;">
          Trip Kill Switch
        </button>
        <button class="ai-chip" data-prompt="Roll out revamped-landing-hero to 25% of beta users" style="background:#1e293b; color:#38bdf8; border:1px solid #0369a1; padding:4px 8px; border-radius:6px; font-size:0.72rem; cursor:pointer;">
          25% Progressive Rollout
        </button>
      </div>
      <div style="display:flex; gap:6px;">
        <input id="ai-prompt-input" type="text" placeholder="Ask AI to manage flags..." style="flex:1; background:#1e293b; border:1px solid #334155; color:#fff; padding:6px 10px; border-radius:6px; font-size:0.82rem;" />
        <button id="ai-send-btn" style="background:#4f46e5; color:#fff; border:none; padding:6px 12px; border-radius:6px; font-size:0.82rem; cursor:pointer;">Preview</button>
      </div>
      <div id="ai-diff-container"></div>
    </div>
  `;

  document.body.appendChild(widget);

  // Collapse/expand toggle
  const header = document.getElementById('ai-copilot-header');
  const body = document.getElementById('ai-copilot-body');
  const toggleIcon = document.getElementById('ai-copilot-toggle');
  header.onclick = () => {
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    toggleIcon.textContent = isHidden ? '▼' : '▲';
  };

  // Quick prompt chips
  widget.querySelectorAll('.ai-chip').forEach(chip => {
    chip.onclick = () => {
      document.getElementById('ai-prompt-input').value = chip.dataset.prompt;
      document.getElementById('ai-send-btn').click();
    };
  });

  // Preview command handler: evaluates AI Config first, then triggers diff preview
  document.getElementById('ai-send-btn').onclick = async () => {
    const promptText = document.getElementById('ai-prompt-input').value.trim();
    if (!promptText) return;

    const activeCtx = window.currentContext || {
      kind: 'user',
      key: 'user-standard-901',
      name: 'Rohan Verma',
      user_tier: 'Standard',
      geography: 'IN'
    };

    try {
      const aiConfigRes = await fetch('/api/ai/config-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: activeCtx, prompt: promptText })
      });
      if (aiConfigRes.ok) {
        const aiConfigPayload = await aiConfigRes.json();
        if (aiConfigPayload.ok && aiConfigPayload.aiConfig) {
          window.renderAIConfigBadge('ai-diff-container', aiConfigPayload.aiConfig);
        }
      }
    } catch (err) {
      console.warn('AI Config evaluation skipped:', err.message);
    }

    if (typeof window.triggerAICopilotPreview === 'function') {
      window.triggerAICopilotPreview(promptText);
    }
  };
});