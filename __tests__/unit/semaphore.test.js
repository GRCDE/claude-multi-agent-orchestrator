// Semaphore für parallele Agenten-Ausführung - Unit Tests
// Testet Concurrency-Begrenzung, FIFO-Reihenfolge und Stress-Szenarien

class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  async acquire() {
    if (this.count < this.max) { this.count++; return; }
    await new Promise(r => this.queue.push(r));
    this.count++;
  }
  release() { this.count--; if (this.queue.length) this.queue.shift()(); }
}

describe('Semaphore', () => {
  test('erlaubt max N gleichzeitig', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.count).toBe(2);
    // Dritter würde blockieren
    let blocked = true;
    const p = sem.acquire().then(() => { blocked = false; });
    await new Promise(r => setTimeout(r, 50));
    expect(blocked).toBe(true);
    sem.release();
    await p;
    expect(blocked).toBe(false);
  });

  test('FIFO Reihenfolge', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const order = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    sem.release(); await p1;
    sem.release(); await p2;
    expect(order).toEqual([1, 2]);
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
  });
});
