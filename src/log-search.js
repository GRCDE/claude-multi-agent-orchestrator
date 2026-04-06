'use strict';
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// ── Deutsche Stoppwörter ─────────────────────────────────────
const STOP_WORDS = new Set([
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'ist', 'sind',
  'war', 'hat', 'haben', 'wird', 'werden', 'kann', 'mit', 'von', 'zu', 'in',
  'auf', 'an', 'für', 'aus', 'bei', 'nach', 'über', 'unter', 'vor', 'durch',
  'nicht', 'auch', 'nur', 'noch', 'schon', 'so', 'wie', 'wenn', 'als', 'dann',
  'es', 'er', 'sie', 'wir', 'ihr', 'den', 'dem', 'des', 'im', 'am',
  // Englische Stoppwörter
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'has', 'have', 'had', 'will', 'be', 'been', 'being', 'do', 'does', 'did',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'it', 'he', 'she', 'we', 'they', 'this', 'that', 'not', 'no', 'so',
  'if', 'then', 'than', 'too', 'very', 'can', 'just', 'its', 'my', 'your'
]);

// ── Tokenisierung ────────────────────────────────────────────
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-zäöüß0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

// ── Query Parser ─────────────────────────────────────────────
// Unterstützt: AND, OR, NOT, "phrases"
function parseQuery(queryStr) {
  if (!queryStr || typeof queryStr !== 'string') return { terms: [], phrases: [], notTerms: [], operator: 'AND' };

  const phrases = [];
  let remaining = queryStr;

  // Phrasen extrahieren ("...")
  const phraseRegex = /"([^"]+)"/g;
  let match;
  while ((match = phraseRegex.exec(queryStr)) !== null) {
    phrases.push(match[1].toLowerCase());
    remaining = remaining.replace(match[0], ' ');
  }

  const parts = remaining.trim().split(/\s+/).filter(Boolean);
  const terms = [];
  const notTerms = [];
  let operator = 'AND';
  let hasExplicitOr = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const upper = part.toUpperCase();

    if (upper === 'AND') {
      // explizites AND, Operator bleibt AND
      continue;
    }
    if (upper === 'OR') {
      hasExplicitOr = true;
      continue;
    }
    if (upper === 'NOT' && i + 1 < parts.length) {
      notTerms.push(parts[i + 1].toLowerCase());
      i++; // Skip nächstes Wort
      continue;
    }
    if (part.startsWith('-') && part.length > 1) {
      notTerms.push(part.substring(1).toLowerCase());
      continue;
    }
    terms.push(part.toLowerCase());
  }

  if (hasExplicitOr) operator = 'OR';

  return { terms, phrases, notTerms, operator };
}

// ── LogSearchEngine ──────────────────────────────────────────
class LogSearchEngine {
  constructor() {
    // Invertierter Index: token → [{ docId, positions, field }]
    this._index = new Map();
    // Dokument-Speicher: docId → { content, projectId, agentId, type, timestamp, source }
    this._docs = new Map();
    // Statistiken
    this._stats = {
      indexedProjects: new Set(),
      totalEntries: 0,
      lastIndexed: null
    };
    // Term-Häufigkeit global (für Suggest)
    this._termFreq = new Map();
  }

  /**
   * Indexiert alle Agent-Konversationen eines Projekts
   */
  async indexProject(projectId, projectDir) {
    if (!projectId || !projectDir) return;

    // Alte Einträge dieses Projekts entfernen
    this._removeProjectDocs(projectId);

    try {
      const entries = await fsp.readdir(projectDir).catch(() => []);

      for (const entry of entries) {
        const fullPath = path.join(projectDir, entry);
        let stat;
        try { stat = await fsp.stat(fullPath); } catch { continue; }

        if (stat.isDirectory() && entry.startsWith('agent-')) {
          const agentId = entry;
          // conversation.jsonl lesen
          const convPath = path.join(fullPath, 'conversation.jsonl');
          try {
            const content = await fsp.readFile(convPath, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
              let parsed;
              try { parsed = JSON.parse(lines[i]); } catch { continue; }
              const text = parsed.content || parsed.message || '';
              if (!text) continue;
              const docId = `${projectId}/${agentId}/conv/${i}`;
              this._addDoc(docId, {
                content: text,
                projectId,
                agentId,
                type: 'conversation',
                timestamp: parsed.timestamp ? new Date(parsed.timestamp).getTime() : (stat.mtimeMs || Date.now()),
                source: convPath,
                line: i + 1,
                role: parsed.role || 'unknown'
              });
            }
          } catch { /* Datei nicht vorhanden */ }

          // output.txt lesen
          const outputPath = path.join(fullPath, 'output.txt');
          try {
            const content = await fsp.readFile(outputPath, 'utf8');
            if (content.trim()) {
              const docId = `${projectId}/${agentId}/output`;
              this._addDoc(docId, {
                content,
                projectId,
                agentId,
                type: 'conversation',
                timestamp: stat.mtimeMs || Date.now(),
                source: outputPath,
                line: 1,
                role: 'agent-output'
              });
            }
          } catch { /* Datei nicht vorhanden */ }
        }
      }

      // state.json lesen für Projekt-Kontext
      try {
        const stateRaw = await fsp.readFile(path.join(projectDir, 'state.json'), 'utf8');
        const state = JSON.parse(stateRaw);
        if (state.projectTitle || state.projectSummary) {
          const text = [state.projectTitle, state.projectSummary].filter(Boolean).join(' ');
          this._addDoc(`${projectId}/meta`, {
            content: text,
            projectId,
            agentId: null,
            type: 'conversation',
            timestamp: Date.now(),
            source: path.join(projectDir, 'state.json'),
            line: 1,
            role: 'meta'
          });
        }
      } catch { /* kein state.json */ }

      this._stats.indexedProjects.add(projectId);
      this._stats.lastIndexed = new Date().toISOString();
    } catch {
      // Projekt-Verzeichnis nicht lesbar
    }
  }

  /**
   * Full-Text-Suche mit Optionen
   */
  search(query, options = {}) {
    const {
      projectId = null,
      agentId = null,
      dateFrom = null,
      dateTo = null,
      type = 'all',
      limit = 50,
      offset = 0,
      highlight = false
    } = options;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return { results: [], total: 0, query, options };
    }

    const parsed = parseQuery(query);

    // Wenn keine Terme und keine Phrasen → leeres Ergebnis
    if (parsed.terms.length === 0 && parsed.phrases.length === 0) {
      return { results: [], total: 0, query, options };
    }

    // Kandidaten-Dokumente sammeln über den invertierten Index
    const docScores = new Map();
    const totalDocs = this._docs.size || 1;

    for (const term of parsed.terms) {
      const postings = this._index.get(term) || [];
      // IDF: log(totalDocs / (1 + docsContainingTerm))
      const idf = Math.log(totalDocs / (1 + postings.length));

      for (const posting of postings) {
        const current = docScores.get(posting.docId) || { score: 0, matchedTerms: new Set() };
        // TF: Anzahl der Vorkommen im Dokument
        const tf = posting.positions.length;
        current.score += tf * Math.max(idf, 0.1);
        current.matchedTerms.add(term);
        docScores.set(posting.docId, current);
      }
    }

    // Phrasensuche: Dokumente prüfen
    const phraseMatchDocs = new Set();
    if (parsed.phrases.length > 0) {
      for (const [docId, doc] of this._docs) {
        const contentLower = doc.content.toLowerCase();
        let allPhrasesMatch = true;
        for (const phrase of parsed.phrases) {
          if (!contentLower.includes(phrase)) {
            allPhrasesMatch = false;
            break;
          }
        }
        if (allPhrasesMatch) {
          phraseMatchDocs.add(docId);
          const current = docScores.get(docId) || { score: 0, matchedTerms: new Set() };
          current.score += parsed.phrases.length * 5; // Phrasen-Bonus
          current.matchedTerms.add('__phrase__');
          docScores.set(docId, current);
        }
      }
    }

    // NOT-Terme: Dokumente ausschließen
    const excludeDocs = new Set();
    for (const notTerm of parsed.notTerms) {
      const postings = this._index.get(notTerm) || [];
      for (const posting of postings) {
        excludeDocs.add(posting.docId);
      }
    }

    // Filtern und Ergebnisse zusammenstellen
    let results = [];

    for (const [docId, scoreData] of docScores) {
      // NOT ausschließen
      if (excludeDocs.has(docId)) continue;

      // AND-Modus: alle Terme müssen matchen
      if (parsed.operator === 'AND' && parsed.terms.length > 0) {
        let allTermsMatch = true;
        for (const term of parsed.terms) {
          if (!scoreData.matchedTerms.has(term)) {
            allTermsMatch = false;
            break;
          }
        }
        if (!allTermsMatch) continue;
      }

      // Phrasen: wenn Phrasen vorhanden, muss Dokument auch Phrasen matchen
      if (parsed.phrases.length > 0 && !phraseMatchDocs.has(docId)) continue;

      const doc = this._docs.get(docId);
      if (!doc) continue;

      // Filter: projectId
      if (projectId && doc.projectId !== projectId) continue;

      // Filter: agentId
      if (agentId && doc.agentId !== agentId) continue;

      // Filter: type
      if (type !== 'all' && doc.type !== type) continue;

      // Filter: Zeitraum
      if (dateFrom) {
        const from = new Date(dateFrom).getTime();
        if (doc.timestamp < from) continue;
      }
      if (dateTo) {
        const to = new Date(dateTo).getTime();
        if (doc.timestamp > to) continue;
      }

      let snippet = doc.content.substring(0, 200);
      if (highlight) {
        snippet = this._highlight(snippet, parsed);
      }

      results.push({
        docId,
        projectId: doc.projectId,
        agentId: doc.agentId,
        type: doc.type,
        role: doc.role,
        score: scoreData.score,
        snippet,
        source: doc.source,
        line: doc.line,
        timestamp: doc.timestamp
      });
    }

    // Nach Relevanz sortieren
    results.sort((a, b) => b.score - a.score);

    const total = results.length;

    // Pagination
    results = results.slice(offset, offset + limit);

    return { results, total, query, options: { projectId, agentId, type, limit, offset } };
  }

  /**
   * Suche in System-Logs (logs/ Verzeichnis + logBuffer)
   */
  searchLogs(query, options = {}) {
    const {
      limit = 50,
      offset = 0,
      highlight = false,
      dateFrom = null,
      dateTo = null
    } = options;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return { results: [], total: 0, query };
    }

    const parsed = parseQuery(query);
    if (parsed.terms.length === 0 && parsed.phrases.length === 0) {
      return { results: [], total: 0, query };
    }

    // System-Logs laden
    const allLogs = this._loadSystemLogs();

    let results = [];

    for (const logEntry of allLogs) {
      const text = (logEntry.message || '') + ' ' + JSON.stringify(logEntry.metadata || {});
      const textLower = text.toLowerCase();

      // NOT-Filter
      let excluded = false;
      for (const notTerm of parsed.notTerms) {
        if (textLower.includes(notTerm)) { excluded = true; break; }
      }
      if (excluded) continue;

      // Term-Matching
      let score = 0;
      let allMatch = true;
      for (const term of parsed.terms) {
        if (textLower.includes(term)) {
          const count = (textLower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
          score += count;
        } else {
          allMatch = false;
        }
      }

      // Phrasen-Matching
      let phrasesMatch = true;
      for (const phrase of parsed.phrases) {
        if (textLower.includes(phrase)) {
          score += 5;
        } else {
          phrasesMatch = false;
        }
      }

      // Operator-Logik
      if (parsed.operator === 'AND' && parsed.terms.length > 0 && !allMatch) continue;
      if (parsed.phrases.length > 0 && !phrasesMatch) continue;
      if (score === 0 && parsed.phrases.length === 0) continue;

      // Zeitraum-Filter
      if (dateFrom) {
        const from = new Date(dateFrom).getTime();
        const ts = new Date(logEntry.timestamp).getTime();
        if (ts < from) continue;
      }
      if (dateTo) {
        const to = new Date(dateTo).getTime();
        const ts = new Date(logEntry.timestamp).getTime();
        if (ts > to) continue;
      }

      let snippet = logEntry.message || '';
      if (highlight) {
        snippet = this._highlight(snippet, parsed);
      }

      results.push({
        id: logEntry.id,
        level: logEntry.level,
        category: logEntry.category,
        message: snippet,
        metadata: logEntry.metadata,
        timestamp: logEntry.timestamp,
        score
      });
    }

    results.sort((a, b) => b.score - a.score);
    const total = results.length;
    results = results.slice(offset, offset + limit);

    return { results, total, query };
  }

  /**
   * Suchindex-Statistiken
   */
  getSearchStats() {
    return {
      indexedProjects: this._stats.indexedProjects.size,
      totalEntries: this._docs.size,
      indexTokens: this._index.size,
      lastIndexed: this._stats.lastIndexed,
      topTerms: this._getTopTerms(10)
    };
  }

  /**
   * Index leeren
   */
  clearIndex() {
    this._index.clear();
    this._docs.clear();
    this._termFreq.clear();
    this._stats.indexedProjects.clear();
    this._stats.totalEntries = 0;
    this._stats.lastIndexed = null;
  }

  /**
   * Auto-Suggest: häufigste Begriffe die zum Prefix passen
   */
  getSuggestions(prefix, maxResults = 10) {
    if (!prefix || typeof prefix !== 'string' || prefix.length < 1) return [];
    const prefixLower = prefix.toLowerCase();
    const suggestions = [];

    for (const [term, freq] of this._termFreq) {
      if (term.startsWith(prefixLower)) {
        suggestions.push({ term, frequency: freq });
      }
    }

    suggestions.sort((a, b) => b.frequency - a.frequency);
    return suggestions.slice(0, maxResults);
  }

  // ── Private Methoden ───────────────────────────────────────

  _addDoc(docId, doc) {
    this._docs.set(docId, doc);
    this._stats.totalEntries = this._docs.size;

    const tokens = tokenize(doc.content);
    const positions = {};

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!positions[token]) positions[token] = [];
      positions[token].push(i);

      // Globale Term-Häufigkeit
      this._termFreq.set(token, (this._termFreq.get(token) || 0) + 1);
    }

    for (const [token, pos] of Object.entries(positions)) {
      if (!this._index.has(token)) this._index.set(token, []);
      this._index.get(token).push({ docId, positions: pos });
    }
  }

  _removeProjectDocs(projectId) {
    const toRemove = [];
    for (const [docId, doc] of this._docs) {
      if (doc.projectId === projectId) {
        toRemove.push(docId);
      }
    }
    for (const docId of toRemove) {
      this._docs.delete(docId);
      // Index-Einträge entfernen
      for (const [token, postings] of this._index) {
        const filtered = postings.filter(p => p.docId !== docId);
        if (filtered.length === 0) {
          this._index.delete(token);
        } else {
          this._index.set(token, filtered);
        }
      }
    }
    this._stats.indexedProjects.delete(projectId);
    this._stats.totalEntries = this._docs.size;
  }

  _highlight(text, parsed) {
    let result = text;
    // Terme highlighten
    for (const term of parsed.terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      result = result.replace(regex, '<mark>$1</mark>');
    }
    // Phrasen highlighten
    for (const phrase of parsed.phrases) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      result = result.replace(regex, '<mark>$1</mark>');
    }
    return result;
  }

  _getTopTerms(n) {
    const sorted = [...this._termFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
    return sorted.map(([term, frequency]) => ({ term, frequency }));
  }

  _loadSystemLogs() {
    const allLogs = [];

    // logBuffer aus logger.js
    try {
      const { logBuffer } = require('./logger');
      if (Array.isArray(logBuffer)) {
        allLogs.push(...logBuffer);
      }
    } catch { /* logger nicht verfügbar */ }

    // Rotierte Log-Dateien laden
    try {
      const { LOGS_DIR } = require('./logger');
      const files = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('log_') && f.endsWith('.jsonl'))
        .sort();
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8');
          const lines = content.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try { allLogs.push(JSON.parse(line)); } catch { /* ungültige Zeile */ }
          }
        } catch { /* Datei nicht lesbar */ }
      }
    } catch { /* LOGS_DIR nicht verfügbar */ }

    return allLogs;
  }
}

// ── Exports ──────────────────────────────────────────────────
module.exports = LogSearchEngine;
module.exports.LogSearchEngine = LogSearchEngine;
module.exports.tokenize = tokenize;
module.exports.parseQuery = parseQuery;
module.exports.STOP_WORDS = STOP_WORDS;
