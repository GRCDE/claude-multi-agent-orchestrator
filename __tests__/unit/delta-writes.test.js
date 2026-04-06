// Delta-Writes und djb2Hash - Unit Tests
// Testet Hash-Konsistenz, Kollisionsvermeidung und State-Save-Logik

// djb2Hash exakt wie in orchestrator.js
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
  }
  return hash;
}

describe('djb2Hash', () => {
  test('produziert konsistente Hashes', () => {
    const input = 'Hallo Welt';
    const hash1 = djb2Hash(input);
    const hash2 = djb2Hash(input);
    expect(hash1).toBe(hash2);
  });

  test('gleicher String liefert immer den gleichen Hash', () => {
    const testStrings = [
      '',
      'abc',
      '{"phase":"running","agents":[]}',
      'Ein längerer String mit Umlauten: äöü',
      'A'.repeat(10000),
    ];
    for (const str of testStrings) {
      expect(djb2Hash(str)).toBe(djb2Hash(str));
    }
  });

  test('unterscheidet verschiedene Strings', () => {
    const hashes = new Set([
      djb2Hash('abc'),
      djb2Hash('abd'),
      djb2Hash('bac'),
      djb2Hash('ABC'),
      djb2Hash(''),
      djb2Hash(' '),
      djb2Hash('hello world'),
      djb2Hash('hello  world'),
    ]);
    // Alle Hashes sollten unterschiedlich sein
    expect(hashes.size).toBe(8);
  });

  test('liefert eine Ganzzahl (32-bit Integer)', () => {
    const hash = djb2Hash('test');
    expect(Number.isInteger(hash)).toBe(true);
    // 32-bit Bereich
    expect(hash).toBeGreaterThanOrEqual(-2147483648);
    expect(hash).toBeLessThanOrEqual(2147483647);
  });

  test('leerer String hat definierten Hash', () => {
    const hash = djb2Hash('');
    expect(hash).toBe(5381); // Startwert, kein Zeichen verarbeitet
  });

  test('einzelnes Zeichen', () => {
    // hash = ((5381 << 5) + 5381 + 97) | 0 = (172192 + 5381 + 97) | 0 = 177670
    const hash = djb2Hash('a');
    expect(hash).toBe(177670);
  });
});

describe('_saveState Delta-Write Logik', () => {
  let lastHash = null;
  let writeCount = 0;

  // Simuliert die Delta-Write Logik aus orchestrator.js
  function simulateSaveState(json) {
    const hash = djb2Hash(json);
    if (hash === lastHash) {
      return false; // Übersprungen
    }
    lastHash = hash;
    writeCount++;
    return true; // Geschrieben
  }

  beforeEach(() => {
    lastHash = null;
    writeCount = 0;
  });

  test('ueberspringt bei gleichem Hash', () => {
    const json = '{"phase":"running","agents":[]}';

    const first = simulateSaveState(json);
    expect(first).toBe(true);

    const second = simulateSaveState(json);
    expect(second).toBe(false);

    const third = simulateSaveState(json);
    expect(third).toBe(false);

    expect(writeCount).toBe(1);
  });

  test('schreibt bei geaendertem State', () => {
    simulateSaveState('{"phase":"running"}');
    simulateSaveState('{"phase":"complete"}');
    simulateSaveState('{"phase":"complete","score":80}');

    expect(writeCount).toBe(3);
  });

  test('schreibt erneut wenn State zurueckwechselt', () => {
    const stateA = '{"phase":"running"}';
    const stateB = '{"phase":"planning"}';

    simulateSaveState(stateA); // schreibt
    simulateSaveState(stateB); // schreibt
    simulateSaveState(stateA); // schreibt (wieder anderer Hash)

    expect(writeCount).toBe(3);
  });
});

describe('_saveStateImmediate', () => {
  test('schreibt immer, unabhaengig vom Hash', () => {
    // _saveStateImmediate setzt den Hash NACH dem Schreiben,
    // erzwingt aber immer das Schreiben (kein Hash-Check)
    let writeCount = 0;
    let savedHash = null;

    function simulateSaveImmediate(json) {
      // Kein Hash-Check - immer schreiben
      writeCount++;
      savedHash = djb2Hash(json);
    }

    const json = '{"phase":"running"}';
    simulateSaveImmediate(json);
    simulateSaveImmediate(json); // Schreibt trotzdem!
    simulateSaveImmediate(json); // Schreibt trotzdem!

    expect(writeCount).toBe(3);
    expect(savedHash).toBe(djb2Hash(json));
  });
});
