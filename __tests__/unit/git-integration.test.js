// Git-Integration - Unit Tests
// Testet die GitIntegration-Klasse

'use strict';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const GitIntegration = require('../../src/git-integration');

describe('GitIntegration', () => {
  let git;

  beforeEach(() => {
    git = new GitIntegration();
  });

  describe('Konstruktor', () => {
    test('Standard-Werte sind korrekt', () => {
      expect(git.enabled).toBe(false);
      expect(git.workDir).toBe('');
      expect(git.autoCommit).toBe(true);
      expect(git.branchPerProject).toBe(true);
      expect(git.autoPush).toBe(false);
      expect(git.commitPrefix).toBe('[orchestrator]');
    });

    test('akzeptiert Custom-Optionen', () => {
      const custom = new GitIntegration({
        enabled: true,
        workDir: '/tmp/test-repo',
        autoCommit: false,
        branchPerProject: false,
        autoPush: true,
        commitPrefix: '[test]',
      });
      expect(custom.enabled).toBe(true);
      expect(custom.workDir).toBe('/tmp/test-repo');
      expect(custom.autoCommit).toBe(false);
      expect(custom.branchPerProject).toBe(false);
      expect(custom.autoPush).toBe(true);
      expect(custom.commitPrefix).toBe('[test]');
    });
  });

  describe('checkGit()', () => {
    test('gibt ok:true zurueck wenn git installiert ist', () => {
      const result = git.checkGit();
      // Git sollte in der CI/Test-Umgebung installiert sein
      expect(result).toHaveProperty('ok');
      expect(typeof result.ok).toBe('boolean');
    });

    test('enthaelt Version bei Erfolg', () => {
      const result = git.checkGit();
      if (result.ok) {
        expect(result.version).toMatch(/git/i);
      }
    });
  });

  describe('getConfig()', () => {
    test('gibt alle Config-Felder zurueck', () => {
      const config = git.getConfig();
      expect(config).toHaveProperty('enabled');
      expect(config).toHaveProperty('workDir');
      expect(config).toHaveProperty('autoCommit');
      expect(config).toHaveProperty('branchPerProject');
      expect(config).toHaveProperty('autoPush');
      expect(config).toHaveProperty('commitPrefix');
      expect(config).toHaveProperty('isRepo');
      expect(config).toHaveProperty('gitInstalled');
    });
  });

  describe('updateConfig()', () => {
    test('aktualisiert enabled', () => {
      git.updateConfig({ enabled: true });
      expect(git.enabled).toBe(true);
    });

    test('aktualisiert autoCommit', () => {
      git.updateConfig({ autoCommit: false });
      expect(git.autoCommit).toBe(false);
    });

    test('aktualisiert branchPerProject', () => {
      git.updateConfig({ branchPerProject: false });
      expect(git.branchPerProject).toBe(false);
    });

    test('aktualisiert autoPush', () => {
      git.updateConfig({ autoPush: true });
      expect(git.autoPush).toBe(true);
    });

    test('aktualisiert commitPrefix', () => {
      git.updateConfig({ commitPrefix: '[custom]' });
      expect(git.commitPrefix).toBe('[custom]');
    });

    test('lehnt relativen Pfad ab', () => {
      const errors = git.updateConfig({ workDir: 'relative/path' });
      expect(errors.length).toBeGreaterThan(0);
    });

    test('akzeptiert absoluten Pfad', () => {
      const absPath = process.platform === 'win32' ? 'C:\\temp\\repo' : '/tmp/repo';
      const errors = git.updateConfig({ workDir: absPath });
      expect(errors).toHaveLength(0);
      expect(git.workDir).toBe(absPath);
    });

    test('akzeptiert leeren Pfad', () => {
      const errors = git.updateConfig({ workDir: '' });
      expect(errors).toHaveLength(0);
      expect(git.workDir).toBe('');
    });

    test('schneidet commitPrefix auf 50 Zeichen', () => {
      git.updateConfig({ commitPrefix: 'a'.repeat(100) });
      expect(git.commitPrefix.length).toBeLessThanOrEqual(50);
    });
  });

  describe('isGitRepo()', () => {
    test('gibt false zurueck bei leerem workDir', () => {
      expect(git.isGitRepo()).toBe(false);
    });

    test('gibt false zurueck bei nicht-existierendem Verzeichnis', () => {
      expect(git.isGitRepo('/nonexistent/path/12345')).toBe(false);
    });
  });

  describe('getStatus()', () => {
    test('gibt Fehler zurueck bei leerem workDir', () => {
      const status = git.getStatus();
      expect(status.ok).toBe(false);
    });
  });

  describe('getLog()', () => {
    test('gibt leere Liste bei fehlendem Repo zurueck', () => {
      const log = git.getLog();
      expect(log.ok).toBe(false);
      expect(log.commits).toEqual([]);
    });
  });

  describe('getBranches()', () => {
    test('gibt leere Liste bei fehlendem Repo zurueck', () => {
      const branches = git.getBranches();
      expect(branches.ok).toBe(false);
      expect(branches.branches).toEqual([]);
    });
  });

  describe('getCommitDiff()', () => {
    test('lehnt ungueltigen Hash ab', () => {
      git.workDir = '/tmp';
      const result = git.getCommitDiff('not-a-hash!');
      expect(result.ok).toBe(false);
    });

    test('gibt Fehler bei fehlendem Repo zurueck', () => {
      const result = git.getCommitDiff('abc1234');
      expect(result.ok).toBe(false);
    });
  });

  describe('commit()', () => {
    test('gibt Fehler bei fehlendem Repo zurueck', () => {
      const result = git.commit('test');
      expect(result.ok).toBe(false);
    });
  });

  describe('push()', () => {
    test('gibt Fehler bei fehlendem Repo zurueck', () => {
      const result = git.push();
      expect(result.ok).toBe(false);
    });
  });

  describe('checkout()', () => {
    test('gibt Fehler bei fehlendem Repo zurueck', () => {
      const result = git.checkout('main');
      expect(result.ok).toBe(false);
    });

    test('lehnt ungueltigen Branch-Namen ab', () => {
      git.workDir = '/tmp';
      const result = git.checkout('invalid branch name!');
      expect(result.ok).toBe(false);
    });
  });

  describe('commitProjectResults()', () => {
    test('gibt skipped zurueck wenn deaktiviert', async () => {
      const result = await git.commitProjectResults('id1', 'Test', '/tmp', []);
      expect(result.skipped).toBe(true);
    });

    test('gibt skipped zurueck wenn kein workDir', async () => {
      git.enabled = true;
      const result = await git.commitProjectResults('id1', 'Test', '/tmp', []);
      expect(result.skipped).toBe(true);
    });
  });
});
