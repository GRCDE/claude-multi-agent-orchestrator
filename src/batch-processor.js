'use strict';

/**
 * BatchProcessor - Verarbeitet mehrere API-Operationen in einem Request.
 * Nutzt Semaphore für parallele Ausführung mit Begrenzung.
 */
class BatchProcessor {
  /**
   * @param {number} maxOperations - Maximale Anzahl Operationen pro Batch (default: 20)
   * @param {number} timeoutMs - Timeout pro Operation in ms (default: 30000)
   */
  constructor(maxOperations = 20, timeoutMs = 30000) {
    this.maxOperations = maxOperations;
    this.timeoutMs = timeoutMs;
    this.concurrency = 5; // Semaphore: max 5 gleichzeitig

    // Blockliste: gefährliche Endpoints
    this.blockedEndpoints = [
      { method: 'POST', path: '/api/start' },
      { method: 'POST', path: '/api/abort' },
      { method: 'POST', path: '/api/reset' },
    ];

    // Erlaubte Methoden
    this.allowedMethods = ['GET', 'POST', 'PUT', 'DELETE'];

    // Statistiken
    this._stats = {
      totalBatches: 0,
      totalOps: 0,
      totalDurationMs: 0,
    };
  }

  /**
   * Validiert ein Array von Operationen.
   * @param {Array} operations - Array von { id, method, path, body }
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateBatch(operations) {
    const errors = [];

    if (!Array.isArray(operations)) {
      return { valid: false, errors: ['operations muss ein Array sein'] };
    }

    if (operations.length === 0) {
      return { valid: false, errors: ['operations darf nicht leer sein'] };
    }

    if (operations.length > this.maxOperations) {
      return { valid: false, errors: [`Maximal ${this.maxOperations} Operationen pro Batch erlaubt (erhalten: ${operations.length})`] };
    }

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const prefix = `Operation ${i}`;

      if (!op || typeof op !== 'object') {
        errors.push(`${prefix}: muss ein Objekt sein`);
        continue;
      }

      if (!op.id && op.id !== 0) {
        errors.push(`${prefix}: id ist erforderlich`);
      }

      // Methode prüfen
      const method = (op.method || '').toUpperCase();
      if (!this.allowedMethods.includes(method)) {
        errors.push(`${prefix}: Ungültige Methode '${op.method}'. Erlaubt: ${this.allowedMethods.join(', ')}`);
      }

      // Path prüfen
      if (!op.path || typeof op.path !== 'string') {
        errors.push(`${prefix}: path ist erforderlich`);
      } else if (!op.path.startsWith('/api/')) {
        errors.push(`${prefix}: path muss mit /api/ beginnen`);
      }

      // Blockliste prüfen
      if (op.path && method) {
        const blocked = this.blockedEndpoints.find(
          b => b.method === method && op.path === b.path
        );
        if (blocked) {
          errors.push(`${prefix}: ${method} ${op.path} ist blockiert (gefährliche Operation)`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verarbeitet ein Batch von Operationen parallel (mit Semaphore).
   * @param {Array} operations - Array von { id, method, path, body }
   * @param {Function} handler - async (op) => { status, body } - führt einzelne Operation aus
   * @returns {Promise<{ results: Array, totalDuration: number, successCount: number, errorCount: number }>}
   */
  async processBatch(operations, handler) {
    const batchStart = Date.now();
    let running = 0;
    let index = 0;
    const results = new Array(operations.length);

    await new Promise((resolve) => {
      const tryNext = () => {
        // Alle fertig?
        if (index >= operations.length && running === 0) {
          return resolve();
        }

        // Starte neue Operationen bis Semaphore-Limit
        while (running < this.concurrency && index < operations.length) {
          const currentIndex = index++;
          const op = operations[currentIndex];
          running++;

          this._executeOne(op, handler)
            .then((result) => {
              results[currentIndex] = result;
            })
            .catch((err) => {
              results[currentIndex] = {
                id: op.id,
                status: 500,
                body: { error: err.message || 'Interner Fehler' },
                duration: 0,
              };
            })
            .finally(() => {
              running--;
              tryNext();
            });
        }
      };

      tryNext();
    });

    const totalDuration = Date.now() - batchStart;
    let successCount = 0;
    let errorCount = 0;

    for (const r of results) {
      if (r && r.status >= 200 && r.status < 400) {
        successCount++;
      } else {
        errorCount++;
      }
    }

    // Statistiken aktualisieren
    this._stats.totalBatches++;
    this._stats.totalOps += operations.length;
    this._stats.totalDurationMs += totalDuration;

    return { results, totalDuration, successCount, errorCount };
  }

  /**
   * Führt eine einzelne Operation mit Timeout aus.
   */
  async _executeOne(op, handler) {
    const start = Date.now();
    try {
      const result = await Promise.race([
        handler(op),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), this.timeoutMs)
        ),
      ]);
      return {
        id: op.id,
        status: result.status || 200,
        body: result.body,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        id: op.id,
        status: 500,
        body: { error: err.message || 'Unbekannter Fehler' },
        duration: Date.now() - start,
      };
    }
  }

  /**
   * Gibt Batch-Statistiken zurück.
   * @returns {{ totalBatches: number, avgOpsPerBatch: number, avgDurationMs: number }}
   */
  getBatchStats() {
    const totalBatches = this._stats.totalBatches;
    return {
      totalBatches,
      avgOpsPerBatch: totalBatches > 0
        ? Math.round((this._stats.totalOps / totalBatches) * 100) / 100
        : 0,
      avgDurationMs: totalBatches > 0
        ? Math.round(this._stats.totalDurationMs / totalBatches)
        : 0,
      totalOps: this._stats.totalOps,
      totalDurationMs: this._stats.totalDurationMs,
    };
  }
}

module.exports = BatchProcessor;
