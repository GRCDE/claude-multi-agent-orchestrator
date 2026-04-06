// Shared Context - Unit Tests
// Testet _readSharedContext und _writeSharedContext

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

const Orchestrator = require('../../orchestrator');

describe('Shared Context', () => {
  let orch;
  let tmpDir;

  beforeEach(async () => {
    orch = new Orchestrator();
    // Temporaeres Verzeichnis im projects-Ordner erstellen
    const projectsDir = path.join(__dirname, '..', '..', 'projects');
    await fsp.mkdir(projectsDir, { recursive: true });
    tmpDir = await fsp.mkdtemp(path.join(projectsDir, 'test_ctx_'));
    orch.projectDir = tmpDir;
  });

  afterEach(async () => {
    // Aufraeumen
    if (tmpDir && fs.existsSync(tmpDir)) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('_readSharedContext()', () => {
    test('gibt leeren String zurueck wenn Datei nicht existiert', async () => {
      const result = await orch._readSharedContext();
      expect(result).toBe('');
    });

    test('gibt leeren String zurueck wenn projectDir nicht gesetzt', async () => {
      orch.projectDir = null;
      const result = await orch._readSharedContext();
      expect(result).toBe('');
    });

    test('liest vorhandenen Inhalt', async () => {
      const ctxFile = path.join(tmpDir, 'shared-context.md');
      await fsp.writeFile(ctxFile, '## Agent 1: Test\nErgebnis\n');

      const result = await orch._readSharedContext();
      expect(result).toBe('## Agent 1: Test\nErgebnis');
    });
  });

  describe('_writeSharedContext()', () => {
    test('erstellt die Datei', async () => {
      const agentDir = path.join(tmpDir, 'agent-1');
      await fsp.mkdir(agentDir, { recursive: true });

      orch.agents = [{ workDir: agentDir }];
      orch.tasks = [{ title: 'Test-Aufgabe', deliverable: 'Test-Ergebnis' }];

      await orch._writeSharedContext(0);

      const ctxFile = path.join(tmpDir, 'shared-context.md');
      expect(fs.existsSync(ctxFile)).toBe(true);

      const content = await fsp.readFile(ctxFile, 'utf-8');
      expect(content).toContain('Agent 1');
      expect(content).toContain('Test-Aufgabe');
      expect(content).toContain('Test-Ergebnis');
    });

    test('haengt an bestehende Datei an', async () => {
      const ctxFile = path.join(tmpDir, 'shared-context.md');
      await fsp.writeFile(ctxFile, '## Agent 1: Erster\n\n');

      const agentDir = path.join(tmpDir, 'agent-2');
      await fsp.mkdir(agentDir, { recursive: true });

      orch.agents = [{}, { workDir: agentDir }];
      orch.tasks = [{}, { title: 'Zweiter', deliverable: 'Zweites Ergebnis' }];

      await orch._writeSharedContext(1);

      const content = await fsp.readFile(ctxFile, 'utf-8');
      expect(content).toContain('Agent 1: Erster');
      expect(content).toContain('Agent 2: Zweiter');
    });

    test('macht nichts wenn projectDir null ist', async () => {
      orch.projectDir = null;
      // Soll nicht werfen
      await expect(orch._writeSharedContext(0)).resolves.toBeUndefined();
    });
  });
});
