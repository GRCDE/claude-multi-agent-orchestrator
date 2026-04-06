'use strict';
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// ── Default-Profile ──────────────────────────────────────────
const DEFAULT_PROFILES = {
  schnell: {
    name: 'schnell',
    description: 'Schnelle Ausfuehrung mit mehr parallelen Agenten und weniger Runden',
    config: {
      maxParallelAgents: 5,
      agentTimeout: 60000,
      maxRounds: 3,
    },
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  standard: {
    name: 'standard',
    description: 'Standard-Konfiguration mit ausgewogenen Einstellungen',
    config: {
      maxParallelAgents: 3,
      agentTimeout: 300000,
      maxRounds: 5,
      maxRetries: 5,
      retryBaseDelay: 5000,
      maxAgents: 10,
      isolation: 'shared',
      verifyAgents: false,
      autoInterventionEnabled: false,
      autoInterventionRounds: 10,
      interimReportInterval: 3,
      mergeStrategy: 'latest',
    },
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  gruendlich: {
    name: 'gruendlich',
    description: 'Gruendliche Ausfuehrung mit weniger Parallelitaet und mehr Runden',
    config: {
      maxParallelAgents: 2,
      agentTimeout: 300000,
      maxRounds: 15,
      mergeStrategy: 'sequential',
    },
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

// ── Validierung ──────────────────────────────────────────────
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 50;

function validateName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Profilname darf nicht leer sein');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Profilname darf maximal ${MAX_NAME_LENGTH} Zeichen lang sein`);
  }
  if (!NAME_REGEX.test(name)) {
    throw new Error('Profilname darf nur alphanumerische Zeichen, Bindestriche und Unterstriche enthalten');
  }
}

// ── ConfigProfileManager ─────────────────────────────────────
class ConfigProfileManager {
  constructor(profilesDir) {
    this.profilesDir = profilesDir;
    this._activeProfile = null;

    // Verzeichnis erstellen falls nicht vorhanden
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }

    // Default-Profile erstellen falls nicht vorhanden
    this._ensureDefaultProfiles();
  }

  _ensureDefaultProfiles() {
    for (const [name, profile] of Object.entries(DEFAULT_PROFILES)) {
      const filePath = path.join(this.profilesDir, `${name}.json`);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
      }
    }
  }

  _profilePath(name) {
    return path.join(this.profilesDir, `${name}.json`);
  }

  saveProfile(name, config, description = '') {
    validateName(name);

    const filePath = this._profilePath(name);
    const existing = fs.existsSync(filePath);
    let profile;

    if (existing) {
      // Bestehendes Profil aktualisieren
      const raw = fs.readFileSync(filePath, 'utf-8');
      profile = JSON.parse(raw);
      if (profile.isDefault) {
        throw new Error(`Default-Profil '${name}' kann nicht ueberschrieben werden`);
      }
      profile.config = config;
      if (description) profile.description = description;
      profile.updatedAt = new Date().toISOString();
    } else {
      profile = {
        name,
        description: description || '',
        config,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isDefault: false,
      };
    }

    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
    return profile;
  }

  loadProfile(name) {
    validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Profil '${name}' nicht gefunden`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  }

  deleteProfile(name) {
    validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Profil '${name}' nicht gefunden`);
    }

    // Default-Profile duerfen nicht geloescht werden
    const raw = fs.readFileSync(filePath, 'utf-8');
    const profile = JSON.parse(raw);
    if (profile.isDefault) {
      throw new Error(`Default-Profil '${name}' kann nicht geloescht werden`);
    }

    fs.unlinkSync(filePath);

    // Aktives Profil zuruecksetzen wenn es geloescht wurde
    if (this._activeProfile === name) {
      this._activeProfile = null;
    }

    return true;
  }

  listProfiles() {
    const files = fs.readdirSync(this.profilesDir)
      .filter(f => f.endsWith('.json'));

    const profiles = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.profilesDir, file), 'utf-8');
        const profile = JSON.parse(raw);
        profiles.push({
          name: profile.name,
          description: profile.description || '',
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
          isDefault: !!profile.isDefault,
          isActive: this._activeProfile === profile.name,
        });
      } catch {
        // Fehlerhafte Dateien ignorieren
      }
    }

    return profiles;
  }

  exportProfile(name) {
    const profile = this.loadProfile(name);
    return JSON.stringify(profile, null, 2);
  }

  importProfile(jsonString) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch {
      throw new Error('Ungueltiges JSON-Format');
    }

    if (!data.name || !data.config || typeof data.config !== 'object') {
      throw new Error('Ungueltiges Profil-Format: name und config sind erforderlich');
    }

    validateName(data.name);

    // Pruefen ob ein Default-Profil mit diesem Namen existiert
    const filePath = this._profilePath(data.name);
    if (fs.existsSync(filePath)) {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (existing.isDefault) {
        throw new Error(`Default-Profil '${data.name}' kann nicht ueberschrieben werden`);
      }
    }

    const profile = {
      name: data.name,
      description: data.description || '',
      config: data.config,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: false,
    };

    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
    return profile;
  }

  getActiveProfile() {
    return this._activeProfile;
  }

  setActiveProfile(name) {
    if (name === null) {
      this._activeProfile = null;
      return null;
    }
    validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Profil '${name}' nicht gefunden`);
    }
    this._activeProfile = name;
    return name;
  }
}

module.exports = ConfigProfileManager;
