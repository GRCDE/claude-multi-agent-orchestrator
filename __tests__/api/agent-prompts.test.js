// Agent Prompts API - Tests
// Testet GET /api/agent-prompts/:id/:agentIndex Endpoint

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3209;

function request(method, urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

describe('Agent Prompts API', () => {
  const projectsDir = path.join(__dirname, '..', '..', 'projects');
  const testProjectId = 'proj_test_prompts_api';
  const testAgentDir = path.join(projectsDir, testProjectId, 'agent-1');
  const promptsFile = path.join(testAgentDir, 'prompts.jsonl');

  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];

    // Test-Daten erstellen
    fs.mkdirSync(testAgentDir, { recursive: true });
    const lines = [
      JSON.stringify({ round: 1, prompt: 'Test prompt 1', response: 'Test response 1', ts: '2026-04-06T10:00:00.000Z' }),
      JSON.stringify({ round: 2, prompt: 'Test prompt 2', response: 'Test response 2', ts: '2026-04-06T10:01:00.000Z' }),
    ];
    fs.writeFileSync(promptsFile, lines.join('\n') + '\n');

    try {
      require('../../server');
      setTimeout(done, 500);
    } catch (e) {
      done(e);
    }
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
    // Test-Daten aufraumen
    try {
      fs.rmSync(path.join(projectsDir, testProjectId), { recursive: true, force: true });
    } catch {}
  });

  test('Gibt 404 fuer nicht-existierendes Projekt zurueck', async () => {
    const res = await request('GET', '/api/agent-prompts/proj_nonexistent_xyz/0');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  test('Gibt 404 fuer nicht-existierenden Agent zurueck', async () => {
    const res = await request('GET', `/api/agent-prompts/${testProjectId}/99`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  test('Blockiert Path-Traversal im Projekt-ID', async () => {
    const res = await request('GET', '/api/agent-prompts/..%2F..%2Fetc/0');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('Blockiert Path-Traversal im Agent-Index', async () => {
    const res = await request('GET', '/api/agent-prompts/proj_test/../../../etc/0');
    // Should be 400 or 404, not a successful response with data from outside projects/
    expect([400, 404]).toContain(res.status);
  });

  test('Gibt Prompt-Log-Eintraege korrekt zurueck', async () => {
    const res = await request('GET', `/api/agent-prompts/${testProjectId}/0`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const entry = res.body[0];
    expect(entry).toHaveProperty('round', 1);
    expect(entry).toHaveProperty('prompt', 'Test prompt 1');
    expect(entry).toHaveProperty('response', 'Test response 1');
    expect(entry).toHaveProperty('ts', '2026-04-06T10:00:00.000Z');
    expect(entry).toHaveProperty('promptTokens');
    expect(entry).toHaveProperty('responseTokens');
    expect(typeof entry.promptTokens).toBe('number');
    expect(typeof entry.responseTokens).toBe('number');
  });

  test('Gibt 400 fuer negativen Agent-Index zurueck', async () => {
    const res = await request('GET', `/api/agent-prompts/${testProjectId}/-1`);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
