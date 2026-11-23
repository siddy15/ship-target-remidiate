const { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { evaluateReleaseAIConfig } = require('./utils/aiConfigService');

// Enable debug logging temporarily to verify HTTP 200 export responses from Coralogix
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

const CORALOGIX_API_KEY = process.env.CORALOGIX_API_KEY;
const CORALOGIX_ENDPOINT = process.env.CORALOGIX_OTLP_ENDPOINT || 'https://ingress.ap1.coralogix.in:443/v1/traces';
const CX_APP_NAME = 'abc-company-demo';
const CX_SUBSYSTEM_NAME = 'landing-page-backend';

if (!CORALOGIX_API_KEY) {
  console.warn('WARNING: CORALOGIX_API_KEY is not set! Traces will not authenticate with Coralogix.');
}

const traceExporter = new OTLPTraceExporter({
  url: CORALOGIX_ENDPOINT,
  headers: {
    'Authorization': `Bearer ${CORALOGIX_API_KEY || ''}`,
    'cx-application-name': CX_APP_NAME,
    'cx-subsystem-name': CX_SUBSYSTEM_NAME
  }
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'abc-company-demo-api',
    'cx.application.name': CX_APP_NAME,
    'cx.subsystem.name': CX_SUBSYSTEM_NAME
  }),
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }
    })
  ]
});

sdk.start();
console.log(`OpenTelemetry initialized -> Streaming to ${CORALOGIX_ENDPOINT}`);

const express = require('express');
const path = require('path');
const { generateFlagDiff } = require('./utils/aiGuardrail');

const app = express();
const PORT = process.env.PORT || 3000;

// Track live demo incident state for Coralogix OTel span enrichment
let demoIncidentActive = false;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint injecting LaunchDarkly attributes into Coralogix OTel spans
app.get('/api/evaluate-flag', (req, res) => {
  const span = trace.getActiveSpan();
  const userKey = req.query.userKey || 'user-standard-901';
  const userTier = req.query.tier || 'Standard';
  const flagKey = 'revamped-landing-hero';
  const flagVariation = userTier.toLowerCase() === 'premium' || userKey === 'qa-sarah';

  if (span) {
    span.setAttribute('ld.context.key', userKey);
    span.setAttribute('ld.context.tier', userTier);
    span.setAttribute('ld.flag.key', flagKey);
    span.setAttribute('ld.flag.variation', flagVariation);

    // Enrich Coralogix span with simulated P99 degradation if incident is active
    if (demoIncidentActive && flagVariation) {
      span.setAttribute('http.latency_ms', 2450);
      span.setAttribute('incident.component', 'ai-cost-optimizer');
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'P99 Latency Spike (2450ms) on revamped-landing-hero'
      });
    } else {
      span.setAttribute('http.latency_ms', 38);
      span.setStatus({ code: SpanStatusCode.OK });
    }
  }

  res.json({
    flagKey,
    variation: flagVariation,
    incidentActive: demoIncidentActive,
    evaluatedFor: { userKey, userTier }
  });
});

// Toggle simulated incident state for Coralogix telemetry correlation
app.post('/api/demo/incident', (req, res) => {
  demoIncidentActive = Boolean(req.body.active);
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('demo.incident.triggered', demoIncidentActive);
  }
  res.json({ incidentActive: demoIncidentActive });
});

// AI Copilot Guardrail Endpoint: Generates Diff Preview before execution
app.post('/api/ai/preview-change', (req, res) => {
  const { currentFlagState, aiCommand } = req.body;
  const result = generateFlagDiff(currentFlagState || { enabled: true, rollout: 100 }, aiCommand);

  if (!result.valid) {
    return res.status(400).json(result);
  }

  res.json({
    status: 'pending_approval',
    ...result
  });
});

// One-Click Demo Reset Endpoint
app.post('/api/demo/reset', (req, res) => {
  demoIncidentActive = false;
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('demo.reset', true);
  }
  console.log('[Demo Reset] Incident state cleared and baseline restored.');
  res.json({
    status: 'reset_complete',
    incidentActive: false,
    timestamp: new Date().toISOString()
  });
});

// Dynamic AI Config Metadata Endpoint (avoids triggering full LLM inference on load/switch)
app.get('/api/ai/config-meta', async (req, res) => {
  try {
    const context = {
      kind: 'user',
      key: req.query.userKey || 'user-standard-901',
      name: req.query.name || 'Rohan Verma',
      user_tier: req.query.tier || 'Standard',
      geography: req.query.geography || 'IN'
    };

    const meta = await evaluateReleaseAIConfig(context, '', {
      metadataOnly: true,
      currentFlagState: false,
      incidentActive: demoIncidentActive
    });

    res.json({
      ok: true,
      configKey: meta.configKey,
      model: meta.model,
      variation: meta.variation,
      source: meta.source
    });
  } catch (err) {
    console.error('Error fetching AI Config metadata:', err);
    res.status(500).json({ ok: false, error: 'Failed to load AI Config metadata' });
  }
});

app.post('/api/ai/config-evaluate', async (req, res) => {
  try {
    const { context, prompt, history, currentFlagState, incidentActive } = req.body || {};
    const aiConfigResult = await evaluateReleaseAIConfig(context, prompt || '', {
      history: Array.isArray(history) ? history : [],
      currentFlagState: Boolean(currentFlagState),
      incidentActive: Boolean(incidentActive)
    });

    res.json({
      ok: true,
      ...aiConfigResult,
      aiConfig: aiConfigResult
    });
  } catch (err) {
    console.error('Error evaluating AI Config:', err);
    res.status(500).json({ ok: false, error: 'Failed to evaluate AI Config' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    service: 'abc-company-demo-api',
    status: demoIncidentActive ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`ABC Company Demo running at http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});