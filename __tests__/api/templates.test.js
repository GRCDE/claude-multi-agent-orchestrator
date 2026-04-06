// Templates API - Tests
// Testet GET /api/templates Endpoint

'use strict';
const http = require('http');

const TEST_PORT = 3202;

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

describe('GET /api/templates', () => {
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

  test('gibt Templates und TaskPresets zurueck', async () => {
    const res = await request('GET', '/api/templates');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('templates');
    expect(res.body).toHaveProperty('taskPresets');
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(Array.isArray(res.body.taskPresets)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThan(0);
    expect(res.body.taskPresets.length).toBeGreaterThan(0);
  });

  test('jedes Template hat erforderliche Felder', async () => {
    const res = await request('GET', '/api/templates');
    expect(res.status).toBe(200);

    for (const template of res.body.templates) {
      expect(template).toHaveProperty('id');
      expect(template).toHaveProperty('name');
      expect(template).toHaveProperty('description');
      expect(template).toHaveProperty('suggestedAgents');
      expect(typeof template.id).toBe('string');
      expect(typeof template.name).toBe('string');
      expect(typeof template.description).toBe('string');
      expect(typeof template.suggestedAgents).toBe('number');
    }
  });

  test('suggestedAgents ist eine positive Zahl', async () => {
    const res = await request('GET', '/api/templates');
    for (const template of res.body.templates) {
      expect(template.suggestedAgents).toBeGreaterThanOrEqual(1);
    }
  });

  test('jeder TaskPreset hat erforderliche Felder', async () => {
    const res = await request('GET', '/api/templates');
    for (const preset of res.body.taskPresets) {
      expect(preset).toHaveProperty('id');
      expect(preset).toHaveProperty('name');
      expect(preset).toHaveProperty('task');
      expect(typeof preset.id).toBe('string');
      expect(typeof preset.name).toBe('string');
      expect(typeof preset.task).toBe('string');
    }
  });
});
