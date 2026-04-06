'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const SnapshotManager = require('../../src/snapshot-manager');

const TEST_DIR = path.join(__dirname, '..', '..', 'test-snapshots-' + Date.now());

let manager;

function makeState(overrides) {
  return {
    phase: 'running',
    projectId: 'proj_test_123',
    projectTitle: 'Test-Projekt',
    projectSummary: '',
    projectDesc: 'Testbeschreibung',
    tasks: [{ title: 'Aufgabe 1' }],
    agents: [
      { id: 0, title: 'Agent 1', status: 'done', conversation: [], tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      { id: 1, title: 'Agent 2', status: 'working', conversation: [], tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 } },
    ],
    coordinator: { status: 'ready', log: [], tokenUsage: { inputTokens: 50, outputTokens: 25 } },
    totalTokenUsage: { inputTokens: 350, outputTokens: 175, totalTokens: 525, estimatedCost: 0.003 },
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeAll(async () => {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  manager = new SnapshotManager(TEST_DIR);
});

afterAll(async () => {
  try {
    const files = await fsp.readdir(TEST_DIR);
    for (const f of files) {
      await fsp.unlink(path.join(TEST_DIR, f));
    }
    await fsp.rmdir(TEST_DIR);
  } catch (e) {
    // Ignorieren
  }
});

describe('SnapshotManager', () => {
  test('createSnapshot erstellt Snapshot und gibt ID zurueck', async () => {
    const state = makeState();
    const result = await manager.createSnapshot('proj_test_123', state, 'Test Snapshot', 'Beschreibung');
    expect(result).toHaveProperty('snapshotId');
    expect(result.snapshotId).toMatch(/^snap_\d+_[a-z0-9]+$/);
    expect(result).toHaveProperty('name', 'Test Snapshot');
    expect(result).toHaveProperty('createdAt');
    expect(typeof result.createdAt).toBe('number');
  });

  test('restoreSnapshot gibt gespeicherten State zurueck', async () => {
    const state = makeState({ projectTitle: 'Restore-Test' });
    const { snapshotId } = await manager.createSnapshot('proj_test_123', state, 'Restore Test');
    const restored = await manager.restoreSnapshot(snapshotId);
    expect(restored.projectTitle).toBe('Restore-Test');
    expect(restored.agents).toHaveLength(2);
    expect(restored.phase).toBe('running');
  });

  test('restoreSnapshot ist ein Deep-Copy (keine Referenz)', async () => {
    const state = makeState();
    const { snapshotId } = await manager.createSnapshot('proj_test_123', state, 'Deep Copy Test');
    const restored = await manager.restoreSnapshot(snapshotId);
    restored.agents.push({ id: 99 });
    const restored2 = await manager.restoreSnapshot(snapshotId);
    expect(restored2.agents).toHaveLength(2); // Unveraendert
  });

  test('listSnapshots filtert nach projectId', async () => {
    const stateA = makeState({ projectId: 'proj_aaa' });
    const stateB = makeState({ projectId: 'proj_bbb' });
    await manager.createSnapshot('proj_aaa', stateA, 'Snap A');
    await manager.createSnapshot('proj_bbb', stateB, 'Snap B');
    const snapsA = await manager.listSnapshots('proj_aaa');
    expect(snapsA.length).toBeGreaterThanOrEqual(1);
    expect(snapsA.every(s => s.projectId === 'proj_aaa')).toBe(true);
  });

  test('listAllSnapshots gibt alle Snapshots zurueck', async () => {
    const all = await manager.listAllSnapshots();
    expect(all.length).toBeGreaterThanOrEqual(3); // Mindestens die oben erstellten
    // Sortierung pruefen: neueste zuerst
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }
  });

  test('deleteSnapshot loescht Snapshot', async () => {
    const state = makeState();
    const { snapshotId } = await manager.createSnapshot('proj_test_123', state, 'Zu loeschen');
    const result = await manager.deleteSnapshot(snapshotId);
    expect(result.deleted).toBe(true);
    // Nochmal loeschen sollte fehlschlagen
    await expect(manager.deleteSnapshot(snapshotId)).rejects.toThrow(/nicht gefunden/);
  });

  test('compareSnapshots erkennt Status-Aenderungen', async () => {
    const state1 = makeState({
      agents: [
        { id: 0, title: 'A1', status: 'working', conversation: [] },
        { id: 1, title: 'A2', status: 'waiting', conversation: [] },
      ],
      totalTokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCost: 0.001 },
    });
    const state2 = makeState({
      agents: [
        { id: 0, title: 'A1', status: 'done', conversation: [] },
        { id: 1, title: 'A2', status: 'error', conversation: [] },
      ],
      totalTokenUsage: { inputTokens: 500, outputTokens: 250, totalTokens: 750, estimatedCost: 0.005 },
    });
    const { snapshotId: id1 } = await manager.createSnapshot('proj_cmp', state1, 'Vorher');
    const { snapshotId: id2 } = await manager.createSnapshot('proj_cmp', state2, 'Nachher');

    const cmp = await manager.compareSnapshots(id1, id2);
    expect(cmp.statusChanges).toHaveLength(2);
    expect(cmp.statusChanges[0]).toEqual(expect.objectContaining({ from: 'working', to: 'done' }));
    expect(cmp.statusChanges[1]).toEqual(expect.objectContaining({ from: 'waiting', to: 'error' }));
    expect(cmp.tokenDiff.inputTokens).toBe(400);
    expect(cmp.tokenDiff.outputTokens).toBe(200);
  });

  test('compareSnapshots erkennt neue/entfernte Agents', async () => {
    const state1 = makeState({
      agents: [{ id: 0, title: 'A1', status: 'done', conversation: [] }],
    });
    const state2 = makeState({
      agents: [
        { id: 0, title: 'A1', status: 'done', conversation: [] },
        { id: 1, title: 'A2', status: 'working', conversation: [] },
        { id: 2, title: 'A3', status: 'waiting', conversation: [] },
      ],
    });
    const { snapshotId: id1 } = await manager.createSnapshot('proj_cmp2', state1, 'Weniger');
    const { snapshotId: id2 } = await manager.createSnapshot('proj_cmp2', state2, 'Mehr');

    const cmp = await manager.compareSnapshots(id1, id2);
    expect(cmp.newAgents).toHaveLength(2);
    expect(cmp.removedAgents).toHaveLength(0);
  });

  test('autoSnapshot begrenzt auf Max 10 pro Projekt', async () => {
    const projectId = 'proj_auto_limit';
    const state = makeState({ projectId });

    // 12 Auto-Snapshots erstellen
    for (let i = 0; i < 12; i++) {
      await manager.autoSnapshot(projectId, state, 'phase_change');
    }

    const all = await manager.listAllSnapshots();
    const autoSnaps = all.filter(s => s.projectId === projectId && s.trigger !== 'manual');
    expect(autoSnaps.length).toBeLessThanOrEqual(10);
  });

  test('autoSnapshot speichert Trigger korrekt', async () => {
    const state = makeState();
    const result = await manager.autoSnapshot('proj_trigger', state, 'error');
    expect(result.trigger).toBe('error');

    const all = await manager.listAllSnapshots();
    const snap = all.find(s => s.id === result.snapshotId);
    expect(snap.trigger).toBe('error');
  });

  test('getSnapshotSize gibt Dateigroesse in Bytes zurueck', async () => {
    const state = makeState();
    const { snapshotId } = await manager.createSnapshot('proj_size', state, 'Size Test');
    const result = await manager.getSnapshotSize(snapshotId);
    expect(result).toHaveProperty('snapshotId', snapshotId);
    expect(result).toHaveProperty('sizeBytes');
    expect(typeof result.sizeBytes).toBe('number');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  test('restoreSnapshot mit ungueltiger ID wirft Fehler', async () => {
    await expect(manager.restoreSnapshot('snap_nonexistent_xyz')).rejects.toThrow(/nicht gefunden/);
  });

  test('deleteSnapshot mit ungueltiger ID wirft Fehler', async () => {
    await expect(manager.deleteSnapshot('snap_nonexistent_abc')).rejects.toThrow(/nicht gefunden/);
  });

  test('createSnapshot ohne projectId wirft Fehler', async () => {
    await expect(manager.createSnapshot(null, makeState(), 'Fail')).rejects.toThrow(/erforderlich/);
  });

  test('createSnapshot ohne state wirft Fehler', async () => {
    await expect(manager.createSnapshot('proj_x', null, 'Fail')).rejects.toThrow(/erforderlich/);
  });

  test('compareSnapshots mit Phase-Aenderung', async () => {
    const state1 = makeState({ phase: 'running' });
    const state2 = makeState({ phase: 'complete' });
    const { snapshotId: id1 } = await manager.createSnapshot('proj_phase', state1, 'Running');
    const { snapshotId: id2 } = await manager.createSnapshot('proj_phase', state2, 'Complete');

    const cmp = await manager.compareSnapshots(id1, id2);
    expect(cmp.phaseChange).toEqual({ from: 'running', to: 'complete' });
  });
});
