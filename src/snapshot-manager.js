'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const MAX_AUTO_SNAPSHOTS = 10;

class SnapshotManager {
  constructor(snapshotsDir) {
    this.snapshotsDir = snapshotsDir || path.join(__dirname, '..', 'snapshots');
    // Verzeichnis anlegen falls nicht vorhanden
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }
  }

  /**
   * Generiert eine eindeutige Snapshot-ID
   */
  _generateId() {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `snap_${ts}_${rand}`;
  }

  /**
   * Pfad zur Snapshot-Datei
   */
  _snapshotPath(snapshotId) {
    return path.join(this.snapshotsDir, `${snapshotId}.json`);
  }

  /**
   * Erstellt einen Snapshot des Projekt-States
   */
  async createSnapshot(projectId, state, name, description) {
    if (!projectId || !state) {
      throw new Error('projectId und state sind erforderlich');
    }

    const snapshotId = this._generateId();
    const snapshot = {
      id: snapshotId,
      metadata: {
        name: name || `Snapshot ${new Date().toISOString()}`,
        description: description || '',
        createdAt: Date.now(),
        createdAtISO: new Date().toISOString(),
        projectId,
        agentCount: (state.agents || []).length,
        phase: state.phase || 'unknown',
      },
      state: JSON.parse(JSON.stringify(state)), // Deep copy
    };

    const filePath = this._snapshotPath(snapshotId);
    await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

    return { snapshotId, name: snapshot.metadata.name, createdAt: snapshot.metadata.createdAt };
  }

  /**
   * Stellt einen Snapshot wieder her (gibt den gespeicherten State zurueck)
   */
  async restoreSnapshot(snapshotId) {
    if (!snapshotId) {
      throw new Error('snapshotId ist erforderlich');
    }

    const filePath = this._snapshotPath(snapshotId);
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const snapshot = JSON.parse(raw);
      return snapshot.state;
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`Snapshot nicht gefunden: ${snapshotId}`);
      }
      throw e;
    }
  }

  /**
   * Listet alle Snapshots eines Projekts, sortiert nach Datum (neueste zuerst)
   */
  async listSnapshots(projectId) {
    const all = await this.listAllSnapshots();
    return all.filter(s => s.projectId === projectId);
  }

  /**
   * Listet alle Snapshots ueber alle Projekte
   */
  async listAllSnapshots() {
    let files;
    try {
      files = await fsp.readdir(this.snapshotsDir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }

    const snapshots = [];
    for (const file of files) {
      if (!file.startsWith('snap_') || !file.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(this.snapshotsDir, file), 'utf-8');
        const snapshot = JSON.parse(raw);
        snapshots.push({
          id: snapshot.id,
          name: snapshot.metadata.name,
          description: snapshot.metadata.description,
          createdAt: snapshot.metadata.createdAt,
          createdAtISO: snapshot.metadata.createdAtISO,
          projectId: snapshot.metadata.projectId,
          agentCount: snapshot.metadata.agentCount,
          phase: snapshot.metadata.phase,
          trigger: snapshot.metadata.trigger || 'manual',
        });
      } catch {
        // Beschaedigte Dateien ueberspringen
      }
    }

    // Sortieren: neueste zuerst
    snapshots.sort((a, b) => b.createdAt - a.createdAt);
    return snapshots;
  }

  /**
   * Loescht einen Snapshot
   */
  async deleteSnapshot(snapshotId) {
    if (!snapshotId) {
      throw new Error('snapshotId ist erforderlich');
    }

    const filePath = this._snapshotPath(snapshotId);
    try {
      await fsp.unlink(filePath);
      return { deleted: true, snapshotId };
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`Snapshot nicht gefunden: ${snapshotId}`);
      }
      throw e;
    }
  }

  /**
   * Vergleicht zwei Snapshots
   */
  async compareSnapshots(id1, id2) {
    const snap1Path = this._snapshotPath(id1);
    const snap2Path = this._snapshotPath(id2);

    let snap1, snap2;
    try {
      snap1 = JSON.parse(await fsp.readFile(snap1Path, 'utf-8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`Snapshot nicht gefunden: ${id1}`);
      throw e;
    }
    try {
      snap2 = JSON.parse(await fsp.readFile(snap2Path, 'utf-8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`Snapshot nicht gefunden: ${id2}`);
      throw e;
    }

    const state1 = snap1.state || {};
    const state2 = snap2.state || {};
    const agents1 = state1.agents || [];
    const agents2 = state2.agents || [];

    // Agent-Status-Aenderungen
    const statusChanges = [];
    const maxLen = Math.max(agents1.length, agents2.length);
    for (let i = 0; i < maxLen; i++) {
      const a1 = agents1[i];
      const a2 = agents2[i];
      if (a1 && a2) {
        if (a1.status !== a2.status) {
          statusChanges.push({
            agentIndex: i,
            id: a1.id || a2.id || `agent-${i}`,
            from: a1.status,
            to: a2.status,
          });
        }
      }
    }

    // Neue/entfernte Agents
    const newAgents = [];
    const removedAgents = [];
    if (agents2.length > agents1.length) {
      for (let i = agents1.length; i < agents2.length; i++) {
        newAgents.push({ agentIndex: i, id: agents2[i].id || `agent-${i}` });
      }
    }
    if (agents1.length > agents2.length) {
      for (let i = agents2.length; i < agents1.length; i++) {
        removedAgents.push({ agentIndex: i, id: agents1[i].id || `agent-${i}` });
      }
    }

    // Token-Verbrauch Differenz
    const tokens1 = state1.totalTokenUsage || {};
    const tokens2 = state2.totalTokenUsage || {};
    const tokenDiff = {
      inputTokens: (tokens2.inputTokens || 0) - (tokens1.inputTokens || 0),
      outputTokens: (tokens2.outputTokens || 0) - (tokens1.outputTokens || 0),
      totalTokens: (tokens2.totalTokens || 0) - (tokens1.totalTokens || 0),
      estimatedCostDiff: parseFloat(((tokens2.estimatedCost || 0) - (tokens1.estimatedCost || 0)).toFixed(6)),
    };

    // Phase-Aenderung
    const phaseChange = state1.phase !== state2.phase
      ? { from: state1.phase, to: state2.phase }
      : null;

    return {
      snapshot1: { id: id1, createdAt: snap1.metadata.createdAt, phase: snap1.metadata.phase },
      snapshot2: { id: id2, createdAt: snap2.metadata.createdAt, phase: snap2.metadata.phase },
      statusChanges,
      newAgents,
      removedAgents,
      tokenDiff,
      phaseChange,
    };
  }

  /**
   * Gibt die Dateigroesse eines Snapshots in Bytes zurueck
   */
  async getSnapshotSize(snapshotId) {
    if (!snapshotId) {
      throw new Error('snapshotId ist erforderlich');
    }

    const filePath = this._snapshotPath(snapshotId);
    try {
      const stat = await fsp.stat(filePath);
      return { snapshotId, sizeBytes: stat.size };
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`Snapshot nicht gefunden: ${snapshotId}`);
      }
      throw e;
    }
  }

  /**
   * Automatischer Snapshot bei wichtigen Events
   * Max 10 Auto-Snapshots pro Projekt (aelteste werden geloescht)
   */
  async autoSnapshot(projectId, state, trigger) {
    if (!projectId || !state) {
      throw new Error('projectId und state sind erforderlich');
    }

    const validTriggers = ['phase_change', 'agent_complete', 'manual', 'error'];
    if (!validTriggers.includes(trigger)) {
      trigger = 'manual';
    }

    const name = `Auto: ${trigger} (${new Date().toISOString()})`;
    const description = `Automatischer Snapshot, Trigger: ${trigger}`;

    // Snapshot erstellen
    const result = await this.createSnapshot(projectId, state, name, description);

    // Trigger in der Datei speichern (metadata erweitern)
    const filePath = this._snapshotPath(result.snapshotId);
    const raw = await fsp.readFile(filePath, 'utf-8');
    const snapshot = JSON.parse(raw);
    snapshot.metadata.trigger = trigger;
    snapshot.metadata.auto = true;
    await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Max 10 Auto-Snapshots pro Projekt: aelteste loeschen
    const allSnapshots = await this.listAllSnapshots();
    const autoSnapshots = allSnapshots
      .filter(s => s.projectId === projectId && s.trigger !== 'manual')
      .sort((a, b) => a.createdAt - b.createdAt); // aelteste zuerst

    while (autoSnapshots.length > MAX_AUTO_SNAPSHOTS) {
      const oldest = autoSnapshots.shift();
      try {
        await this.deleteSnapshot(oldest.id);
      } catch {
        // Ignorieren falls bereits geloescht
      }
    }

    return { ...result, trigger };
  }
}

module.exports = SnapshotManager;
