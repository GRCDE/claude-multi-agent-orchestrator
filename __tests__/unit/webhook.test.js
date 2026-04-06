// Webhook - Unit Tests
// Testet _sendWebhook Verhalten (no-op, Fehlerresilienz, Payload)

'use strict';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const http = require('http');
const Orchestrator = require('../../orchestrator');

describe('_sendWebhook()', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('tut nichts wenn WEBHOOK_URL nicht gesetzt', async () => {
    // Soll ohne Fehler durchlaufen und nichts tun
    await expect(orch._sendWebhook('test_event', { foo: 'bar' })).resolves.toBeUndefined();
  });

  test('crasht nicht bei Netzwerkfehler', async () => {
    // Setze eine URL die nicht erreichbar ist
    orch.updateConfig({ webhookUrl: 'http://127.0.0.1:19999/webhook-that-does-not-exist' });
    // _sendWebhook fängt alle Fehler intern ab
    await expect(orch._sendWebhook('test_event', { foo: 'bar' })).resolves.toBeUndefined();
  });

  test('sendet korrektes Payload-Format', async () => {
    // Lokalen HTTP-Server starten der den Payload aufzeichnet
    let receivedBody = null;

    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', d => data += d);
      req.on('end', () => {
        receivedBody = JSON.parse(data);
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    orch.updateConfig({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    orch.projectId = 'proj_test123';

    await orch._sendWebhook('project_started', { title: 'Test Projekt' });

    // Kurz warten damit der Server die Anfrage verarbeiten kann
    await new Promise(r => setTimeout(r, 100));
    server.close();

    expect(receivedBody).not.toBeNull();
    expect(receivedBody.event).toBe('project_started');
    expect(receivedBody.data).toEqual({ title: 'Test Projekt' });
    expect(receivedBody.projectId).toBe('proj_test123');
    expect(receivedBody).toHaveProperty('timestamp');
    // Timestamp muss ein ISO-String sein
    expect(new Date(receivedBody.timestamp).toISOString()).toBe(receivedBody.timestamp);
  });
});
