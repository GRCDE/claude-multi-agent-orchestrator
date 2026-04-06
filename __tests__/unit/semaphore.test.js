// Semaphore für parallele Agenten-Ausführung - Unit Tests
// Testet Concurrency-Begrenzung, acquire/release, Getter und Edge Cases

// Semaphore exakt wie in orchestrator.js (mit Clamping und Gettern)
class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Math.min(10, max));
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.queue.shift()();
    }
  }
  get running() { return this.current; }
  get waiting() { return this.queue.length; }
}

describe('Semaphore', () => {
  test('respektiert max concurrency', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.current).toBe(2);

    // Dritter Aufruf blockiert
    let blocked = true;
    const p = sem.acquire().then(() => { blocked = false; });
    await new Promise(r => setTimeout(r, 50));
    expect(blocked).toBe(true);
    expect(sem.current).toBe(2);

    sem.release();
    await p;
    expect(blocked).toBe(false);
  });

  test('acquire() wartet wenn max erreicht', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const timestamps = [];
    const start = Date.now();

    // Zweiter acquire muss warten
    const p = sem.acquire().then(() => {
      timestamps.push(Date.now() - start);
    });

    // Warte 100ms, dann release
    await new Promise(r => setTimeout(r, 100));
    sem.release();
    await p;

    // Der wartende acquire sollte erst nach ~100ms durchgekommen sein
    expect(timestamps[0]).toBeGreaterThanOrEqual(80);
  });

  test('release() lässt wartenden durch (FIFO)', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const order = [];

    const p1 = sem.acquire().then(() => order.push('A'));
    const p2 = sem.acquire().then(() => order.push('B'));
    const p3 = sem.acquire().then(() => order.push('C'));

    // Jeder release lässt genau einen durch
    sem.release(); await p1;
    expect(order).toEqual(['A']);

    sem.release(); await p2;
    expect(order).toEqual(['A', 'B']);

    sem.release(); await p3;
    expect(order).toEqual(['A', 'B', 'C']);
  });

  test('Getter running zeigt aktive Slots korrekt', async () => {
    const sem = new Semaphore(3);
    expect(sem.running).toBe(0);

    await sem.acquire();
    expect(sem.running).toBe(1);

    await sem.acquire();
    expect(sem.running).toBe(2);

    sem.release();
    expect(sem.running).toBe(1);

    sem.release();
    expect(sem.running).toBe(0);
  });

  test('Getter waiting zeigt wartende korrekt', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    expect(sem.waiting).toBe(0);

    // Drei wartende
    const p1 = sem.acquire();
    expect(sem.waiting).toBe(1);

    const p2 = sem.acquire();
    expect(sem.waiting).toBe(2);

    const p3 = sem.acquire();
    expect(sem.waiting).toBe(3);

    // Release reduziert wartende
    sem.release(); await p1;
    expect(sem.waiting).toBe(2);

    sem.release(); await p2;
    expect(sem.waiting).toBe(1);

    sem.release(); await p3;
    expect(sem.waiting).toBe(0);
  });

  test('Edge case: release ohne vorheriges acquire', () => {
    const sem = new Semaphore(2);
    // Sollte nicht crashen, aber current wird negativ
    sem.release();
    expect(sem.current).toBe(-1);
    expect(sem.running).toBe(-1);
  });

  test('max wird auf 1-10 geclampt', () => {
    const semLow = new Semaphore(0);
    expect(semLow.max).toBe(1);

    const semNeg = new Semaphore(-5);
    expect(semNeg.max).toBe(1);

    const semHigh = new Semaphore(100);
    expect(semHigh.max).toBe(10);

    const semNormal = new Semaphore(5);
    expect(semNormal.max).toBe(5);
  });

  test('Stress-Test: 20 Tasks mit Semaphore(3)', async () => {
    const sem = new Semaphore(3);
    let maxConcurrent = 0;
    let current = 0;
    const tasks = Array.from({ length: 20 }, () =>
      (async () => {
        await sem.acquire();
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise(r => setTimeout(r, 10));
        current--;
        sem.release();
      })()
    );
    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(current).toBe(0);
    expect(sem.running).toBe(0);
    expect(sem.waiting).toBe(0);
  });
});
