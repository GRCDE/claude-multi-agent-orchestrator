'use strict';
const express = require('express');
const cors = require('cors');
const path = require('path');
const orchestrator = require('./orchestrator');

const app = express();
const PORT = process.env.PORT || 3131;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE clients ───────────────────────────────────────────────
const clients = new Set();

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

// Forward orchestrator events to all SSE clients
orchestrator.on('update', ({ event, data }) => broadcast(event, data));

// ── SSE endpoint ──────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify(orchestrator.getState())}\n\n`);

  // Keep-alive
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  clients.add(res);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

// ── REST API ──────────────────────────────────────────────────
app.post('/api/start', async (req, res) => {
  const { description, agentCount } = req.body;
  if (!description || !agentCount) {
    return res.status(400).json({ error: 'description und agentCount erforderlich' });
  }
  if (orchestrator.phase === 'running') {
    return res.status(409).json({ error: 'Projekt läuft bereits' });
  }

  res.json({ ok: true, message: 'Projekt gestartet' });

  // Run async (non-blocking)
  orchestrator.start(description, parseInt(agentCount)).catch(e => {
    broadcast('error', { message: e.message });
  });
});

app.get('/api/status', (req, res) => {
  res.json(orchestrator.getState());
});

app.post('/api/reset', (req, res) => {
  orchestrator.reset();
  broadcast('state', orchestrator.getState());
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   Claude Multi-Agent Orchestrator     ║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
  console.log(`  Server läuft: http://localhost:${PORT}`);
  console.log(`  Projekte:     ${path.join(__dirname, 'projects')}`);
  console.log('');
  console.log('  Öffne http://localhost:' + PORT + ' im Browser');
  console.log('');
});
