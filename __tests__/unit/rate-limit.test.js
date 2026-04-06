// Rate-Limit Erkennung - Unit Tests
// Testet ob verschiedene Fehlermeldungen korrekt als Rate-Limit erkannt werden

const RATE_LIMIT_PATTERNS = [
  /overloaded/i, /rate.?limit/i, /too many requests/i,
  /529/, /capacity/i, /try again/i,
];

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some(p => p.test(text));
}

describe('isRateLimited()', () => {
  test.each([
    ['overloaded', true],
    ['OVERLOADED', true],
    ['API is overloaded', true],
    ['rate limit exceeded', true],
    ['rate-limit', true],
    ['Error 529', true],
    ['too many requests', true],
    ['at capacity', true],
    ['try again later', true],
    ['File not found', false],
    ['Normal response with code', false],
    ['', false],
    ['Success', false],
  ])('"%s" → %s', (input, expected) => {
    expect(isRateLimited(input)).toBe(expected);
  });
});
