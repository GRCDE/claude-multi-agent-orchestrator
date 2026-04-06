'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const VALID_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

/**
 * Template-Schema:
 * {
 *   id, name, description, category, tags[],
 *   difficulty: 'beginner'|'intermediate'|'advanced',
 *   agentCount, tasks[], roles[], config{},
 *   author, version, createdAt, updatedAt,
 *   rating, ratingCount
 * }
 */

class TemplateManager {
  constructor(templatesDir) {
    this.templatesDir = templatesDir || TEMPLATES_DIR;
  }

  /**
   * Stellt sicher, dass das Templates-Verzeichnis existiert
   */
  async _ensureDir() {
    try {
      await fsp.mkdir(this.templatesDir, { recursive: true });
    } catch (e) {
      // Verzeichnis existiert bereits
    }
  }

  /**
   * Generiert eine eindeutige Template-ID
   */
  _generateId() {
    return 'tpl-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  }

  /**
   * Validiert ein Template-Objekt
   * @param {object} template
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(template) {
    const errors = [];

    if (!template || typeof template !== 'object') {
      return { valid: false, errors: ['Template muss ein Objekt sein'] };
    }

    // Name ist Pflicht
    if (!template.name || typeof template.name !== 'string' || !template.name.trim()) {
      errors.push('Name ist erforderlich');
    }

    // Mindestens 1 Task ist Pflicht
    if (!Array.isArray(template.tasks) || template.tasks.length === 0) {
      errors.push('Mindestens eine Aufgabe (tasks) ist erforderlich');
    }

    // Difficulty muss gueltig sein (wenn angegeben)
    if (template.difficulty && !VALID_DIFFICULTIES.includes(template.difficulty)) {
      errors.push('Schwierigkeitsgrad muss beginner, intermediate oder advanced sein');
    }

    // agentCount muss positiv sein (wenn angegeben)
    if (template.agentCount !== undefined) {
      const count = parseInt(template.agentCount);
      if (isNaN(count) || count < 1 || count > 20) {
        errors.push('Agentenzahl muss zwischen 1 und 20 liegen');
      }
    }

    // Rating muss zwischen 0 und 5 liegen (wenn angegeben)
    if (template.rating !== undefined) {
      const r = parseFloat(template.rating);
      if (isNaN(r) || r < 0 || r > 5) {
        errors.push('Bewertung muss zwischen 0 und 5 liegen');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Laedt alle Templates aus dem templates/ Verzeichnis
   * @returns {Promise<object[]>}
   */
  async loadTemplates() {
    await this._ensureDir();
    const files = await fsp.readdir(this.templatesDir);
    const templates = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(this.templatesDir, file), 'utf8');
        const template = JSON.parse(raw);
        templates.push(template);
      } catch (e) {
        // Kaputte JSON-Dateien ueberspringen
      }
    }

    return templates;
  }

  /**
   * Speichert ein Template (validiert und schreibt als JSON)
   * @param {object} template
   * @returns {Promise<object>} Das gespeicherte Template
   */
  async saveTemplate(template) {
    const { valid, errors } = this.validate(template);
    if (!valid) {
      throw new Error('Template ungueltig: ' + errors.join(', '));
    }

    await this._ensureDir();

    const now = new Date().toISOString();
    const saved = {
      id: template.id || this._generateId(),
      name: template.name.trim(),
      description: (template.description || '').trim(),
      category: (template.category || '').trim(),
      tags: Array.isArray(template.tags) ? template.tags.filter(t => typeof t === 'string').map(t => t.trim()) : [],
      difficulty: VALID_DIFFICULTIES.includes(template.difficulty) ? template.difficulty : 'intermediate',
      agentCount: parseInt(template.agentCount) || template.tasks.length || 1,
      tasks: template.tasks,
      roles: Array.isArray(template.roles) ? template.roles : [],
      config: (template.config && typeof template.config === 'object') ? template.config : {},
      author: (template.author || '').trim(),
      version: template.version || '1.0.0',
      createdAt: template.createdAt || now,
      updatedAt: now,
      rating: typeof template.rating === 'number' ? template.rating : 0,
      ratingCount: typeof template.ratingCount === 'number' ? template.ratingCount : 0
    };

    const filename = saved.id + '.json';
    await fsp.writeFile(
      path.join(this.templatesDir, filename),
      JSON.stringify(saved, null, 2),
      'utf8'
    );

    return saved;
  }

  /**
   * Loescht ein Template anhand seiner ID
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async deleteTemplate(id) {
    if (!id) throw new Error('ID ist erforderlich');

    await this._ensureDir();
    const filePath = path.join(this.templatesDir, id + '.json');

    try {
      await fsp.access(filePath);
      await fsp.unlink(filePath);
      return true;
    } catch (e) {
      // Datei existiert nicht - versuche alle Dateien zu durchsuchen
      const files = await fsp.readdir(this.templatesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fsp.readFile(path.join(this.templatesDir, file), 'utf8');
          const tpl = JSON.parse(raw);
          if (tpl.id === id) {
            await fsp.unlink(path.join(this.templatesDir, file));
            return true;
          }
        } catch (_) {
          // Weiter
        }
      }
      throw new Error('Template nicht gefunden: ' + id);
    }
  }

  /**
   * Laedt ein einzelnes Template anhand seiner ID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getTemplate(id) {
    if (!id) return null;

    // Versuche direkt die Datei zu laden
    const directPath = path.join(this.templatesDir, id + '.json');
    try {
      const raw = await fsp.readFile(directPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      // Nicht direkt gefunden - durchsuche alle
    }

    const templates = await this.loadTemplates();
    return templates.find(t => t.id === id) || null;
  }

  /**
   * Listet Templates mit optionalen Filtern
   * @param {object} filters - { tags, category, difficulty }
   * @returns {Promise<object[]>}
   */
  async listTemplates(filters) {
    let templates = await this.loadTemplates();

    if (!filters || typeof filters !== 'object') return templates;

    // Filter nach Tag
    if (filters.tag) {
      const tag = filters.tag.toLowerCase();
      templates = templates.filter(t =>
        Array.isArray(t.tags) && t.tags.some(tg => tg.toLowerCase() === tag)
      );
    }

    // Filter nach Category
    if (filters.category) {
      const cat = filters.category.toLowerCase();
      templates = templates.filter(t =>
        t.category && t.category.toLowerCase() === cat
      );
    }

    // Filter nach Difficulty
    if (filters.difficulty) {
      const diff = filters.difficulty.toLowerCase();
      templates = templates.filter(t => t.difficulty === diff);
    }

    return templates;
  }

  /**
   * Importiert ein Template aus einem JSON-String
   * @param {string} jsonString
   * @returns {Promise<object>}
   */
  async importTemplate(jsonString) {
    let template;
    try {
      template = JSON.parse(jsonString);
    } catch (e) {
      throw new Error('Ungueltiges JSON: ' + e.message);
    }

    // Neue ID vergeben um Konflikte zu vermeiden
    template.id = this._generateId();
    template.createdAt = new Date().toISOString();
    template.updatedAt = new Date().toISOString();

    return this.saveTemplate(template);
  }

  /**
   * Exportiert ein Template als JSON-String
   * @param {string} id
   * @returns {Promise<string>}
   */
  async exportTemplate(id) {
    const template = await this.getTemplate(id);
    if (!template) {
      throw new Error('Template nicht gefunden: ' + id);
    }
    return JSON.stringify(template, null, 2);
  }

  /**
   * Bewertet ein Template (1-5 Sterne)
   * @param {string} id
   * @param {number} rating - 1 bis 5
   * @returns {Promise<object>}
   */
  async rateTemplate(id, rating) {
    const r = parseFloat(rating);
    if (isNaN(r) || r < 1 || r > 5) {
      throw new Error('Bewertung muss zwischen 1 und 5 liegen');
    }

    const template = await this.getTemplate(id);
    if (!template) {
      throw new Error('Template nicht gefunden: ' + id);
    }

    // Durchschnittsbewertung berechnen
    const currentRating = template.rating || 0;
    const currentCount = template.ratingCount || 0;
    const newCount = currentCount + 1;
    const newRating = Math.round(((currentRating * currentCount + r) / newCount) * 100) / 100;

    template.rating = newRating;
    template.ratingCount = newCount;
    template.updatedAt = new Date().toISOString();

    // Speichern (ohne validate weil es schon ein gueltiges Template ist)
    const filename = template.id + '.json';
    await fsp.writeFile(
      path.join(this.templatesDir, filename),
      JSON.stringify(template, null, 2),
      'utf8'
    );

    return template;
  }

  /**
   * Erstellt eine Kopie eines Templates mit neuem Namen
   * @param {string} id
   * @param {string} newName
   * @returns {Promise<object>}
   */
  async duplicateTemplate(id, newName) {
    const template = await this.getTemplate(id);
    if (!template) {
      throw new Error('Template nicht gefunden: ' + id);
    }

    const duplicate = {
      ...template,
      id: this._generateId(),
      name: newName || (template.name + ' (Kopie)'),
      rating: 0,
      ratingCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return this.saveTemplate(duplicate);
  }
}

module.exports = TemplateManager;
