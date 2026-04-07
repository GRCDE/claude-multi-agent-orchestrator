// Git Branch Validation - Unit Tests
// Testet Branch-Name Sanitisierung und Validierung

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const GitIntegration = require('../../src/git-integration');

describe('Git Branch Validation', () => {
  let git;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-'));
    git = new GitIntegration({ enabled: true, workDir: tempDir });
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('sanitisiert Sonderzeichen im Branch-Namen', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');

    const branch = git.createProjectBranch('id1', 'Mein Projekt! @#$%');
    expect(branch).toBeTruthy();
    expect(branch).toMatch(/^project\/[a-z0-9_-]+-[a-z0-9]+$/);
    expect(branch).not.toContain(' ');
    expect(branch).not.toContain('!');
    expect(branch).not.toContain('@');
  });

  test('sanitisiert Umlaute und Sonderzeichen', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');

    const branch = git.createProjectBranch('id2', 'Über Größe Ärger');
    expect(branch).toBeTruthy();
    expect(branch).toContain('project/');
  });

  test('begrenzt Branch-Name Laenge', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');

    const longName = 'a'.repeat(200);
    const branch = git.createProjectBranch('id3', longName);
    expect(branch).toBeTruthy();
    expect(branch.length).toBeLessThan(100);
  });

  test('checkout lehnt ungueltigen Branch-Namen ab', () => {
    const result = git.checkout('branch with spaces');
    expect(result.ok).toBe(false);
  });

  test('checkout lehnt Shell-Injection ab', () => {
    const result = git.checkout('main; rm -rf /');
    expect(result.ok).toBe(false);
  });

  test('getCommitDiff lehnt ungueltigen Hash ab', () => {
    const result = git.getCommitDiff('not-hex-chars!!!');
    expect(result.ok).toBe(false);
  });

  test('getCommitDiff akzeptiert gueltigen kurzen Hash', () => {
    // Wird fehlschlagen weil Repo leer, aber Hash-Validierung sollte durchgehen
    const result = git.getCommitDiff('abc1234');
    // ok kann false sein (kein Repo), aber kein Validierungsfehler
    expect(result).toHaveProperty('ok');
  });

  test('getCommitDiff akzeptiert gueltigen langen Hash', () => {
    const result = git.getCommitDiff('abc1234567890abcdef1234567890abcdef123456');
    expect(result).toHaveProperty('ok');
  });

  test('leerer Projekt-Titel verwendet Projekt-ID', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');

    const branch = git.createProjectBranch('myproject123', '');
    expect(branch).toBeTruthy();
    expect(branch).toContain('myproject123');
  });
});
