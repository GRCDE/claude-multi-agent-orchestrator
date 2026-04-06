// Profile CRUD Lifecycle - Tests
// Testet den kompletten Profile-Lifecycle ueber alle /api/profiles Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3246;

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

// In-Memory Profil-Speicher fuer den Mock
const mockProfileStore = new Map();

// Default-Profile vorbelegen
const mockDefaults = [
  { name: 'schnell', description: 'Schnelle Ausfuehrung', config: { maxParallelAgents: 5, maxRounds: 3 }, isDefault: true },
  { name: 'standard', description: 'Standard-Einstellungen', config: { maxParallelAgents: 3, maxRounds: 5 }, isDefault: true },
  { name: 'gruendlich', description: 'Gruendliche Ausfuehrung', config: { maxParallelAgents: 2, maxRounds: 10 }, isDefault: true },
];
mockDefaults.forEach(p => mockProfileStore.set(p.name, { ...p }));

let mockActiveProfile = null;

jest.mock('../../orchestrator', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.profileManager = {
        listProfiles: () => Array.from(mockProfileStore.values()),
        loadProfile: (name) => {
          const p = mockProfileStore.get(name);
          if (!p) throw new Error(`Profil "${name}" nicht gefunden`);
          return p;
        },
        saveProfile: (name, config, description) => {
          const profile = { name, config, description: description || '', isDefault: false };
          mockProfileStore.set(name, profile);
          return profile;
        },
        deleteProfile: (name) => {
          const p = mockProfileStore.get(name);
          if (!p) throw new Error(`Profil "${name}" nicht gefunden`);
          if (p.isDefault) throw new Error(`Default-Profil "${name}" kann nicht geloescht werden`);
          mockProfileStore.delete(name);
        },
        getActiveProfile: () => mockActiveProfile,
        setActiveProfile: (name) => { mockActiveProfile = name; },
        importProfile: (jsonString) => {
          const data = JSON.parse(jsonString);
          if (!data.name) throw new Error('name ist erforderlich');
          const profile = { name: data.name, config: data.config || {}, description: data.description || '', isDefault: false };
          mockProfileStore.set(data.name, profile);
          return profile;
        },
        exportProfile: (name) => {
          const p = mockProfileStore.get(name);
          if (!p) throw new Error(`Profil "${name}" nicht gefunden`);
          return JSON.stringify(p);
        },
      };
    }
    emit(event, data) {
      super.emit('update', { event, data, ts: Date.now() });
      super.emit(event, data);
      return true;
    }
    getState() {
      return {
        phase: this.phase,
        agents: this.agents,
        coordinator: {},
        totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
      };
    }
    start() { this.phase = 'running'; return Promise.resolve(); }
    reset() { this.phase = 'idle'; this.agents = []; }
    getPrompts() { return { prompts: {} }; }
    updatePrompts() {}
    resetPrompts() {}
    getConfig() { return { maxParallelAgents: 3, maxRounds: 5, autoRetry: true }; }
    updateConfig(cfg) { return { applied: cfg }; }
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
    getProfiles() { return this.profileManager.listProfiles(); }
    getActiveProfile() { return this.profileManager.getActiveProfile(); }
    applyProfile(name) {
      const profile = this.profileManager.loadProfile(name);
      this.profileManager.setActiveProfile(name);
      return { ok: true, profile: name, config: this.getConfig() };
    }
    saveCurrentAsProfile(name, description) {
      const config = this.getConfig();
      return this.profileManager.saveProfile(name, config, description);
    }
  }
  return MockOrchestrator;
});

describe('Profile CRUD Lifecycle', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
    });

    try {
      require('../../server');
      setTimeout(done, 500);
    } catch (e) {
      done(e);
    }
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('GET /api/profiles listet Default-Profile auf', async () => {
    const res = await request('GET', '/api/profiles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map(p => p.name);
    expect(names).toContain('schnell');
    expect(names).toContain('standard');
    expect(names).toContain('gruendlich');
  });

  test('POST /api/profiles/save-current speichert aktuelle Config als Profil', async () => {
    const res = await request('POST', '/api/profiles/save-current', {
      name: 'mein-save',
      description: 'Gespeicherte aktuelle Config'
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('mein-save');
    expect(res.body.config).toBeTruthy();
    expect(res.body.config.maxParallelAgents).toBe(3);
  });

  test('GET /api/profiles/:name laedt einzelnes Profil', async () => {
    const res = await request('GET', '/api/profiles/mein-save');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('mein-save');
    expect(res.body.config).toBeTruthy();
  });

  test('POST /api/profiles/:name/apply wendet Profil an und gibt Config zurueck', async () => {
    const res = await request('POST', '/api/profiles/schnell/apply');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toBe('schnell');
    expect(res.body.config).toBeTruthy();
  });

  test('DELETE /api/profiles/:name loescht benutzerdefiniertes Profil', async () => {
    // Zuerst sicherstellen, dass das Profil existiert
    const getRes = await request('GET', '/api/profiles/mein-save');
    expect(getRes.status).toBe(200);

    // Loeschen
    const delRes = await request('DELETE', '/api/profiles/mein-save');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Nicht mehr vorhanden
    const getRes2 = await request('GET', '/api/profiles/mein-save');
    expect(getRes2.status).toBe(404);
  });

  test('POST /api/profiles/import importiert ein Profil aus JSON', async () => {
    const profileData = {
      name: 'importiert',
      description: 'Via Import erstellt',
      config: { maxParallelAgents: 4, maxRounds: 8 }
    };
    const res = await request('POST', '/api/profiles/import', profileData);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('importiert');

    // Verifizieren dass es existiert
    const getRes = await request('GET', '/api/profiles/importiert');
    expect(getRes.status).toBe(200);
    expect(getRes.body.config.maxParallelAgents).toBe(4);

    // Aufraemen
    await request('DELETE', '/api/profiles/importiert');
  });

  test('GET /api/profiles/:name/export exportiert Profil als JSON', async () => {
    const res = await request('GET', '/api/profiles/standard/export');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('standard');
    expect(res.body.config).toBeTruthy();
    expect(res.body.isDefault).toBe(true);
  });

  test('DELETE Default-Profil wird mit 400 abgelehnt', async () => {
    const res = await request('DELETE', '/api/profiles/schnell');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Default/);
  });
});
