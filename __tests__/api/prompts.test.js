// Prompts API - Tests
// Testet GET /api/prompts, POST /api/prompts und POST /api/prompts/reset Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3205;

function request(method, urlPath, body = null) {
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
    if (body) req.write(JSON.stringify(body));
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

describe('Prompts API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];

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
  });

  test('GET /api/prompts gibt Prompts und Variablen zurueck', async () => {
    const res = await request('GET', '/api/prompts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('prompts');
    expect(res.body).toHaveProperty('variables');
    expect(res.body.prompts).toHaveProperty('coordinator_plan');
    expect(res.body.prompts).toHaveProperty('coordinator_answer');
    expect(res.body.prompts).toHaveProperty('coordinator_summary');
    expect(res.body.prompts).toHaveProperty('agent_system');
    expect(res.body.variables.coordinator_plan).toContain('agentCount');
    expect(res.body.variables.coordinator_plan).toContain('description');
    expect(res.body.variables.agent_system).toContain('task');
  });

  test('POST /api/prompts aktualisiert einzelnes Template', async () => {
    const newPlan = 'Test prompt {agentCount} agents for {description}';
    const res = await request('POST', '/api/prompts', { coordinator_plan: newPlan });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.prompts.coordinator_plan).toBe(newPlan);

    // Verifiziere dass der Wert persistiert
    const check = await request('GET', '/api/prompts');
    expect(check.body.prompts.coordinator_plan).toBe(newPlan);
  });

  test('POST /api/prompts lehnt leere Strings ab', async () => {
    const res = await request('POST', '/api/prompts', { coordinator_plan: '' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/nicht-leerer String/);
  });

  test('POST /api/prompts lehnt unbekannte Keys ab', async () => {
    const res = await request('POST', '/api/prompts', { unknown_key: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unbekanntes Prompt-Template/);
  });

  test('POST /api/prompts lehnt nicht-String-Werte ab', async () => {
    const res = await request('POST', '/api/prompts', { coordinator_plan: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nicht-leerer String/);
  });

  test('POST /api/prompts/reset stellt Standardwerte wieder her', async () => {
    // Zuerst aendern
    await request('POST', '/api/prompts', { coordinator_plan: 'Modified prompt' });

    // Dann zuruecksetzen
    const res = await request('POST', '/api/prompts/reset');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.prompts).toHaveProperty('coordinator_plan');
    // Sollte nicht mehr 'Modified prompt' sein
    expect(res.body.prompts.coordinator_plan).not.toBe('Modified prompt');
    expect(res.body.prompts.coordinator_plan).toMatch(/Koordinator/);
  });

  test('POST /api/prompts aktualisiert mehrere Templates gleichzeitig', async () => {
    const res = await request('POST', '/api/prompts', {
      coordinator_plan: 'Plan: {description}',
      coordinator_summary: 'Summary: {agentResults}'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.prompts.coordinator_plan).toBe('Plan: {description}');
    expect(res.body.prompts.coordinator_summary).toBe('Summary: {agentResults}');

    // Aufraeumen
    await request('POST', '/api/prompts/reset');
  });
});
