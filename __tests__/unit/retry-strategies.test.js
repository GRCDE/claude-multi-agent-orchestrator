// Retry-Strategien - Unit Tests
// Testet alle 5 Strategien, Factory, Validierung und Reset

const {
  createRetryStrategy,
  validateConfig,
  STRATEGIES,
  RetryStrategySchema,
  FixedRetry,
  ExponentialBackoff,
  LinearBackoff,
  CircuitBreaker,
  NoRetry,
} = require('../../src/retry-strategies');

// ── Factory-Funktion ─────────────────────────────────────────
describe('createRetryStrategy Factory', () => {
  test('erstellt FixedRetry Strategie', () => {
    const s = createRetryStrategy({ strategy: 'fixed', maxRetries: 3, baseDelay: 1000 });
    expect(s).toBeInstanceOf(FixedRetry);
    expect(s.name).toBe('fixed');
  });

  test('erstellt ExponentialBackoff Strategie', () => {
    const s = createRetryStrategy({ strategy: 'exponential', maxRetries: 5, baseDelay: 2000, maxDelay: 30000 });
    expect(s).toBeInstanceOf(ExponentialBackoff);
    expect(s.name).toBe('exponential');
  });

  test('erstellt LinearBackoff Strategie', () => {
    const s = createRetryStrategy({ strategy: 'linear', maxRetries: 4, baseDelay: 1000 });
    expect(s).toBeInstanceOf(LinearBackoff);
    expect(s.name).toBe('linear');
  });

  test('erstellt CircuitBreaker Strategie', () => {
    const s = createRetryStrategy({ strategy: 'circuit-breaker', maxRetries: 3, circuitThreshold: 5, circuitResetTime: 60000 });
    expect(s).toBeInstanceOf(CircuitBreaker);
    expect(s.name).toBe('circuit-breaker');
  });

  test('erstellt NoRetry Strategie', () => {
    const s = createRetryStrategy({ strategy: 'none' });
    expect(s).toBeInstanceOf(NoRetry);
    expect(s.name).toBe('none');
  });

  test('wirft Fehler bei unbekannter Strategie', () => {
    expect(() => createRetryStrategy({ strategy: 'unknown' }))
      .toThrow(/Unbekannte Retry-Strategie/);
  });

  test('wirft Fehler bei fehlender Config', () => {
    expect(() => createRetryStrategy(null))
      .toThrow(/Config muss ein Objekt sein/);
  });

  test('wirft Fehler bei ungueltigem maxRetries', () => {
    expect(() => createRetryStrategy({ strategy: 'fixed', maxRetries: -1 }))
      .toThrow(/maxRetries/);
  });
});

// ── FixedRetry ───────────────────────────────────────────────
describe('FixedRetry', () => {
  test('shouldRetry gibt true zurueck wenn attempts < maxRetries', () => {
    const s = createRetryStrategy({ strategy: 'fixed', maxRetries: 3 });
    expect(s.shouldRetry(0, new Error('test'))).toBe(true);
    expect(s.shouldRetry(1, new Error('test'))).toBe(true);
    expect(s.shouldRetry(2, new Error('test'))).toBe(true);
    expect(s.shouldRetry(3, new Error('test'))).toBe(false);
  });

  test('getDelay gibt immer baseDelay zurueck', () => {
    const s = createRetryStrategy({ strategy: 'fixed', baseDelay: 5000 });
    expect(s.getDelay(0)).toBe(5000);
    expect(s.getDelay(1)).toBe(5000);
    expect(s.getDelay(5)).toBe(5000);
  });
});

// ── ExponentialBackoff ───────────────────────────────────────
describe('ExponentialBackoff', () => {
  test('getDelay verdoppelt sich ungefaehr (mit Jitter)', () => {
    const s = createRetryStrategy({ strategy: 'exponential', baseDelay: 1000, maxDelay: 100000 });
    // Sammle Durchschnitte
    const avgs = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const samples = [];
      for (let i = 0; i < 50; i++) {
        samples.push(s.getDelay(attempt));
      }
      avgs.push(samples.reduce((a, b) => a + b) / samples.length);
    }
    // Jeder folgende Durchschnitt sollte ~2x sein (30% Toleranz fuer Jitter)
    for (let i = 1; i < avgs.length; i++) {
      const ratio = avgs[i] / avgs[i - 1];
      expect(ratio).toBeGreaterThan(1.4);
      expect(ratio).toBeLessThan(2.8);
    }
  });

  test('getDelay respektiert maxDelay', () => {
    const s = createRetryStrategy({ strategy: 'exponential', baseDelay: 1000, maxDelay: 5000 });
    // Bei attempt=10: 1000*2^10 = 1024000, soll auf 5000 gecapped sein (±20% Jitter)
    const delay = s.getDelay(10);
    expect(delay).toBeLessThanOrEqual(6000); // 5000 * 1.2
  });

  test('shouldRetry gibt false wenn maxRetries erreicht', () => {
    const s = createRetryStrategy({ strategy: 'exponential', maxRetries: 2 });
    expect(s.shouldRetry(0, new Error())).toBe(true);
    expect(s.shouldRetry(1, new Error())).toBe(true);
    expect(s.shouldRetry(2, new Error())).toBe(false);
  });
});

// ── LinearBackoff ────────────────────────────────────────────
describe('LinearBackoff', () => {
  test('getDelay steigt linear', () => {
    const s = createRetryStrategy({ strategy: 'linear', baseDelay: 1000, maxDelay: 50000 });
    expect(s.getDelay(0)).toBe(1000);  // 1000 * (0+1)
    expect(s.getDelay(1)).toBe(2000);  // 1000 * (1+1)
    expect(s.getDelay(2)).toBe(3000);  // 1000 * (2+1)
    expect(s.getDelay(3)).toBe(4000);  // 1000 * (3+1)
  });

  test('getDelay respektiert maxDelay', () => {
    const s = createRetryStrategy({ strategy: 'linear', baseDelay: 1000, maxDelay: 3000 });
    expect(s.getDelay(0)).toBe(1000);
    expect(s.getDelay(1)).toBe(2000);
    expect(s.getDelay(2)).toBe(3000);
    expect(s.getDelay(5)).toBe(3000); // gecapped
  });
});

// ── CircuitBreaker ───────────────────────────────────────────
describe('CircuitBreaker', () => {
  test('oeffnet nach Threshold Fehlern', () => {
    const s = createRetryStrategy({
      strategy: 'circuit-breaker',
      maxRetries: 10,
      circuitThreshold: 3,
      circuitResetTime: 60000,
    });
    expect(s.state).toBe('closed');
    // 3 Fehler: Threshold erreicht
    s.shouldRetry(0, new Error());
    s.shouldRetry(1, new Error());
    const result = s.shouldRetry(2, new Error());
    expect(result).toBe(false);
    expect(s.state).toBe('open');
  });

  test('verweigert Retry wenn Circuit offen ist', () => {
    const s = createRetryStrategy({
      strategy: 'circuit-breaker',
      maxRetries: 10,
      circuitThreshold: 2,
      circuitResetTime: 600000, // lang genug dass es nicht resettet
    });
    // Oeffne den Circuit
    s.shouldRetry(0, new Error());
    s.shouldRetry(1, new Error());
    // Jetzt ist circuit offen
    expect(s.state).toBe('open');
    expect(s.shouldRetry(2, new Error())).toBe(false);
  });

  test('reset setzt Zustand zurueck', () => {
    const s = createRetryStrategy({
      strategy: 'circuit-breaker',
      maxRetries: 10,
      circuitThreshold: 2,
      circuitResetTime: 60000,
    });
    s.shouldRetry(0, new Error());
    s.shouldRetry(1, new Error());
    expect(s.state).toBe('open');

    s.reset();
    expect(s.state).toBe('closed');
    expect(s._failureCount).toBe(0);
  });

  test('wechselt nach resetTime zu half-open', () => {
    const s = createRetryStrategy({
      strategy: 'circuit-breaker',
      maxRetries: 10,
      circuitThreshold: 2,
      circuitResetTime: 1000, // minimum erlaubt
    });
    s.shouldRetry(0, new Error());
    s.shouldRetry(1, new Error());
    expect(s.state).toBe('open');

    // Simuliere dass genug Zeit vergangen ist (mehr als circuitResetTime=1000ms)
    s._circuitOpenedAt = Date.now() - 2000; // 2000ms in der Vergangenheit

    const canRetry = s.shouldRetry(2, new Error());
    expect(canRetry).toBe(true);
    expect(s.state).toBe('half-open');
  });

  test('toJSON enthaelt circuit-spezifische Felder', () => {
    const s = createRetryStrategy({
      strategy: 'circuit-breaker',
      circuitThreshold: 7,
      circuitResetTime: 30000,
    });
    const json = s.toJSON();
    expect(json.strategy).toBe('circuit-breaker');
    expect(json.circuitThreshold).toBe(7);
    expect(json.circuitResetTime).toBe(30000);
    expect(json.state).toBe('closed');
    expect(json.failureCount).toBe(0);
  });
});

// ── NoRetry ──────────────────────────────────────────────────
describe('NoRetry', () => {
  test('shouldRetry gibt immer false zurueck', () => {
    const s = createRetryStrategy({ strategy: 'none' });
    expect(s.shouldRetry(0, new Error())).toBe(false);
    expect(s.shouldRetry(1, new Error())).toBe(false);
  });

  test('getDelay gibt immer 0 zurueck', () => {
    const s = createRetryStrategy({ strategy: 'none' });
    expect(s.getDelay(0)).toBe(0);
    expect(s.getDelay(5)).toBe(0);
  });

  test('maxRetries ist immer 0', () => {
    const s = createRetryStrategy({ strategy: 'none', maxRetries: 10 });
    expect(s.maxRetries).toBe(0);
  });
});

// ── Validierung ──────────────────────────────────────────────
describe('validateConfig', () => {
  test('akzeptiert gueltige Config', () => {
    expect(() => validateConfig({ strategy: 'exponential', maxRetries: 5 })).not.toThrow();
  });

  test('verwirft fehlende strategy', () => {
    expect(() => validateConfig({ maxRetries: 3 })).toThrow(/Unbekannte Retry-Strategie/);
  });

  test('verwirft maxDelay unter Minimum', () => {
    expect(() => validateConfig({ strategy: 'fixed', maxDelay: 500 })).toThrow(/maxDelay/);
  });

  test('verwirft baseDelay ueber Maximum', () => {
    expect(() => validateConfig({ strategy: 'fixed', baseDelay: 999999 })).toThrow(/baseDelay/);
  });
});

// ── STRATEGIES Objekt ────────────────────────────────────────
describe('STRATEGIES Katalog', () => {
  test('enthaelt alle 5 Strategien', () => {
    expect(Object.keys(STRATEGIES)).toEqual(
      expect.arrayContaining(['exponential', 'fixed', 'linear', 'circuit-breaker', 'none'])
    );
    expect(Object.keys(STRATEGIES).length).toBe(5);
  });

  test('jede Strategie hat name und description', () => {
    for (const [key, val] of Object.entries(STRATEGIES)) {
      expect(val.name).toBe(key);
      expect(typeof val.description).toBe('string');
      expect(val.description.length).toBeGreaterThan(0);
    }
  });
});

// ── toJSON / reset ───────────────────────────────────────────
describe('toJSON und reset', () => {
  test('toJSON gibt serialisierbare Config zurueck', () => {
    const s = createRetryStrategy({ strategy: 'exponential', maxRetries: 5, baseDelay: 3000, maxDelay: 20000 });
    const json = s.toJSON();
    expect(json.strategy).toBe('exponential');
    expect(json.maxRetries).toBe(5);
    expect(json.baseDelay).toBe(3000);
    expect(json.maxDelay).toBe(20000);
  });

  test('reset bei FixedRetry wirft keinen Fehler', () => {
    const s = createRetryStrategy({ strategy: 'fixed' });
    expect(() => s.reset()).not.toThrow();
  });
});
