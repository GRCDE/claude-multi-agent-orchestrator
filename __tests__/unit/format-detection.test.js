// Agenten-Antwort Format-Erkennung - Unit Tests
// Testet ob FRAGE/FERTIG Signalwörter korrekt erkannt werden

function detectAgentFormat(response) {
  const qMatch = response.match(/FRAGE:\s*(.+?)(?:\n|$)/i);
  const isDone = /FERTIG/i.test(response);
  if (qMatch && isDone) return { type: 'question', question: qMatch[1].trim() };
  if (qMatch) return { type: 'question', question: qMatch[1].trim() };
  if (isDone) return { type: 'done' };
  return { type: 'work' };
}

describe('detectAgentFormat()', () => {
  test('erkennt FRAGE', () => {
    const r = detectAgentFormat('Arbeit FRAGE: Was soll ich tun?');
    expect(r.type).toBe('question');
    expect(r.question).toBe('Was soll ich tun?');
  });

  test('erkennt FERTIG', () => {
    expect(detectAgentFormat('Alles erledigt. FERTIG').type).toBe('done');
  });

  test('FRAGE hat Vorrang bei Kombination', () => {
    expect(detectAgentFormat('FRAGE: test?\nFERTIG').type).toBe('question');
  });

  test('erkennt normalen Output', () => {
    expect(detectAgentFormat('Normale Arbeit hier').type).toBe('work');
  });

  test('case insensitive: fertig', () => {
    expect(detectAgentFormat('fertig').type).toBe('done');
  });

  test('case insensitive: frage', () => {
    expect(detectAgentFormat('frage: test?').type).toBe('question');
  });
});
