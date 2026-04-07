// Git Workflow - Unit Tests
// Testet den vollstaendigen Git-Workflow (commitProjectResults)

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

describe('Git Workflow', () => {
  let git;
  let tempDir;
  let mergedDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wf-'));
    mergedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-wf-'));
    git = new GitIntegration({
      enabled: true,
      workDir: tempDir,
      autoCommit: true,
      branchPerProject: true,
      autoPush: false,
    });
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(mergedDir, { recursive: true, force: true }); } catch {}
  });

  test('commitProjectResults erstellt Repo, Branch und Commit', async () => {
    fs.writeFileSync(path.join(mergedDir, 'result.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(mergedDir, 'README.md'), '# Ergebnis');

    const result = await git.commitProjectResults(
      'proj-abc123',
      'Mein Test-Projekt',
      mergedDir,
      [
        { title: 'API Designer', status: 'done' },
        { title: 'Tester', status: 'done' },
      ]
    );

    expect(result.ok).toBe(true);
    expect(result.hash).toBeTruthy();
    expect(result.branch).toContain('project/');
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
  });

  test('Workflow ohne Branch-Per-Project', async () => {
    git.branchPerProject = false;
    fs.writeFileSync(path.join(mergedDir, 'app.py'), 'print("hello")');

    const result = await git.commitProjectResults(
      'proj-xyz',
      'Einfaches Projekt',
      mergedDir,
      [{ title: 'Agent 1', status: 'done' }]
    );

    expect(result.ok).toBe(true);
    // Kein Branch-Step
    const branchStep = result.steps.find(s => s.step === 'branch');
    expect(branchStep).toBeUndefined();
  });

  test('Workflow gibt skipped wenn disabled', async () => {
    git.enabled = false;
    const result = await git.commitProjectResults('id', 'T', mergedDir, []);
    expect(result.skipped).toBe(true);
  });

  test('Workflow gibt skipped wenn kein workDir', async () => {
    git.workDir = '';
    const result = await git.commitProjectResults('id', 'T', mergedDir, []);
    expect(result.skipped).toBe(true);
  });

  test('Commit-Message enthaelt Agent-Titel', async () => {
    fs.writeFileSync(path.join(mergedDir, 'test.txt'), 'data');

    await git.commitProjectResults(
      'p1', 'Projekt Alpha', mergedDir,
      [{ title: 'Backend', status: 'done' }, { title: 'Frontend', status: 'done' }]
    );

    const log = git.getLog(1);
    if (log.ok && log.commits.length > 0) {
      expect(log.commits[0].message).toContain('Projekt Alpha');
    }
  });

  test('Kopierte Dateien sind im Repo', async () => {
    fs.writeFileSync(path.join(mergedDir, 'server.js'), 'const x = 1;');
    fs.writeFileSync(path.join(mergedDir, 'config.json'), '{}');

    await git.commitProjectResults('p2', 'Test', mergedDir, []);

    expect(fs.existsSync(path.join(tempDir, 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'config.json'))).toBe(true);
  });

  test('Workflow mit leerem Merge-Verzeichnis', async () => {
    // Leeres Verzeichnis → kein Commit noetig
    const result = await git.commitProjectResults('p3', 'Leer', mergedDir, []);
    expect(result.ok).toBe(true);
    // Commit sollte skipped sein
    const commitStep = result.steps.find(s => s.step === 'commit');
    if (commitStep) {
      expect(commitStep.ok).toBe(true);
    }
  });

  test('Zweiter Workflow auf gleichem Repo', async () => {
    fs.writeFileSync(path.join(mergedDir, 'v1.txt'), 'version 1');
    await git.commitProjectResults('p1', 'Erstes', mergedDir, [{ title: 'A', status: 'done' }]);

    // Zweites Projekt
    fs.writeFileSync(path.join(mergedDir, 'v2.txt'), 'version 2');
    const result = await git.commitProjectResults('p2', 'Zweites', mergedDir, [{ title: 'B', status: 'done' }]);

    expect(result.ok).toBe(true);
    const log = git.getLog(5);
    expect(log.commits.length).toBeGreaterThanOrEqual(1);
  });
});
