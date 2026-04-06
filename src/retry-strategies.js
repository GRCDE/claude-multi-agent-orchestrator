'use strict';

// ── Retry-Strategie Schema ───────────────────────────────────
const STRATEGIES = {
  exponential: {
    name: 'exponential',
    description: 'Exponential Backoff mit Jitter – verdoppelt die Wartezeit nach jedem Fehlversuch',
  },
  fixed: {
    name: 'fixed',
    description: 'Feste Wartezeit zwischen Retries',
  },
  linear: {
    name: 'linear',
    description: 'Linear steigende Wartezeit zwischen Retries',
  },
  'circuit-breaker': {
    name: 'circuit-breaker',
    description: 'Circuit Breaker – nach N Fehlern für M Sekunden komplett stoppen',
  },
  none: {
    name: 'none',
    description: 'Kein Retry – Fehler sofort melden',
  },
};

const RetryStrategySchema = {
  strategy: { type: 'string', enum: Object.keys(STRATEGIES), required: true },
  maxRetries: { type: 'number', min: 0, max: 20, default: 3 },
  baseDelay: { type: 'number', min: 100, max: 120000, default: 2000 },
  maxDelay: { type: 'number', min: 1000, max: 300000, default: 30000 },
  circuitThreshold: { type: 'number', min: 1, max: 50, default: 5 },
  circuitResetTime: { type: 'number', min: 1000, max: 600000, default: 60000 },
};

// ── Basis-Klasse ─────────────────────────────────────────────
class BaseRetryStrategy {
  constructor(config) {
    this.maxRetries = config.maxRetries != null ? config.maxRetries : 3;
    this.baseDelay = config.baseDelay || 2000;
    this.maxDelay = config.maxDelay || 30000;
  }

  get name() { return 'base'; }

  shouldRetry(attempt, _error) {
    return attempt < this.maxRetries;
  }

  getDelay(_attempt) {
    return this.baseDelay;
  }

  reset() {
    // Kein Zustand in der Basis-Klasse
  }

  toJSON() {
    return {
      strategy: this.name,
      maxRetries: this.maxRetries,
      baseDelay: this.baseDelay,
      maxDelay: this.maxDelay,
    };
  }
}

// ── FixedRetry ───────────────────────────────────────────────
class FixedRetry extends BaseRetryStrategy {
  get name() { return 'fixed'; }

  getDelay(_attempt) {
    return this.baseDelay;
  }
}

// ── ExponentialBackoff ───────────────────────────────────────
class ExponentialBackoff extends BaseRetryStrategy {
  get name() { return 'exponential'; }

  getDelay(attempt) {
    const exponential = this.baseDelay * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.maxDelay);
    // Jitter: ±20%
    const jitter = capped * (0.8 + Math.random() * 0.4);
    return Math.round(jitter);
  }
}

// ── LinearBackoff ────────────────────────────────────────────
class LinearBackoff extends BaseRetryStrategy {
  get name() { return 'linear'; }

  getDelay(attempt) {
    const linear = this.baseDelay * (attempt + 1);
    return Math.min(linear, this.maxDelay);
  }
}

// ── CircuitBreaker ───────────────────────────────────────────
class CircuitBreaker extends BaseRetryStrategy {
  constructor(config) {
    super(config);
    this.circuitThreshold = config.circuitThreshold || 5;
    this.circuitResetTime = config.circuitResetTime || 60000;
    this._failureCount = 0;
    this._circuitOpenedAt = null;
    this._state = 'closed'; // closed | open | half-open
  }

  get name() { return 'circuit-breaker'; }

  get state() { return this._state; }

  shouldRetry(attempt, _error) {
    // Im offenen Zustand: prüfe ob Reset-Zeit abgelaufen
    if (this._state === 'open') {
      const elapsed = Date.now() - this._circuitOpenedAt;
      if (elapsed >= this.circuitResetTime) {
        this._state = 'half-open';
        return true; // Einen Versuch erlauben
      }
      return false; // Circuit ist offen, kein Retry
    }

    // Im half-open Zustand: genau ein Versuch erlaubt (durch shouldRetry=true oben)
    // Wenn dieser auch fehlschlägt, wird circuit wieder geöffnet via recordFailure

    this._failureCount++;

    if (this._failureCount >= this.circuitThreshold) {
      this._state = 'open';
      this._circuitOpenedAt = Date.now();
      return false; // Circuit öffnet sich, kein Retry mehr
    }

    return attempt < this.maxRetries;
  }

  getDelay(attempt) {
    if (this._state === 'half-open') {
      return this.baseDelay;
    }
    // Exponential Backoff innerhalb des geschlossenen Zustands
    const exponential = this.baseDelay * Math.pow(2, attempt);
    return Math.min(exponential, this.maxDelay);
  }

  reset() {
    this._failureCount = 0;
    this._circuitOpenedAt = null;
    this._state = 'closed';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      strategy: 'circuit-breaker',
      circuitThreshold: this.circuitThreshold,
      circuitResetTime: this.circuitResetTime,
      state: this._state,
      failureCount: this._failureCount,
    };
  }
}

// ── NoRetry ──────────────────────────────────────────────────
class NoRetry extends BaseRetryStrategy {
  constructor(config) {
    super(config);
    this.maxRetries = 0;
  }

  get name() { return 'none'; }

  shouldRetry(_attempt, _error) {
    return false;
  }

  getDelay(_attempt) {
    return 0;
  }
}

// ── Factory ──────────────────────────────────────────────────
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Retry-Strategie Config muss ein Objekt sein');
  }
  if (!config.strategy || !STRATEGIES[config.strategy]) {
    throw new Error(`Unbekannte Retry-Strategie: '${config.strategy}'. Erlaubt: ${Object.keys(STRATEGIES).join(', ')}`);
  }
  for (const [key, schema] of Object.entries(RetryStrategySchema)) {
    if (key === 'strategy') continue;
    if (config[key] != null) {
      const val = Number(config[key]);
      if (!Number.isFinite(val)) {
        throw new Error(`${key} muss eine Zahl sein`);
      }
      if (val < schema.min || val > schema.max) {
        throw new Error(`${key} muss zwischen ${schema.min} und ${schema.max} liegen`);
      }
    }
  }
  // Circuit-Breaker spezifische Validierung
  if (config.strategy === 'circuit-breaker') {
    if (config.circuitThreshold != null && config.circuitThreshold < 1) {
      throw new Error('circuitThreshold muss mindestens 1 sein');
    }
    if (config.circuitResetTime != null && config.circuitResetTime < 1000) {
      throw new Error('circuitResetTime muss mindestens 1000ms sein');
    }
  }
  return true;
}

function createRetryStrategy(config) {
  validateConfig(config);

  const normalizedConfig = {
    maxRetries: config.maxRetries != null ? config.maxRetries : RetryStrategySchema.maxRetries.default,
    baseDelay: config.baseDelay || RetryStrategySchema.baseDelay.default,
    maxDelay: config.maxDelay || RetryStrategySchema.maxDelay.default,
    circuitThreshold: config.circuitThreshold || RetryStrategySchema.circuitThreshold.default,
    circuitResetTime: config.circuitResetTime || RetryStrategySchema.circuitResetTime.default,
  };

  switch (config.strategy) {
    case 'fixed':
      return new FixedRetry(normalizedConfig);
    case 'exponential':
      return new ExponentialBackoff(normalizedConfig);
    case 'linear':
      return new LinearBackoff(normalizedConfig);
    case 'circuit-breaker':
      return new CircuitBreaker(normalizedConfig);
    case 'none':
      return new NoRetry(normalizedConfig);
    default:
      throw new Error(`Unbekannte Retry-Strategie: '${config.strategy}'`);
  }
}

module.exports = {
  createRetryStrategy,
  validateConfig,
  STRATEGIES,
  RetryStrategySchema,
  // Klassen exportieren für Tests
  FixedRetry,
  ExponentialBackoff,
  LinearBackoff,
  CircuitBreaker,
  NoRetry,
  BaseRetryStrategy,
};
