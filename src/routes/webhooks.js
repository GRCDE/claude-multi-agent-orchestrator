'use strict';
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fsp = require('fs').promises;

const router = express.Router();

// ── Konstanten ───────────────────────────────────────────────
const WEBHOOKS_FILE = path.join(__dirname, '..', '..', 'webhooks.json');
const MAX_WEBHOOKS = 10;
const WEBHOOK_TIMEOUT = 5000;
const WEBHOOK_RETRY_DELAY = 10000;
const VALID_WEBHOOK_EVENTS = [
  'project-started', 'project-done', 'project-error',
  'agent-done', 'agent-error',
  'plan-created', 'plan-adapted',
  'budget-warning', 'budget-exceeded'
];

// Webhook-Auslieferungsprotokoll (letzte 50 pro Webhook, im RAM)
const webhookDeliveryLog = new Map();
const MAX_DELIVERY_LOG = 50;

function logWebhookDelivery(webhookId, entry) {
  if (!webhookDeliveryLog.has(webhookId)) webhookDeliveryLog.set(webhookId, []);
  const log = webhookDeliveryLog.get(webhookId);
  log.push(entry);
  if (log.length > MAX_DELIVERY_LOG) log.shift();
}

async function loadWebhooks() {
  try {
    const raw = await fsp.readFile(WEBHOOKS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveWebhooks(hooks) {
  await fsp.writeFile(WEBHOOKS_FILE, JSON.stringify(hooks, null, 2), 'utf8');
}

// HMAC-SHA256 Signatur berechnen
function computeWebhookSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Webhook-HTTP-POST senden (mit Timeout)
function sendWebhookRequest(hookUrl, payload, signature) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(hookUrl);
    } catch {
      return reject(new Error('Ungueltige URL'));
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr),
        'X-Webhook-Signature': signature,
        'User-Agent': 'Claude-MultiAgent-Orchestrator/1.0'
      },
      timeout: WEBHOOK_TIMEOUT
    };
    const req = transport.request(options, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout nach 5s')); });
    req.write(payloadStr);
    req.end();
  });
}

// Webhook an alle registrierten Empfaenger dispatchen (async, nicht-blockierend)
async function dispatchWebhooks(eventName, eventData) {
  let hooks;
  try {
    hooks = await loadWebhooks();
  } catch {
    return;
  }

  const logger = router._logger;

  const relevantHooks = hooks.filter(h => h.active !== false && Array.isArray(h.events) && h.events.includes(eventName));
  if (relevantHooks.length === 0) return;

  for (const hook of relevantHooks) {
    (async () => {
      const payload = JSON.stringify({
        event: eventName,
        timestamp: new Date().toISOString(),
        data: eventData,
        signature: ''
      });
      const signature = computeWebhookSignature(payload, hook.secret || '');

      try {
        const statusCode = await sendWebhookRequest(hook.url, payload, signature);
        logWebhookDelivery(hook.id, { timestamp: Date.now(), event: eventName, statusCode, success: statusCode >= 200 && statusCode < 300, error: null });
        if (statusCode >= 200 && statusCode < 300) return;
        throw new Error('HTTP ' + statusCode);
      } catch (firstErr) {
        logWebhookDelivery(hook.id, { timestamp: Date.now(), event: eventName, statusCode: null, success: false, error: firstErr.message });
        // Retry 1x nach 10 Sekunden
        setTimeout(async () => {
          try {
            const retryPayload = JSON.stringify({
              event: eventName,
              timestamp: new Date().toISOString(),
              data: eventData,
              signature: '',
              retry: true
            });
            const retrySignature = computeWebhookSignature(retryPayload, hook.secret || '');
            const statusCode = await sendWebhookRequest(hook.url, retryPayload, retrySignature);
            logWebhookDelivery(hook.id, { timestamp: Date.now(), event: eventName + ' (retry)', statusCode, success: statusCode >= 200 && statusCode < 300, error: null });
          } catch (retryErr) {
            logWebhookDelivery(hook.id, { timestamp: Date.now(), event: eventName + ' (retry)', statusCode: null, success: false, error: retryErr.message });
            if (logger) logger.warn('Webhook Retry fehlgeschlagen', { webhookId: hook.id, event: eventName, error: retryErr.message });
          }
        }, WEBHOOK_RETRY_DELAY);
      }
    })().catch(e => {
      if (logger) logger.warn('Webhook-Dispatch Fehler', { webhookId: hook.id, event: eventName, error: e.message });
    });
  }
}

/**
 * Initialisiert den Webhook-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter }
 */
function init(deps) {
  const { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter } = deps;
  router._logger = logger;

  // ── Legacy: Webhook testen ──────────────────────────────────
  router.post('/test-webhook', authMiddleware, apiLimiter, async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL ist erforderlich' });
    }

    let parsed;
    try {
      parsed = new URL(url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'URL muss mit http:// oder https:// beginnen' });
      }
    } catch {
      return res.status(400).json({ error: 'Ung\u00fcltige URL' });
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({
      event: 'test',
      data: { message: 'Test-Webhook vom Claude Multi-Agent Orchestrator' },
      projectId: null,
      timestamp: new Date().toISOString(),
    });

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    };

    try {
      const statusCode = await new Promise((resolve, reject) => {
        const r = transport.request(options, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        r.on('error', (err) => reject(err));
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout nach 5s')); });
        r.write(payload);
        r.end();
      });
      res.json({ ok: true, statusCode });
    } catch (e) {
      res.status(502).json({ error: 'Webhook fehlgeschlagen: ' + e.message });
    }
  });

  // POST /api/webhooks - Webhook registrieren
  router.post('/webhooks', authMiddleware, apiLimiter, async (req, res) => {
    const { url, events, secret } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL ist erforderlich' });
    }
    let parsed;
    try {
      parsed = new URL(url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'URL muss mit http:// oder https:// beginnen' });
      }
    } catch {
      return res.status(400).json({ error: 'Ungueltige URL' });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'Mindestens ein Event muss ausgewaehlt sein' });
    }
    const invalidEvents = events.filter(e => !VALID_WEBHOOK_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      return res.status(400).json({ error: 'Ungueltige Events: ' + invalidEvents.join(', ') + '. Erlaubt: ' + VALID_WEBHOOK_EVENTS.join(', ') });
    }

    if (!secret || typeof secret !== 'string' || secret.length < 8) {
      return res.status(400).json({ error: 'Secret ist erforderlich (mindestens 8 Zeichen)' });
    }

    try {
      const hooks = await loadWebhooks();
      if (hooks.length >= MAX_WEBHOOKS) {
        return res.status(409).json({ error: 'Maximale Anzahl Webhooks erreicht (max ' + MAX_WEBHOOKS + ')' });
      }
      if (hooks.some(h => h.url === url.trim())) {
        return res.status(409).json({ error: 'Ein Webhook mit dieser URL existiert bereits' });
      }

      const newHook = {
        id: 'wh-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
        url: url.trim(),
        events: events,
        secret: secret,
        active: true,
        createdAt: new Date().toISOString()
      };

      hooks.push(newHook);
      await saveWebhooks(hooks);
      logger.info('Webhook registriert', { id: newHook.id, url: newHook.url, events: newHook.events });

      const safe = { ...newHook, secret: '***' };
      res.json({ ok: true, webhook: safe });
    } catch (e) {
      logger.error('Webhook registrieren fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Webhook konnte nicht gespeichert werden' });
    }
  });

  // GET /api/webhooks - Alle registrierten Webhooks auflisten
  router.get('/webhooks', authMiddleware, apiReadLimiter, async (req, res) => {
    try {
      const hooks = await loadWebhooks();
      const safe = hooks.map(h => ({
        ...h,
        secret: '***',
        deliveries: webhookDeliveryLog.get(h.id) || []
      }));
      res.json(safe);
    } catch (e) {
      logger.error('Webhooks laden fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Webhooks konnten nicht geladen werden' });
    }
  });

  // DELETE /api/webhooks/:id - Webhook loeschen
  router.delete('/webhooks/:id', authMiddleware, apiLimiter, async (req, res) => {
    const whId = req.params.id;
    try {
      const hooks = await loadWebhooks();
      const idx = hooks.findIndex(h => h.id === whId);
      if (idx === -1) {
        return res.status(404).json({ error: 'Webhook nicht gefunden' });
      }
      const removed = hooks.splice(idx, 1)[0];
      await saveWebhooks(hooks);
      webhookDeliveryLog.delete(whId);
      logger.info('Webhook geloescht', { id: whId, url: removed.url });
      res.json({ ok: true, deleted: whId });
    } catch (e) {
      logger.error('Webhook loeschen fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Webhook konnte nicht geloescht werden' });
    }
  });

  // POST /api/webhooks/:id/test - Test-Ping an Webhook senden
  router.post('/webhooks/:id/test', authMiddleware, apiLimiter, async (req, res) => {
    const whId = req.params.id;
    try {
      const hooks = await loadWebhooks();
      const hook = hooks.find(h => h.id === whId);
      if (!hook) {
        return res.status(404).json({ error: 'Webhook nicht gefunden' });
      }

      const payload = JSON.stringify({
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'Test-Ping vom Claude Multi-Agent Orchestrator', webhookId: whId },
        signature: ''
      });
      const signature = computeWebhookSignature(payload, hook.secret || '');

      const statusCode = await sendWebhookRequest(hook.url, payload, signature);
      logWebhookDelivery(whId, { timestamp: Date.now(), event: 'test', statusCode, success: statusCode >= 200 && statusCode < 300, error: null });
      res.json({ ok: true, statusCode });
    } catch (e) {
      logWebhookDelivery(whId, { timestamp: Date.now(), event: 'test', statusCode: null, success: false, error: e.message });
      res.status(502).json({ error: 'Webhook-Test fehlgeschlagen: ' + e.message });
    }
  });

  // POST /api/webhooks/:id/toggle - Webhook aktivieren/deaktivieren
  router.post('/webhooks/:id/toggle', authMiddleware, apiLimiter, async (req, res) => {
    const whId = req.params.id;
    try {
      const hooks = await loadWebhooks();
      const hook = hooks.find(h => h.id === whId);
      if (!hook) {
        return res.status(404).json({ error: 'Webhook nicht gefunden' });
      }
      hook.active = !hook.active;
      await saveWebhooks(hooks);
      logger.info('Webhook ' + (hook.active ? 'aktiviert' : 'deaktiviert'), { id: whId, url: hook.url });
      res.json({ ok: true, active: hook.active });
    } catch (e) {
      res.status(500).json({ error: 'Status konnte nicht geaendert werden' });
    }
  });

  // Orchestrator-Events auf Webhook-Events mappen und dispatchen
  orchestrator.on('phase', (data) => {
    if (data.phase === 'running' && !data.restored && !data.resumed) {
      dispatchWebhooks('project-started', data);
    } else if (data.phase === 'complete') {
      dispatchWebhooks('project-done', data);
    } else if (data.phase === 'error') {
      dispatchWebhooks('project-error', data);
    }
  });

  orchestrator.on('agent', (data) => {
    if (data.status === 'done') {
      dispatchWebhooks('agent-done', data);
    } else if (data.status === 'error') {
      dispatchWebhooks('agent-error', data);
    }
  });

  orchestrator.on('coordinator', (data) => {
    if (data.status === 'ready' && data.tasks) {
      dispatchWebhooks('plan-created', data);
    }
  });

  orchestrator.on('plan-adapted', (data) => {
    dispatchWebhooks('plan-adapted', data);
  });

  orchestrator.on('budget_warning', (data) => {
    if (data.exceeded) {
      dispatchWebhooks('budget-exceeded', data);
    } else {
      dispatchWebhooks('budget-warning', data);
    }
  });
}

module.exports = { router, init, dispatchWebhooks, loadWebhooks, saveWebhooks, computeWebhookSignature, sendWebhookRequest, logWebhookDelivery, webhookDeliveryLog, VALID_WEBHOOK_EVENTS, MAX_WEBHOOKS };
