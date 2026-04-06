// Exponential Backoff Delay - Unit Tests
// Testet Berechnung, exponentielles Wachstum, Max-Cap und Jitter

const MAX_BACKOFF_MS = 60000;

// calcBackoffDelay exakt wie in orchestrator.js
function calcBackoffDelay(baseDelay, attempt) {
  const exponential = baseDelay * Math.pow(2, attempt);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  // Jitter: ±20% um Thundering-Herd-Effekt zu vermeiden
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

describe('calcBackoffDelay', () => {
  test('berechnet korrekt fuer Basis-Faelle', () => {
    // Bei baseDelay=1000, attempt=0: 1000 * 2^0 = 1000, ±20% → 800-1400
    const delay = calcBackoffDelay(1000, 0);
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(1400);
  });

  test('Delay steigt exponentiell', () => {
    const baseDelay = 1000;
    // Sammle Mittelwerte über mehrere Durchläufe
    const averages = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const samples = [];
      for (let i = 0; i < 100; i++) {
        samples.push(calcBackoffDelay(baseDelay, attempt));
      }
      averages.push(samples.reduce((a, b) => a + b) / samples.length);
    }

    // Jeder Durchschnitt sollte ungefähr doppelt so hoch wie der vorherige sein
    // (mit Toleranz wegen Jitter)
    for (let i = 1; i < averages.length; i++) {
      // Vor dem Cap: Faktor ~2 (mit 30% Toleranz)
      if (averages[i] < MAX_BACKOFF_MS * 0.8) {
        const ratio = averages[i] / averages[i - 1];
        expect(ratio).toBeGreaterThan(1.4);
        expect(ratio).toBeLessThan(2.6);
      }
    }
  });

  test('Max-Cap bei 60 Sekunden', () => {
    // Sehr hoher attempt: 1000 * 2^20 = weit über 60s
    for (let i = 0; i < 50; i++) {
      const delay = calcBackoffDelay(1000, 20);
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS * 1.2); // 60s + 20% Jitter
      expect(delay).toBeGreaterThanOrEqual(MAX_BACKOFF_MS * 0.8); // 60s - 20% Jitter
    }
  });

  test('Jitter ist im erwarteten Bereich (±20%)', () => {
    const baseDelay = 5000;
    const attempt = 2;
    const expectedBase = baseDelay * Math.pow(2, attempt); // 20000
    const minExpected = Math.round(expectedBase * 0.8);    // 16000
    const maxExpected = Math.round(expectedBase * 1.2);    // 24000

    // 200 Samples pruefen
    for (let i = 0; i < 200; i++) {
      const delay = calcBackoffDelay(baseDelay, attempt);
      expect(delay).toBeGreaterThanOrEqual(minExpected);
      expect(delay).toBeLessThanOrEqual(maxExpected);
    }
  });

  test('Jitter sorgt fuer Varianz (nicht immer gleicher Wert)', () => {
    const delays = new Set();
    for (let i = 0; i < 20; i++) {
      delays.add(calcBackoffDelay(1000, 3));
    }
    // Bei 20 Samples sollten mindestens 5 verschiedene Werte rauskommen
    expect(delays.size).toBeGreaterThanOrEqual(5);
  });

  test('attempt=0 liefert ungefaehr baseDelay', () => {
    const baseDelay = 5000;
    // 5000 * 2^0 = 5000, ±20% → 4000-6000
    for (let i = 0; i < 50; i++) {
      const delay = calcBackoffDelay(baseDelay, 0);
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThanOrEqual(6000);
    }
  });

  test('gibt immer eine gerundete Ganzzahl zurueck', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = calcBackoffDelay(1234, attempt);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  test('Konkrete Exponential-Werte (vor Jitter)', () => {
    // Prüfe die erwarteten Basis-Werte: baseDelay * 2^attempt
    const baseDelay = 1000;
    const expectedBases = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    //                       ^0    ^1    ^2    ^3     ^4     ^5     ^6(cap) ^7(cap)

    for (let attempt = 0; attempt < expectedBases.length; attempt++) {
      const base = expectedBases[attempt];
      const minDelay = Math.round(base * 0.8);
      const maxDelay = Math.round(base * 1.2);

      for (let i = 0; i < 20; i++) {
        const delay = calcBackoffDelay(baseDelay, attempt);
        expect(delay).toBeGreaterThanOrEqual(minDelay);
        expect(delay).toBeLessThanOrEqual(maxDelay);
      }
    }
  });
});
