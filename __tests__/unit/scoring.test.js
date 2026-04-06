// Agent-Scoring und Projekt-Score - Unit Tests
// Testet alle Teil-Scores und die Gesamtberechnung

// Score-Logik exakt wie in orchestrator.js _scoreAgent()
function scoreAgent(agent) {
  // 1. completionScore (0 oder 30)
  const completionScore = (agent.status === 'done') ? 30 : 0;

  // 2. fileScore (0-20)
  const filesCreated = (agent.stats && agent.stats.filesCreated) || 0;
  let fileScore = 0;
  if (filesCreated >= 5) fileScore = 20;
  else if (filesCreated >= 3) fileScore = 15;
  else if (filesCreated >= 2) fileScore = 10;
  else if (filesCreated >= 1) fileScore = 5;

  // 3. qualityScore (0-20)
  const responseLength = (agent.stats && agent.stats.responseLength) || 0;
  const linesOfCode = (agent.stats && agent.stats.linesOfCode) || 0;
  let qualityScore = 0;
  if (responseLength >= 2000) qualityScore += 10;
  else if (responseLength >= 500) qualityScore += 7;
  else if (responseLength >= 100) qualityScore += 3;
  if (linesOfCode >= 100) qualityScore += 10;
  else if (linesOfCode >= 30) qualityScore += 7;
  else if (linesOfCode >= 10) qualityScore += 4;
  else if (linesOfCode >= 1) qualityScore += 2;
  qualityScore = Math.min(20, qualityScore);

  // 4. efficiencyScore (0-15)
  const rounds = agent.rounds || 1;
  let efficiencyScore = 15;
  if (rounds <= 2) efficiencyScore = 15;
  else if (rounds === 3) efficiencyScore = 10;
  else if (rounds === 4) efficiencyScore = 5;
  else efficiencyScore = 0;

  // 5. questionScore (0-15)
  const questions = agent.questions || 0;
  const questionScore = Math.max(0, 15 - (questions * 5));

  const total = completionScore + fileScore + qualityScore + efficiencyScore + questionScore;

  return {
    completion: completionScore,
    file: fileScore,
    quality: qualityScore,
    efficiency: efficiencyScore,
    question: questionScore,
    total,
  };
}

// Projekt-Score exakt wie in orchestrator.js _calculateProjectScore()
function calculateProjectScore(agents) {
  const scoredAgents = agents.filter(a => a.score != null);
  if (scoredAgents.length === 0) return { score: 0, breakdown: null };

  const avgScore = scoredAgents.reduce((sum, a) => sum + a.score, 0) / scoredAgents.length;
  const allDone = agents.every(a => a.status === 'done');
  const doneBonus = allDone ? 10 : 0;
  const errorCount = agents.filter(a => a.status === 'error').length;
  const errorMalus = errorCount * 20;

  const projectScore = Math.max(0, Math.min(100, Math.round(avgScore + doneBonus - errorMalus)));
  return {
    score: projectScore,
    breakdown: {
      averageAgentScore: Math.round(avgScore),
      allDoneBonus: doneBonus,
      errorMalus: -errorMalus,
      errorCount,
    }
  };
}

describe('Agent-Scoring', () => {
  describe('completionScore', () => {
    test('30 Punkte wenn Agent FERTIG (status=done)', () => {
      const scores = scoreAgent({ status: 'done' });
      expect(scores.completion).toBe(30);
    });

    test('0 Punkte wenn Agent nicht fertig', () => {
      expect(scoreAgent({ status: 'running' }).completion).toBe(0);
      expect(scoreAgent({ status: 'error' }).completion).toBe(0);
      expect(scoreAgent({ status: 'waiting' }).completion).toBe(0);
    });
  });

  describe('fileScore', () => {
    test.each([
      [0, 0],
      [1, 5],
      [2, 10],
      [3, 15],
      [4, 15],
      [5, 20],
      [10, 20],
    ])('%d Dateien → %d Punkte', (filesCreated, expected) => {
      const scores = scoreAgent({ status: 'done', stats: { filesCreated } });
      expect(scores.file).toBe(expected);
    });

    test('0 wenn stats fehlen', () => {
      const scores = scoreAgent({ status: 'done' });
      expect(scores.file).toBe(0);
    });
  });

  describe('qualityScore', () => {
    test('basiert auf Output-Laenge', () => {
      expect(scoreAgent({ status: 'done', stats: { responseLength: 50 } }).quality).toBe(0);
      expect(scoreAgent({ status: 'done', stats: { responseLength: 100 } }).quality).toBe(3);
      expect(scoreAgent({ status: 'done', stats: { responseLength: 500 } }).quality).toBe(7);
      expect(scoreAgent({ status: 'done', stats: { responseLength: 2000 } }).quality).toBe(10);
    });

    test('Code-Zeilen addieren sich zur Laenge', () => {
      // 500 responseLength (7) + 30 linesOfCode (7) = 14
      const scores = scoreAgent({
        status: 'done',
        stats: { responseLength: 500, linesOfCode: 30 }
      });
      expect(scores.quality).toBe(14);
    });

    test('wird auf 20 gedeckelt', () => {
      // 2000 responseLength (10) + 100 linesOfCode (10) = 20 (max)
      const scores = scoreAgent({
        status: 'done',
        stats: { responseLength: 2000, linesOfCode: 100 }
      });
      expect(scores.quality).toBe(20);
    });

    test('linesOfCode Stufen', () => {
      expect(scoreAgent({ status: 'done', stats: { linesOfCode: 0 } }).quality).toBe(0);
      expect(scoreAgent({ status: 'done', stats: { linesOfCode: 1 } }).quality).toBe(2);
      expect(scoreAgent({ status: 'done', stats: { linesOfCode: 10 } }).quality).toBe(4);
      expect(scoreAgent({ status: 'done', stats: { linesOfCode: 30 } }).quality).toBe(7);
      expect(scoreAgent({ status: 'done', stats: { linesOfCode: 100 } }).quality).toBe(10);
    });
  });

  describe('efficiencyScore', () => {
    test.each([
      [1, 15],
      [2, 15],
      [3, 10],
      [4, 5],
      [5, 0],
      [10, 0],
    ])('%d Runden → %d Punkte', (rounds, expected) => {
      const scores = scoreAgent({ status: 'done', rounds });
      expect(scores.efficiency).toBe(expected);
    });

    test('Default 1 Runde wenn rounds fehlt', () => {
      const scores = scoreAgent({ status: 'done' });
      expect(scores.efficiency).toBe(15);
    });
  });

  describe('questionScore', () => {
    test.each([
      [0, 15],
      [1, 10],
      [2, 5],
      [3, 0],
      [4, 0],  // Kann nicht negativ werden
      [10, 0],
    ])('%d Fragen → %d Punkte', (questions, expected) => {
      const scores = scoreAgent({ status: 'done', questions });
      expect(scores.question).toBe(expected);
    });
  });

  describe('Gesamt-Score', () => {
    test('Perfekter Agent: done, 5+ Dateien, langer Output, 1 Runde, 0 Fragen', () => {
      const scores = scoreAgent({
        status: 'done',
        rounds: 1,
        questions: 0,
        stats: { filesCreated: 5, responseLength: 2000, linesOfCode: 100 }
      });
      // 30 + 20 + 20 + 15 + 15 = 100
      expect(scores.total).toBe(100);
    });

    test('Schlechtester Agent: nicht fertig, keine Dateien, kein Output, 5+ Runden, 3+ Fragen', () => {
      const scores = scoreAgent({
        status: 'error',
        rounds: 5,
        questions: 3,
        stats: { filesCreated: 0, responseLength: 0, linesOfCode: 0 }
      });
      // 0 + 0 + 0 + 0 + 0 = 0
      expect(scores.total).toBe(0);
    });

    test('Mittlerer Agent', () => {
      const scores = scoreAgent({
        status: 'done',
        rounds: 3,
        questions: 1,
        stats: { filesCreated: 2, responseLength: 500, linesOfCode: 10 }
      });
      // 30 + 10 + 11 + 10 + 10 = 71
      expect(scores.total).toBe(71);
    });
  });
});

describe('Projekt-Score', () => {
  test('0 wenn keine Agents gescored', () => {
    const result = calculateProjectScore([
      { status: 'running' },
      { status: 'waiting' },
    ]);
    expect(result.score).toBe(0);
  });

  test('Durchschnitt der Agent-Scores', () => {
    const result = calculateProjectScore([
      { status: 'done', score: 80 },
      { status: 'done', score: 60 },
    ]);
    // avg=70, allDone=+10, errors=0 → 80
    expect(result.score).toBe(80);
    expect(result.breakdown.averageAgentScore).toBe(70);
  });

  test('Bonus +10 wenn alle Agents done', () => {
    const result = calculateProjectScore([
      { status: 'done', score: 50 },
      { status: 'done', score: 50 },
    ]);
    // avg=50 + 10 bonus = 60
    expect(result.score).toBe(60);
    expect(result.breakdown.allDoneBonus).toBe(10);
  });

  test('Kein Bonus wenn nicht alle done', () => {
    const result = calculateProjectScore([
      { status: 'done', score: 50 },
      { status: 'error', score: 20 },
    ]);
    // avg=35, kein Bonus, 1 error*20 = -20 → 15
    expect(result.score).toBe(15);
    expect(result.breakdown.allDoneBonus).toBe(0);
  });

  test('Malus -20 pro Error-Agent', () => {
    const result = calculateProjectScore([
      { status: 'done', score: 80 },
      { status: 'error', score: 10 },
      { status: 'error', score: 10 },
    ]);
    // avg=33.33→33, kein Bonus, 2*20=40 malus → max(0, 33-40)=0
    expect(result.breakdown.errorMalus).toBe(-40);
    expect(result.breakdown.errorCount).toBe(2);
    expect(result.score).toBe(0); // Kann nicht unter 0 fallen
  });

  test('Score wird auf 0-100 begrenzt', () => {
    // Maximaler Score
    const high = calculateProjectScore([
      { status: 'done', score: 100 },
      { status: 'done', score: 100 },
    ]);
    // avg=100 + 10 bonus = 110 → gecapped auf 100
    expect(high.score).toBe(100);
  });
});
