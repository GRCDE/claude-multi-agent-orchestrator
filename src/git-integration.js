'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');
const logger = require('./logger');

/**
 * Git-Integration fuer den Multi-Agent Orchestrator.
 * Ermoeglicht Auto-Commit von Projekt-Ergebnissen in ein Git-Repository.
 */
class GitIntegration {
  constructor(options = {}) {
    this.enabled = options.enabled || false;
    this.workDir = options.workDir || '';           // Ziel-Git-Repository Pfad
    this.autoCommit = options.autoCommit !== false;  // Auto-Commit nach Merge
    this.branchPerProject = options.branchPerProject !== false; // Branch pro Projekt
    this.autoPush = options.autoPush || false;       // Auto-Push nach Commit
    this.commitPrefix = options.commitPrefix || '[orchestrator]'; // Commit-Message Prefix
  }

  /**
   * Prueft ob git installiert und das workDir ein valides Git-Repo ist.
   */
  checkGit() {
    try {
      const version = execSync('git --version', { stdio: 'pipe', timeout: 5000 }).toString().trim();
      logger.info('Git gefunden', { version });
      return { ok: true, version };
    } catch (e) {
      return { ok: false, error: 'Git nicht installiert oder nicht im PATH' };
    }
  }

  /**
   * Prueft ob das konfigurierte workDir ein Git-Repository ist.
   */
  isGitRepo(dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir) return false;
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: targetDir, stdio: 'pipe', timeout: 5000
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialisiert ein Git-Repository im Zielverzeichnis (falls noch nicht vorhanden).
   */
  async initRepo(dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir) throw new Error('Kein Git-Arbeitsverzeichnis konfiguriert');

    await fsp.mkdir(targetDir, { recursive: true });

    if (!this.isGitRepo(targetDir)) {
      execSync('git init', { cwd: targetDir, stdio: 'pipe', timeout: 10000 });
      // Standard-User setzen falls nicht konfiguriert (noetig fuer Commits)
      try {
        execSync('git config user.name', { cwd: targetDir, stdio: 'pipe', timeout: 5000 });
      } catch {
        execSync('git config user.name "Orchestrator"', { cwd: targetDir, stdio: 'pipe', timeout: 5000 });
        execSync('git config user.email "orchestrator@localhost"', { cwd: targetDir, stdio: 'pipe', timeout: 5000 });
      }
      logger.info('Git-Repository initialisiert', { dir: targetDir });
    }
    return true;
  }

  /**
   * Gibt den aktuellen Branch-Namen zurueck.
   */
  getCurrentBranch(dir) {
    const targetDir = dir || this.workDir;
    try {
      return execSync('git branch --show-current', {
        cwd: targetDir, stdio: 'pipe', timeout: 5000
      }).toString().trim() || 'main';
    } catch {
      return 'main';
    }
  }

  /**
   * Erstellt und wechselt auf einen Projekt-Branch.
   */
  createProjectBranch(projectId, projectTitle, dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) return null;

    // Branch-Name sanitisieren
    const safeName = (projectTitle || projectId)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const branchName = `project/${safeName}-${projectId.slice(0, 8)}`;

    try {
      // Pruefen ob Branch existiert
      try {
        execSync(`git rev-parse --verify ${branchName}`, {
          cwd: targetDir, stdio: 'pipe', timeout: 5000
        });
        // Branch existiert, wechsle hin
        execSync(`git checkout ${branchName}`, {
          cwd: targetDir, stdio: 'pipe', timeout: 5000
        });
      } catch {
        // Branch existiert nicht, erstelle ihn
        execSync(`git checkout -b ${branchName}`, {
          cwd: targetDir, stdio: 'pipe', timeout: 5000
        });
      }
      logger.info('Projekt-Branch erstellt/gewechselt', { branch: branchName });
      return branchName;
    } catch (e) {
      logger.warn('Branch-Erstellung fehlgeschlagen', { branch: branchName, error: e.message });
      return null;
    }
  }

  /**
   * Kopiert Dateien aus dem Merge-Verzeichnis in das Git-Arbeitsverzeichnis.
   */
  async copyMergedFiles(mergedDir, subDir, dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !mergedDir) return [];

    const destDir = subDir ? path.join(targetDir, subDir) : targetDir;
    await fsp.mkdir(destDir, { recursive: true });

    const copied = [];
    try {
      const entries = await fsp.readdir(mergedDir);
      for (const entry of entries) {
        const srcPath = path.join(mergedDir, entry);
        const destPath = path.join(destDir, entry);
        try {
          const stat = await fsp.stat(srcPath);
          if (stat.isFile()) {
            await fsp.copyFile(srcPath, destPath);
            copied.push(entry);
          }
        } catch (e) {
          logger.warn('Datei-Kopie fehlgeschlagen', { file: entry, error: e.message });
        }
      }
    } catch (e) {
      logger.warn('Merged-Verzeichnis lesen fehlgeschlagen', { dir: mergedDir, error: e.message });
    }
    return copied;
  }

  /**
   * Staged alle Aenderungen und erstellt einen Commit.
   */
  commit(message, dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, error: 'Kein Git-Repository' };
    }

    try {
      // Stage all changes
      execSync('git add -A', { cwd: targetDir, stdio: 'pipe', timeout: 10000 });

      // Pruefen ob es etwas zu committen gibt
      try {
        execSync('git diff --cached --quiet', { cwd: targetDir, stdio: 'pipe', timeout: 5000 });
        // Kein Fehler = keine Aenderungen
        return { ok: true, skipped: true, message: 'Keine Aenderungen zum Committen' };
      } catch {
        // Fehler = es gibt Aenderungen
      }

      const fullMessage = `${this.commitPrefix} ${message}`;
      execSync(`git commit -m "${fullMessage.replace(/"/g, '\\"')}"`, {
        cwd: targetDir, stdio: 'pipe', timeout: 15000
      });

      // Commit-Hash holen
      const hash = execSync('git rev-parse --short HEAD', {
        cwd: targetDir, stdio: 'pipe', timeout: 5000
      }).toString().trim();

      logger.info('Git-Commit erstellt', { hash, message: fullMessage.slice(0, 100) });
      return { ok: true, hash, message: fullMessage };
    } catch (e) {
      logger.warn('Git-Commit fehlgeschlagen', { error: e.message });
      return { ok: false, error: e.message };
    }
  }

  /**
   * Pushed den aktuellen Branch zum Remote.
   */
  push(dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, error: 'Kein Git-Repository' };
    }

    try {
      const branch = this.getCurrentBranch(targetDir);
      execSync(`git push -u origin ${branch}`, {
        cwd: targetDir, stdio: 'pipe', timeout: 30000
      });
      logger.info('Git-Push erfolgreich', { branch });
      return { ok: true, branch };
    } catch (e) {
      logger.warn('Git-Push fehlgeschlagen', { error: e.message });
      return { ok: false, error: e.message };
    }
  }

  /**
   * Git-Status im Arbeitsverzeichnis abfragen.
   */
  getStatus(dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, error: 'Kein Git-Repository' };
    }

    try {
      const status = execSync('git status --porcelain', {
        cwd: targetDir, stdio: 'pipe', timeout: 5000
      }).toString().trim();

      const branch = this.getCurrentBranch(targetDir);
      const lines = status ? status.split('\n') : [];
      const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
      const added = lines.filter(l => l.startsWith('A ') || l.startsWith('??')).length;
      const deleted = lines.filter(l => l.startsWith('D ') || l.startsWith(' D')).length;

      return {
        ok: true, branch, clean: lines.length === 0,
        modified, added, deleted, total: lines.length,
        files: lines.slice(0, 50).map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3) }))
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Git-Log (letzte N Commits) abfragen.
   */
  getLog(count = 20, dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, commits: [] };
    }

    try {
      const raw = execSync(
        `git log --oneline --format="%H|%h|%s|%an|%aI" -${Math.min(count, 100)}`,
        { cwd: targetDir, stdio: 'pipe', timeout: 5000 }
      ).toString().trim();

      const commits = raw ? raw.split('\n').map(line => {
        const [hash, shortHash, message, author, date] = line.split('|');
        return { hash, shortHash, message, author, date };
      }) : [];

      return { ok: true, commits, branch: this.getCurrentBranch(targetDir) };
    } catch (e) {
      return { ok: false, commits: [], error: e.message };
    }
  }

  /**
   * Diff fuer einen bestimmten Commit anzeigen.
   */
  getCommitDiff(commitHash, dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, diff: '' };
    }

    // Hash validieren (nur Hex-Zeichen erlaubt)
    if (!/^[a-f0-9]{4,40}$/i.test(commitHash)) {
      return { ok: false, diff: '', error: 'Ungueltiger Commit-Hash' };
    }

    try {
      const diff = execSync(`git show --stat --patch ${commitHash}`, {
        cwd: targetDir, stdio: 'pipe', timeout: 10000, maxBuffer: 1024 * 1024
      }).toString();

      return { ok: true, diff: diff.slice(0, 100000), hash: commitHash };
    } catch (e) {
      return { ok: false, diff: '', error: e.message };
    }
  }

  /**
   * Liste der Branches im Repository.
   */
  getBranches(dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, branches: [] };
    }

    try {
      const raw = execSync('git branch --list', {
        cwd: targetDir, stdio: 'pipe', timeout: 5000
      }).toString().trim();

      const current = this.getCurrentBranch(targetDir);
      const branches = raw ? raw.split('\n').map(b => {
        const name = b.replace(/^\*?\s*/, '').trim();
        return { name, current: name === current };
      }) : [];

      return { ok: true, branches, current };
    } catch (e) {
      return { ok: false, branches: [], error: e.message };
    }
  }

  /**
   * Wechselt zu einem bestehenden Branch.
   */
  checkout(branchName, dir) {
    const targetDir = dir || this.workDir;
    if (!targetDir || !this.isGitRepo(targetDir)) {
      return { ok: false, error: 'Kein Git-Repository' };
    }

    // Branch-Name validieren
    if (!/^[a-zA-Z0-9/_.-]+$/.test(branchName)) {
      return { ok: false, error: 'Ungueltiger Branch-Name' };
    }

    try {
      execSync(`git checkout ${branchName}`, {
        cwd: targetDir, stdio: 'pipe', timeout: 10000
      });
      return { ok: true, branch: branchName };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Fuehrt den vollstaendigen Git-Workflow nach einem Projekt-Merge durch:
   * 1. Optional Branch erstellen
   * 2. Merged-Dateien kopieren
   * 3. Commit erstellen
   * 4. Optional Push
   */
  async commitProjectResults(projectId, projectTitle, mergedDir, agents) {
    if (!this.enabled || !this.workDir) {
      return { ok: false, skipped: true, reason: 'Git-Integration deaktiviert' };
    }

    const results = { steps: [] };

    try {
      // Repo sicherstellen
      await this.initRepo();
      results.steps.push({ step: 'init', ok: true });

      // Optionaler Projekt-Branch
      let branch = this.getCurrentBranch();
      if (this.branchPerProject) {
        branch = this.createProjectBranch(projectId, projectTitle) || branch;
        results.steps.push({ step: 'branch', ok: true, branch });
      }

      // Dateien kopieren
      const copied = await this.copyMergedFiles(mergedDir, null);
      results.steps.push({ step: 'copy', ok: true, files: copied.length });

      // Commit erstellen
      const agentSummary = (agents || [])
        .filter(a => a.status === 'done')
        .map(a => a.title)
        .join(', ');
      const commitMsg = `${projectTitle || projectId}: ${agentSummary || 'Projekt-Ergebnisse'}`;
      const commitResult = this.commit(commitMsg);
      results.steps.push({ step: 'commit', ...commitResult });

      // Optionaler Push
      if (this.autoPush && commitResult.ok && !commitResult.skipped) {
        const pushResult = this.push();
        results.steps.push({ step: 'push', ...pushResult });
      }

      results.ok = true;
      results.branch = branch;
      results.hash = commitResult.hash;
      logger.info('Git-Workflow abgeschlossen', { projectId, branch, hash: commitResult.hash });
    } catch (e) {
      results.ok = false;
      results.error = e.message;
      logger.warn('Git-Workflow fehlgeschlagen', { projectId, error: e.message });
    }

    return results;
  }

  /**
   * Gibt die aktuelle Konfiguration zurueck.
   */
  getConfig() {
    return {
      enabled: this.enabled,
      workDir: this.workDir,
      autoCommit: this.autoCommit,
      branchPerProject: this.branchPerProject,
      autoPush: this.autoPush,
      commitPrefix: this.commitPrefix,
      isRepo: this.workDir ? this.isGitRepo() : false,
      gitInstalled: this.checkGit().ok,
    };
  }

  /**
   * Aktualisiert die Konfiguration.
   */
  updateConfig(patch) {
    const errors = [];
    if (patch.enabled !== undefined) this.enabled = !!patch.enabled;
    if (patch.workDir !== undefined) {
      const dir = String(patch.workDir).trim();
      if (dir && !path.isAbsolute(dir)) {
        errors.push('Git-Arbeitsverzeichnis muss ein absoluter Pfad sein');
      } else {
        this.workDir = dir;
      }
    }
    if (patch.autoCommit !== undefined) this.autoCommit = !!patch.autoCommit;
    if (patch.branchPerProject !== undefined) this.branchPerProject = !!patch.branchPerProject;
    if (patch.autoPush !== undefined) this.autoPush = !!patch.autoPush;
    if (patch.commitPrefix !== undefined) {
      this.commitPrefix = String(patch.commitPrefix).trim().slice(0, 50) || '[orchestrator]';
    }
    return errors;
  }
}

module.exports = GitIntegration;
