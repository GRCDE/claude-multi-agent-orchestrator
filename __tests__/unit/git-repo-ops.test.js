// Git Repository Operations - Unit Tests
// Testet Git-Operationen mit einem temporaeren Repository

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

describe('Git Repository Operations', () => {
  let git;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
    git = new GitIntegration({
      enabled: true,
      workDir: tempDir,
    });
  });

  afterEach(() => {
    // Temp-Verzeichnis aufraeumen
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  test('initRepo erstellt Git-Repository', async () => {
    await git.initRepo();
    expect(git.isGitRepo(tempDir)).toBe(true);
  });

  test('getCurrentBranch gibt Branch-Namen zurueck', async () => {
    await git.initRepo();
    const branch = git.getCurrentBranch();
    expect(typeof branch).toBe('string');
    expect(branch.length).toBeGreaterThan(0);
  });

  test('getStatus funktioniert auf leerem Repo', async () => {
    await git.initRepo();
    const status = git.getStatus();
    expect(status.ok).toBe(true);
    expect(status).toHaveProperty('branch');
    expect(status).toHaveProperty('clean');
  });

  test('commit erstellt Commit nach Dateiaenderung', async () => {
    await git.initRepo();
    // Datei erstellen
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Hallo Welt');
    const result = git.commit('Test-Commit');
    expect(result.ok).toBe(true);
    expect(result.hash).toBeTruthy();
  });

  test('commit gibt skipped zurueck ohne Aenderungen', async () => {
    await git.initRepo();
    // Erst eine Datei committen
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Hallo');
    git.commit('Initial');
    // Dann nochmal committen ohne Aenderung
    const result = git.commit('Leer');
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test('getLog zeigt Commits', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Test');
    git.commit('Erster Commit');
    const log = git.getLog();
    expect(log.ok).toBe(true);
    expect(log.commits.length).toBeGreaterThanOrEqual(1);
    expect(log.commits[0].message).toContain('Erster Commit');
  });

  test('getCommitDiff zeigt Diff', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Inhalt');
    const commitResult = git.commit('Diff-Test');
    if (commitResult.hash) {
      const diff = git.getCommitDiff(commitResult.hash);
      expect(diff.ok).toBe(true);
      expect(diff.diff).toContain('test.txt');
    }
  });

  test('createProjectBranch erstellt Branch', async () => {
    await git.initRepo();
    // Initial commit noetig fuer Branch
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');
    const branch = git.createProjectBranch('proj-123', 'Test Projekt');
    expect(branch).toBeTruthy();
    expect(branch).toContain('project/');
  });

  test('getBranches listet Branches', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');
    const branches = git.getBranches();
    expect(branches.ok).toBe(true);
    expect(branches.branches.length).toBeGreaterThanOrEqual(1);
  });

  test('checkout wechselt Branch', async () => {
    await git.initRepo();
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init');
    git.commit('Initial');
    git.createProjectBranch('test-1', 'Test');
    const defaultBranch = git.getCurrentBranch();
    // Zurueck zum Haupt-Branch
    const mainBranch = git.getBranches().branches.find(b => !b.name.startsWith('project/'));
    if (mainBranch) {
      const result = git.checkout(mainBranch.name);
      expect(result.ok).toBe(true);
    }
  });

  test('copyMergedFiles kopiert Dateien', async () => {
    await git.initRepo();
    // Quell-Verzeichnis erstellen
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-src-'));
    fs.writeFileSync(path.join(srcDir, 'app.js'), 'console.log("hello");');
    fs.writeFileSync(path.join(srcDir, 'README.md'), '# Test');

    const copied = await git.copyMergedFiles(srcDir);
    expect(copied.length).toBe(2);
    expect(fs.existsSync(path.join(tempDir, 'app.js'))).toBe(true);

    // Aufraeumen
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  test('commitProjectResults fuehrt vollstaendigen Workflow aus', async () => {
    // Quell-Verzeichnis erstellen
    const mergedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-'));
    fs.writeFileSync(path.join(mergedDir, 'output.txt'), 'Ergebnis');

    const result = await git.commitProjectResults(
      'proj-123',
      'Test Projekt',
      mergedDir,
      [{ title: 'Agent 1', status: 'done' }]
    );
    expect(result.ok).toBe(true);
    expect(result.hash).toBeTruthy();

    // Aufraeumen
    fs.rmSync(mergedDir, { recursive: true, force: true });
  });
});
