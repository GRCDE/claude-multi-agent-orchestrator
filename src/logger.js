'use strict';
const winston = require('winston');
const Transport = require('winston-transport');

// ── In-Memory Log-Buffer ────────────────────────────────────
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

class BufferTransport extends Transport {
  log(info, callback) {
    logBuffer.push({
      timestamp: info.timestamp || new Date().toISOString(),
      level: info.level,
      message: info.message,
      meta: info[Symbol.for('splat')] || []
    });
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    callback();
  }
}

// Gemeinsames Basisformat (Timestamp + Fehler-Stacks)
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
