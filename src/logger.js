'use strict';
const winston = require('winston');
const Transport = require('winston-transport');
const path = require('path');
const fs = require('fs');

// ── Konfiguration ────────────────────────────────────────────
const MAX_LOG_ENTRIES = 500;
const LOGS_DIR = path.join(__dirname, '..', 'logs');
let _logCounter = 0;

// Logs-Verzeichnis sicherstellen
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

// ── In-Memory Log-Buffer (strukturiert) ──────────────────────
const logBuffer = [];

/**
 * Kategorie aus Message oder Meta ableiten
 */
function detectCategory(message, meta) {
  if (meta && meta.category) return meta.category;
  const msg = (message || '').toLowerCase();
  if (msg.includes('agent')) return 'agent';
  if (msg.includes('koordinator') || msg.includes('coordinator') || msg.includes('plan')) return 'coordinator';
  if (msg.includes('api') || msg.includes('request') || msg.includes('endpoint')) return 'api';
  return 'system';
}

/**
 * Aeltere Eintraege in JSONL-Datei rotieren
 */
function rotateIfNeeded() {
  if (logBuffer.length <= MAX_LOG_ENTRIES) return;
  const overflow = logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  try {
    const filename = `log_${Date.now()}.jsonl`;
    const filepath = path.join(LOGS_DIR, filename);
    const lines = overflow.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(filepath, lines, 'utf8');
  } catch (err) {
    // Stille Fehler – wir wollen den Logger nicht crashen
    console.error('Log-Rotation fehlgeschlagen:', err.message);
  }
}

// ── Strukturierter Buffer-Transport ──────────────────────────
class BufferTransport extends Transport {
  log(info, callback) {
    const metaArr = info[Symbol.for('splat')] || [];
    const metaObj = metaArr.length > 0 ? metaArr[0] : {};
    const rawLevel = (info.level || 'info').replace(/\u001b\[[0-9;]*m/g, '');

    const entry = {
      id: ++_logCounter,
      timestamp: info.timestamp || new Date().toISOString(),
      level: rawLevel,
      category: detectCategory(info.message, metaObj),
      message: info.message,
      metadata: metaObj && typeof metaObj === 'object' && Object.keys(metaObj).length > 0 ? metaObj : null
    };

    logBuffer.push(entry);
    rotateIfNeeded();
    callback();
  }
}

/**
 * Alle rotierten Log-Dateien auflisten
 */
function getLogFiles() {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('log_') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    return files.map(f => {
      const stat = fs.statSync(path.join(LOGS_DIR, f));
      return { name: f, size: stat.size, created: stat.birthtime || stat.mtime };
    });
  } catch {
    return [];
  }
}

/**
 * Alle Logs exportieren (In-Memory + rotierte Dateien) als JSONL-String
 */
function exportAllLogs() {
  let allEntries = [];

  // Rotierte Dateien laden (aelteste zuerst)
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('log_') && f.endsWith('.jsonl'))
      .sort();
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try { allEntries.push(JSON.parse(line)); } catch {}
        }
      } catch {}
    }
  } catch {}

  // In-Memory-Eintraege anhaengen
  allEntries = allEntries.concat(logBuffer);

  return allEntries.map(e => JSON.stringify(e)).join('\n');
}

// ── Gemeinsames Basisformat (Timestamp + Fehler-Stacks) ──────
const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true })
);

// Konsole: mit Farben
const consoleFormat = process.env.NODE_ENV === 'production'
  ? winston.format.json()
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} ${level}: ${message}${metaStr}`;
      })
    );

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: baseFormat,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new BufferTransport()
  ]
});

module.exports = logger;
module.exports.logBuffer = logBuffer;
module.exports.getLogFiles = getLogFiles;
module.exports.exportAllLogs = exportAllLogs;
module.exports.LOGS_DIR = LOGS_DIR;
