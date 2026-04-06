'use strict';

const BatchProcessor = require('../../src/batch-processor');

describe('BatchProcessor Unit Tests', () => {
  let bp;

  beforeEach(() => {
    bp = new BatchProcessor(20, 30000);
  });

  // ── validateBatch Tests ──────────────────────────────────────

  test('validateBatch akzeptiert gültige Operationen', () => {
    const ops = [
      { id: '1', method: 'GET', path: '/api/status', body: null },
      { id: '2', method: 'POST', path: '/api/config', body: { key: 'value' } },
      { id: '3', method: 'PUT', path: '/api/roles/1', body: { name: 'test' } },
      { id: '4', method: 'DELETE', path: '/api/templates/1', body: null },
    ];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('validateBatch blockt POST /api/start', () => {
    const ops = [{ id: '1', method: 'POST', path: '/api/start', body: {} }];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('blockiert');
  });

  test('validateBatch blockt POST /api/abort', () => {
    const ops = [{ id: '1', method: 'POST', path: '/api/abort', body: null }];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('blockiert');
  });

  test('validateBatch blockt POST /api/reset', () => {
    const ops = [{ id: '1', method: 'POST', path: '/api/reset', body: null }];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('blockiert');
  });

  test('validateBatch lehnt mehr als maxOperations ab', () => {
    const ops = Array.from({ length: 21 }, (_, i) => ({
      id: String(i), method: 'GET', path: '/api/status', body: null,
    }));
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Maximal 20');
  });

  test('validateBatch lehnt ungültige Methode ab', () => {
    const ops = [{ id: '1', method: 'PATCH', path: '/api/status', body: null }];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Ungültige Methode');
  });

  test('validateBatch lehnt ungültigen Path ab (nicht /api/)', () => {
    const ops = [{ id: '1', method: 'GET', path: '/health', body: null }];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('/api/');
  });

  test('validateBatch lehnt leeres Array ab', () => {
    const result = bp.validateBatch([]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('leer');
  });

  test('validateBatch lehnt Nicht-Array ab', () => {
    const result = bp.validateBatch('nicht-array');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Array');
  });

  test('validateBatch lehnt fehlende id ab', () => {
    const ops = [{ method: 'GET', path: '/api/status' }];
    const result = bp.validateBatch(ops);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('id');
  });

  // ── processBatch Tests ───────────────────────────────────────

  test('processBatch verarbeitet alle Operationen', async () => {
    const ops = [
      { id: '1', method: 'GET', path: '/api/status', body: null },
      { id: '2', method: 'GET', path: '/api/health', body: null },
    ];

    const handler = jest.fn(async (op) => ({
      status: 200,
      body: { ok: true, path: op.path },
    }));

    const result = await bp.processBatch(ops, handler);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].id).toBe('1');
    expect(result.results[0].status).toBe(200);
    expect(result.results[1].id).toBe('2');
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('processBatch: Fehler in einer Op stoppt nicht die anderen', async () => {
    const ops = [
      { id: '1', method: 'GET', path: '/api/status', body: null },
      { id: '2', method: 'GET', path: '/api/fail', body: null },
      { id: '3', method: 'GET', path: '/api/health', body: null },
    ];

    const handler = jest.fn(async (op) => {
      if (op.path === '/api/fail') {
        throw new Error('Simulierter Fehler');
      }
      return { status: 200, body: { ok: true } };
    });

    const result = await bp.processBatch(ops, handler);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].status).toBe(200);
    expect(result.results[1].status).toBe(500);
    expect(result.results[1].body.error).toContain('Simulierter Fehler');
    expect(result.results[2].status).toBe(200);
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(1);
  });

  test('processBatch misst duration pro Operation', async () => {
    const ops = [{ id: '1', method: 'GET', path: '/api/status', body: null }];

    const handler = async () => {
      await new Promise(r => setTimeout(r, 50));
      return { status: 200, body: {} };
    };

    const result = await bp.processBatch(ops, handler);
    expect(result.results[0].duration).toBeGreaterThanOrEqual(40);
  });

  // ── getBatchStats Tests ──────────────────────────────────────

  test('getBatchStats gibt Null-Werte bei keinen Batches', () => {
    const stats = bp.getBatchStats();
    expect(stats.totalBatches).toBe(0);
    expect(stats.avgOpsPerBatch).toBe(0);
    expect(stats.avgDurationMs).toBe(0);
  });

  test('getBatchStats zaehlt korrekt nach processBatch', async () => {
    const ops1 = [
      { id: '1', method: 'GET', path: '/api/status', body: null },
      { id: '2', method: 'GET', path: '/api/health', body: null },
    ];
    const ops2 = [
      { id: '3', method: 'GET', path: '/api/status', body: null },
    ];

    const handler = async () => ({ status: 200, body: {} });

    await bp.processBatch(ops1, handler);
    await bp.processBatch(ops2, handler);

    const stats = bp.getBatchStats();
    expect(stats.totalBatches).toBe(2);
    expect(stats.totalOps).toBe(3);
    expect(stats.avgOpsPerBatch).toBe(1.5);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Konstruktor Tests ────────────────────────────────────────

  test('Konstruktor setzt Standard-Werte', () => {
    const defaultBp = new BatchProcessor();
    expect(defaultBp.maxOperations).toBe(20);
    expect(defaultBp.timeoutMs).toBe(30000);
    expect(defaultBp.concurrency).toBe(5);
  });

  test('Konstruktor akzeptiert benutzerdefinierte Werte', () => {
    const customBp = new BatchProcessor(10, 5000);
    expect(customBp.maxOperations).toBe(10);
    expect(customBp.timeoutMs).toBe(5000);
  });
});
