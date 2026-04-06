'use strict';
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./src/logger');
const { t, setLanguage, getLanguage, LANGUAGES } = require('./src/i18n');
const { createRetryStrategy, validateConfig: validateRetryConfig, STRATEGIES: RETRY_STRATEGIES } = require('./src/retry-strategies');
const ConfigProfileManager = require('./src/config-profiles');
const SnapshotManager = require('./src/snapshot-manager');
const HealthMonitor = require('./src/health-monitor');

const PROJECTS_DIR = path.join(__dirname, 'projects');
const PROFILES_DIR = path.join(__dirname, 'profiles');
const IS_WIN = process.platform === 'win32';

// ── Konfiguration ─────────────────────────────────────────────
const CONFIG = {
  timeout: parseInt(process.env.AGENT_TIMEOUT) || 300000,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
  baseDelay: parseInt(process.env.RETRY_BASE_DELAY) || 5000,
  maxAgents: parseInt(process.env.MAX_AGENTS) || 10,
  concurrency: Math.min(10, Math.max(1, parseInt(process.env.AGENT_CONCURRENCY) || 3)),
  maxParallelAgents: Math.min(10, Math.max(1, parseInt(process.env.MAX_PARALLEL_AGENTS || process.env.AGENT_CONCURRENCY) || 3)),
  maxRounds: parseInt(process.env.MAX_ROUNDS) || 5,
  interimReportInterval: parseInt(process.env.INTERIM_REPORT_INTERVAL) || 3,
  autoRetry: process.env.AUTO_RETRY !== 'false',
  isolation: process.env.AGENT_ISOLATION || 'shared',
  webhookUrl: process.env.WEBHOOK_URL || '',
  tokenBudget: parseInt(process.env.TOKEN_BUDGET) || 0,
  warnTokenBudget: parseInt(process.env.WARN_TOKEN_BUDGET) || 0,
  inputCostPerMTok: parseFloat(process.env.INPUT_COST_PER_MTOK) || 3,
  outputCostPerMTok: parseFloat(process.env.OUTPUT_COST_PER_MTOK) || 15,
  verifyAgents: process.env.VERIFY_AGENTS === 'true',
  // Auto-Intervention Konfiguration
  autoInterventionEnabled: process.env.AUTO_INTERVENTION === 'true',
  autoInterventionRounds: parseInt(process.env.AUTO_INTERVENTION_ROUNDS) || 10,
  // Merge-Konfiguration: 'latest' | 'largest' | 'manual'
  mergeStrategy: process.env.MERGE_STRATEGY || 'latest',
  language: process.env.LANGUAGE || 'de',
  // Retry-Strategie Konfiguration
  retryStrategy: {
    strategy: process.env.RETRY_STRATEGY || 'exponential',
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    baseDelay: parseInt(process.env.RETRY_BASE_DELAY) || 2000,
    maxDelay: parseInt(process.env.RETRY_MAX_DELAY) || 30000,
    circuitThreshold: parseInt(process.env.CIRCUIT_THRESHOLD) || 5,
    circuitResetTime: parseInt(process.env.CIRCUIT_RESET_TIME) || 60000,
  },
};

// ── Aktive Retry-Strategie Instanz ──────────────────────────
let _activeRetryStrategy = createRetryStrategy(CONFIG.retryStrategy);

// ── Gueltige Intervention-Typen ──────────────────────────────
const VALID_INTERVENTION_TYPES = ['redirect', 'skip', 'restart', 'inject', 'complete'];

// ── Konstanten ───────────────────────────────────────────────
const MAX_CONVERSATION_RAM = 20;    // Max Messages pro Agent im RAM
const MAX_MESSAGES_PER_AGENT = 3;   // Max Inter-Agent Nachrichten
const MAX_QUESTIONS_PER_AGENT = 2;  // Max Fragen an Koordinator
const HISTORY_WORD_LIMIT = 2000;    // Max Woerter in trimHistory
const STATE_SAVE_INTERVAL = 2000;   // ms zwischen State-Saves
const AUTO_RETRY_DELAY = 10000;     // ms vor Auto-Retry
const MAX_CHECKPOINTS = 3;          // Max rotierte Checkpoints
const MAX_CONFIG_HISTORY = 20;      // Max Undo-Einträge für Config
const MAX_PLAN_HISTORY = 10;        // Max Undo-Einträge für Plan

// ── Semaphore für parallele Ausführung ────────────────────────
class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Math.min(10, max));
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.queue.shift()();
    }
  }
  get running() { return this.current; }
  get waiting() { return this.queue.length; }
}

// ── Rate-Limit Patterns ───────────────────────────────────────
const RATE_LIMIT_PATTERNS = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /529/,
  /HTTP\s*429/i,
  /capacity/i,
  /try again/i,
];

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some(p => p.test(text));
}

// ── Exponential Backoff Delay berechnen (mit Jitter, max 60s) ──
const MAX_BACKOFF_MS = 60000;
function calcBackoffDelay(baseDelay, attempt) {
  const exponential = baseDelay * Math.pow(2, attempt);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  // Jitter: ±20% um Thundering-Herd-Effekt zu vermeiden
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

// ── Netzwerkfehler Patterns ──────────────────────────────────
const NETWORK_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /socket hang up/i,
  /network/i,
];

function isNetworkError(text) {
  return NETWORK_ERROR_PATTERNS.some(p => p.test(text));
}

// ── Error-Message Sanitizing ──────────────────────────────────
function sanitizeError(message, maxLen = 200) {
  if (!message) return t('error.unknown', CONFIG.language);
  // Entferne potenzielle sensitive Pfade und kürze
  return message
    .replace(/[A-Z]:\\[^\s]*/gi, '[Pfad]')
    .replace(/\/home\/[^\s]*/g, '[Pfad]')
    .slice(0, maxLen);
}

// ── Input-Sanitierung gegen Prompt Injection ──────────────────
function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  // Entferne Steuerzeichen, behalte Zeilenumbrüche
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

// ── Pfad-Validierung ──────────────────────────────────────────
function validateWorkDir(dir) {
  const resolved = path.resolve(dir);
  const projectsResolved = path.resolve(PROJECTS_DIR);
  if (!resolved.startsWith(projectsResolved)) {
    throw new Error(`Ungültiger Arbeitsordner: ${dir} liegt nicht innerhalb von ${PROJECTS_DIR}`);
  }
  return resolved;
}

// ── History Token-Limit ───────────────────────────────────────
function trimHistory(text, maxWords = HISTORY_WORD_LIMIT) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return '[' + t('misc.history_trimmed', CONFIG.language) + ']\n' + words.slice(-maxWords).join(' ');
}

// ── Token-Schätzung und Kosten ────────────────────────────────
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

function estimateCost(inputTokens, outputTokens) {
  // Konfigurierbares Pricing: Default Sonnet $3/MTok Input, $15/MTok Output
  const inputCostPerToken = CONFIG.inputCostPerMTok / 1000000;
  const outputCostPerToken = CONFIG.outputCostPerMTok / 1000000;
  return inputTokens * inputCostPerToken + outputTokens * outputCostPerToken;
}

function createTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
}

function accumulateTokenUsage(usage, inputText, outputText) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  usage.estimatedCost = parseFloat(estimateCost(usage.inputTokens, usage.outputTokens).toFixed(6));
  return { inputTokens, outputTokens };
}

// ── Claude CLI Verfügbarkeit prüfen (mit Versions-Check) ──────
const MIN_CLI_VERSION = '1.0.0';

function parseVersion(versionStr) {
  // Extrahiere Versionsnummer aus Strings wie "claude 1.2.3" oder "1.2.3"
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
}

function isVersionCompatible(versionStr, minVersion) {
  const current = parseVersion(versionStr);
  const required = parseVersion(minVersion);
  if (!current || !required) return true; // Im Zweifel durchlassen
  if (current.major !== required.major) return current.major > required.major;
  if (current.minor !== required.minor) return current.minor > required.minor;
  return current.patch >= required.patch;
}

function checkClaudeCli() {
  const cmd = IS_WIN ? 'claude.cmd' : 'claude';
  try {
    const output = execSync(`${cmd} --version`, { stdio: 'pipe', shell: IS_WIN, timeout: 10000 });
    const versionOutput = output.toString().trim();

    // Versions-Kompatibilität prüfen
    if (!isVersionCompatible(versionOutput, MIN_CLI_VERSION)) {
      const parsed = parseVersion(versionOutput);
      const versionStr = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : versionOutput;
      return {
        ok: false,
        error: `Claude CLI Version ${versionStr} ist zu alt. Mindestens Version ${MIN_CLI_VERSION} wird benötigt.\n` +
          'Bitte aktualisiere Claude Code CLI: npm update -g @anthropic-ai/claude-code'
      };
    }

    logger.info('Claude CLI gefunden', { version: versionOutput.slice(0, 50) });
    return { ok: true, version: versionOutput };
  } catch (e) {
    if (e.message.includes('ENOENT') || e.message.includes('not found') || e.message.includes('not recognized') || e.status === 127) {
      return {
        ok: false,
        error: 'Claude CLI nicht installiert oder nicht im PATH. Bitte installiere Claude Code CLI:\n' +
          'npm install -g @anthropic-ai/claude-code\n\n' +
          'Dokumentation: https://docs.anthropic.com/en/docs/claude-code\n' +
          'Stelle sicher, dass "claude" im PATH verfügbar ist (Terminal neu starten nach Installation).'
      };
    }
    // CLI existiert, anderer Fehler (z.B. Netzwerk beim Version-Check)
    logger.warn('Claude CLI Version-Check fehlgeschlagen, fahre fort', { error: e.message });
    return { ok: true };
  }
}

// ── Run claude CLI (mit Rate-Limit Retry + Timeout + Process-Tracking) ──
// opts.timeout: optionaler Timeout in ms (überschreibt CONFIG.timeout)
function runClaude(prompt, workDir, emitter, activeProcesses, signal, opts = {}) {
  return _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, 0, opts);
}

function _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, attempt, opts = {}) {
  const effectiveTimeout = opts.timeout || CONFIG.timeout;
  return new Promise((resolve, reject) => {
    // Abbruch-Check
    if (signal && signal.aborted) {
      reject(new Error('Abgebrochen'));
      return;
    }

    const args = ['--dangerously-skip-permissions', '-p', prompt];
    // Security: shell:true nur auf Windows (nötig für .cmd), sonst weglassen
    const spawnOpts = {
      cwd: workDir || __dirname,
      env: { ...process.env },
    };
    if (IS_WIN) {
      spawnOpts.shell = true;
    }

    const cmd = IS_WIN ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, args, spawnOpts);

    // Prozess tracken
    if (activeProcesses) activeProcesses.add(proc);

    let out = '';
    let err = '';
    let killed = false;
    let timer = null;

    // Aufräum-Funktion
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      proc.removeAllListeners();
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      if (activeProcesses) activeProcesses.delete(proc);
    };

    // Bei Abort-Signal: Prozess beenden
    const onAbort = () => {
      killed = true;
      cleanup();
      proc.kill('SIGTERM');
      // Fallback: nach 5s SIGKILL
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort, Prozess evtl. bereits beendet */ } }, 5000);
      reject(new Error('Abgebrochen'));
    };
    if (signal) {
      if (signal.aborted) { cleanup(); reject(new Error('Abgebrochen')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      out += chunk;
      if (emitter && emitter._streamingAgentIdx !== undefined) {
        const agentIdx = emitter._streamingAgentIdx;
        // liveOutput am Agent aktualisieren (letzte 2000 Zeichen)
        if (emitter.agents && emitter.agents[agentIdx]) {
          const prev = emitter.agents[agentIdx].liveOutput || '';
          emitter.agents[agentIdx].liveOutput = (prev + chunk).slice(-2000);
        }
        // Throttled Stream-Event: max alle 500ms senden
        if (!emitter._streamThrottleTimer) {
          emitter._streamThrottleTimer = setTimeout(() => {
            emitter._streamThrottleTimer = null;
            const liveText = (emitter.agents && emitter.agents[agentIdx])
              ? emitter.agents[agentIdx].liveOutput || ''
              : chunk;
            emitter.emit('agent_stream', {
              index: agentIdx,
              chunk: liveText.slice(-2000)
            });
          }, 500);
        }
      }
    });
    proc.stderr.on('data', d => { err += d.toString(); });

    proc.on('error', e => {
      cleanup();
      if (signal) signal.removeEventListener('abort', onAbort);
      if (e.code === 'ENOENT') {
        reject(new Error('Claude CLI nicht gefunden. Bitte installiere Claude Code CLI und stelle sicher, dass "claude" im PATH liegt.'));
      } else {
        reject(e);
      }
    });

    proc.on('close', code => {
      cleanup();
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killed) return; // Timeout oder Abort hat bereits rejected

      const combined = (out + ' ' + err).trim();

      // Retry-Logik via konfigurierbare Strategie
      const isRetryable = isRateLimited(combined) || isNetworkError(combined);
      const errorType = isRateLimited(combined) ? 'rate-limit' : (isNetworkError(combined) ? 'network' : null);

      if (isRetryable) {
        const strategy = _activeRetryStrategy;
        const errorObj = new Error(errorType === 'rate-limit' ? 'Rate-Limit' : 'Netzwerkfehler');
        errorObj.type = errorType;

        if (strategy.shouldRetry(attempt, errorObj)) {
          const delay = strategy.getDelay(attempt);
          const delaySec = Math.round(delay / 1000);
          const maxRetries = strategy.maxRetries || CONFIG.maxRetries;

          logger.warn(errorType === 'rate-limit' ? 'Rate-Limit erkannt' : 'Netzwerkfehler erkannt', {
            attempt: attempt + 1, maxRetries, delayMs: delay, delaySec, strategy: strategy.name
          });

          if (emitter) {
            if (errorType === 'rate-limit') {
              emitter.emit('rate-limit', {
                retryIn: delaySec,
                attempt: attempt + 1,
                maxRetries,
              });
              emitter.emit('rate_limit', {
                attempt: attempt + 1,
                maxRetries,
                waitMs: delay,
                message: `Rate-Limit erkannt, warte ${delaySec}s (Versuch ${attempt + 1}/${maxRetries})…`
              });
            } else {
              emitter.emit('network_error', {
                attempt: attempt + 1,
                maxRetries,
                waitMs: delay,
                message: `Netzwerkfehler, warte ${delaySec}s (Versuch ${attempt + 1}/${maxRetries})…`
              });
            }

            // CircuitBreaker-spezifische Events
            if (strategy.name === 'circuit-breaker' && strategy.state === 'open') {
              emitter.emit('circuit_breaker_opened', {
                failureCount: strategy._failureCount,
                resetTime: strategy.circuitResetTime,
              });
            }
          }

          setTimeout(() => {
            _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, attempt + 1, opts)
              .then(resolve)
              .catch(reject);
          }, delay);
          return;
        }

        // Strategie sagt: kein Retry mehr
        const maxRetries = strategy.maxRetries || CONFIG.maxRetries;
        if (errorType === 'rate-limit') {
          logger.error('Rate-Limit nicht aufgelöst nach max Retries', { attempts: maxRetries, strategy: strategy.name });
          reject(new Error(`Rate-Limit nach ${maxRetries} Versuchen nicht aufgelöst. Bitte warte einige Minuten und versuche es erneut.`));
        } else {
          logger.error('Netzwerkfehler nicht behoben nach max Retries', { attempts: maxRetries, strategy: strategy.name });
          reject(new Error(`Netzwerkfehler nach ${maxRetries} Versuchen nicht behoben. Bitte Netzwerkverbindung prüfen.`));
        }
        return;
      }

      if (out.trim()) resolve(out.trim());
      else if (err.trim()) resolve(err.trim());
      else reject(new Error(`claude exited with code ${code}`));
    });

    // Timeout: SIGTERM, nach 5s SIGKILL Fallback
    const timeoutSec = Math.round(effectiveTimeout / 1000);
    timer = setTimeout(() => {
      killed = true;
      cleanup();
      if (signal) signal.removeEventListener('abort', onAbort);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort, Prozess evtl. bereits beendet */ } }, 5000);
      logger.error('Agent-Timeout erreicht', { timeoutSec, workDir });
      if (emitter) {
        emitter.emit('agent_timeout', {
          timeoutSec,
          workDir,
          message: `Timeout nach ${timeoutSec}s erreicht`
        });
      }
      reject(new Error(`Timeout nach ${timeoutSec}s – der Agent hat zu lange gebraucht. Timeout konfigurierbar via AGENT_TIMEOUT Umgebungsvariable oder Config-API (aktuell: ${timeoutSec}s).`));
    }, effectiveTimeout);
  });
}

// ── Zirkulaere Abhaengigkeiten erkennen ───────────────────────
function detectCircularDeps(tasks) {
  const taskCount = tasks.length;
  const adj = new Array(taskCount).fill(null).map(() => []);
  for (let i = 0; i < taskCount; i++) {
    const deps = tasks[i].depends_on || [];
    for (const d of deps) {
      if (d >= 0 && d < taskCount) adj[d].push(i);
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(taskCount).fill(WHITE);
  const circular = new Set();
  function dfs(u) {
    color[u] = GRAY;
    for (const v of adj[u]) {
      if (color[v] === GRAY) { circular.add(u); circular.add(v); }
      else if (color[v] === WHITE) { dfs(v); }
    }
    color[u] = BLACK;
  }
  for (let i = 0; i < taskCount; i++) {
    if (color[i] === WHITE) dfs(i);
  }
  return circular;
}

// ── JSON-Validierung fuer Koordinator-Plan ────────────────────
function validatePlan(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Koordinator-Ausgabe ist kein gültiges Objekt');
  }
  if (typeof parsed.project_title !== 'string' || !parsed.project_title.trim()) {
    throw new Error('Koordinator-Plan fehlt "project_title" (string)');
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('Koordinator-Plan fehlt "tasks" (nicht-leeres Array)');
  }
  for (let i = 0; i < parsed.tasks.length; i++) {
    const t = parsed.tasks[i];
    if (!t.title || !t.task || !t.deliverable) {
      throw new Error(`Task ${i + 1} fehlt title, task oder deliverable`);
    }
    // depends_on validieren (optional)
    if (t.depends_on !== undefined) {
      if (!Array.isArray(t.depends_on)) {
        t.depends_on = [];
      } else {
        t.depends_on = t.depends_on
          .filter(d => Number.isInteger(d) && d >= 0 && d < parsed.tasks.length && d !== i);
      }
    } else {
      t.depends_on = [];
    }
  }
  // Zirkulaere Abhaengigkeiten erkennen und bereinigen
  const circularNodes = detectCircularDeps(parsed.tasks);
  if (circularNodes.size > 0) {
    logger.warn('Zirkulaere Abhaengigkeiten erkannt, werden entfernt', {
      betroffeneAgenten: [...circularNodes].map(i => i + 1)
    });
    for (const idx of circularNodes) {
      parsed.tasks[idx].depends_on = [];
    }
  }
  return parsed;
}

// ── Prompt-Templates laden ───────────────────────────────────
const HARDCODED_PROMPTS = {
  coordinator_plan: 'Du bist Projekt-Koordinator. Analysiere das Projekt und erstelle genau {agentCount} Teilaufgaben.\n\nConstraints:\n- Aufgaben sollen moeglichst unabhaengig sein\n- Falls eine Aufgabe auf das Ergebnis einer anderen angewiesen ist, nutze "depends_on" mit den 0-basierten Indizes der Abhaengigkeiten\n- Aufgaben ohne Abhaengigkeiten bekommen ein leeres Array: "depends_on":[]\n- Jede Task-Beschreibung soll 100-500 Zeichen lang sein\n- Keine Ueberlappung zwischen den Aufgaben\n- Jede Aufgabe soll verschiedene Faehigkeiten/Bereiche abdecken\n\nAntworte NUR mit validem JSON (kein Markdown, kein Text davor/danach):\n{"project_title":"string","summary":"1-2 Saetze auf Deutsch","quality_notes":"Kurze Begruendung der Aufgabenstruktur","tasks":[{"title":"Kurztitel","task":"Detaillierte Aufgabe","deliverable":"Was der Agent liefern soll","role":"Passende Rolle, z.B. Backend-Entwickler, Frontend-Entwickler, DevOps-Ingenieur, etc.","depends_on":[]}]}\n\nProjekt: {description}',
  coordinator_answer: 'Du bist Projekt-Koordinator. Beantworte die Frage des Agenten kurz und pr\u00e4zise auf Deutsch.\n\nProjektbeschreibung: {description}\n\nAlle Agenten-Aufgaben:\n{taskSummary}\n\nAgent {agentNum} \u2013 Aufgabe: {agentTitle}\n{agentTask}\n\n{previousQuestions}Agent {agentNum} fragt: {question}\n\nAntworte direkt und konkret.',
  coordinator_summary: 'Du bist Projekt-Koordinator. Alle Agenten sind fertig. Erstelle eine kurze, pr\u00e4gnante Zusammenfassung auf Deutsch.\n\nProjektbeschreibung: {description}\n\nErgebnisse der Agenten:\n{agentResults}\n\nFasse zusammen:\n1. Was wurde insgesamt erreicht?\n2. Welche Agenten waren erfolgreich, welche nicht?\n3. Gibt es offene Punkte oder Empfehlungen?\n\nAntworte in 3-6 S\u00e4tzen, klar und konkret.',
  agent_system: '{rolePrefix}Du bist Agent {agentNum} im Projekt "{projectTitle}".\nDu arbeitest in deinem Verzeichnis: {agentDir}\n\nDeine Aufgabe: {task}\nDein Lieferergebnis: {deliverable}\n\nAndere Agenten im Projekt (arbeiten parallel \u2013 NICHT von ihnen abh\u00e4ngig machen):\n{otherAgentsCtx}\n{sharedCtx}\nRegeln:\n1. Arbeite konkret und erstelle echte Dateien in deinem Verzeichnis\n2. Wenn du eine Kl\u00e4rung vom Koordinator brauchst: schreibe EXAKT "FRAGE: [deine genaue Frage]" und STOPPE SOFORT danach \u2013 schreibe NICHTS mehr nach der Frage\n3. Maximal 2 Fragen erlaubt \u2013 nutze sie sinnvoll\n4. Wenn du fertig bist: schreibe am Ende EXAKT "FERTIG" als letztes Wort\n5. Schreibe NIEMALS "FRAGE:" und "FERTIG" in der gleichen Antwort\n6. Um einem anderen Agenten eine Nachricht zu senden: "NACHRICHT AN Agent X: [deine Nachricht]"\n7. Um Kontext mit anderen Agenten zu teilen: "KONTEXT: schluessel = wert" (z.B. "KONTEXT: api_port = 8080")\n8. Um eine Datei fuer andere Agenten bereitzustellen: "SHARED FILE: dateiname" (Datei wird aus deinem Verzeichnis nach shared/ kopiert)',
  agent_verify: 'Du bist ein Qualit\u00e4tspr\u00fcfer. Pr\u00fcfe ob der Agent seine Aufgabe erf\u00fcllt hat.\n\nAufgabe: {task}\nLieferergebnis erwartet: {deliverable}\nErstellte Dateien: {fileList}\n\nBewerte mit JSON: {"verdict":"pass|partial|fail","findings":"Kurze Begr\u00fcndung","suggestions":"Verbesserungsvorschl\u00e4ge oder leer"}',
};

function loadPrompts() {
  const promptsFile = process.env.PROMPTS_FILE || 'prompts.json';
  const candidates = [
    path.join(__dirname, promptsFile),
    path.join(__dirname, 'prompts.default.json'),
  ];
  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const merged = { ...HARDCODED_PROMPTS };
      for (const key of Object.keys(HARDCODED_PROMPTS)) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) {
          merged[key] = parsed[key];
        }
      }
      logger.info('Prompt-Templates geladen', { source: filePath, keys: Object.keys(parsed).filter(k => typeof parsed[k] === 'string') });
      return merged;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger.warn('Fehler beim Laden der Prompt-Templates', { file: filePath, error: e.message });
      }
    }
  }
  logger.info('Verwende eingebaute Prompt-Templates (keine prompts.json oder prompts.default.json gefunden)');
  return { ...HARDCODED_PROMPTS };
}

function renderPrompt(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split('{' + key + '}').join(value != null ? String(value) : '');
  }
  return result;
}

// ── Hook-System: Lade optionale hooks.js aus Projekt-Root ────
function loadHooks() {
  try {
    const hooks = require('./hooks');
    if (hooks && typeof hooks === 'object') {
      logger.info('Hooks geladen', { hooks: Object.keys(hooks).filter(k => typeof hooks[k] === 'function') });
      return hooks;
    }
    return {};
  } catch (e) {
    // hooks.js existiert nicht oder hat Syntaxfehler
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.warn('Fehler beim Laden von hooks.js', { error: e.message });
    }
    return {};
  }
}

// ── Rollen-System ────────────────────────────────────────────
const ROLES_FILE = path.join(__dirname, 'roles.json');

function loadRoles() {
  try {
    const raw = fs.readFileSync(ROLES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const defaultRoles = Array.isArray(parsed.defaultRoles) ? parsed.defaultRoles : [];
    const customRoles = Array.isArray(parsed.customRoles) ? parsed.customRoles : [];
    logger.info('Rollen geladen', { default: defaultRoles.length, custom: customRoles.length });
    return { defaultRoles, customRoles };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      logger.warn('Fehler beim Laden der Rollen', { error: e.message });
    }
    logger.info('Keine roles.json gefunden, verwende leere Rollen');
    return { defaultRoles: [], customRoles: [] };
  }
}

function saveRoles(rolesData) {
  try {
    fs.writeFileSync(ROLES_FILE, JSON.stringify(rolesData, null, 2), 'utf-8');
    logger.info('Rollen gespeichert', { default: rolesData.defaultRoles.length, custom: rolesData.customRoles.length });
  } catch (e) {
    logger.error('Fehler beim Speichern der Rollen', { error: e.message });
    throw new Error('Rollen konnten nicht gespeichert werden: ' + e.message);
  }
}

function getAllRoles() {
  const data = loadRoles();
  return [...data.defaultRoles, ...data.customRoles];
}

function getRoleById(roleId) {
  if (!roleId) return null;
  const all = getAllRoles();
  return all.find(r => r.id === roleId) || null;
}

function buildRolePrefix(roleId) {
  const role = getRoleById(roleId);
  if (!role) return '';
  return role.systemPrompt + '\n\n';
}

// ── Schneller String-Hash (djb2) für Delta-Write Erkennung ───
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
  }
  return hash;
}

// ── Orchestrator ─────────────────────────────────────────────
class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this._abortController = new AbortController();
    this._activeProcesses = new Set();
    this.hooks = loadHooks();
    this.prompts = loadPrompts();
    this.snapshotManager = new SnapshotManager(path.join(__dirname, 'snapshots'));
    this.profileManager = new ConfigProfileManager(PROFILES_DIR);
    this.healthMonitor = new HealthMonitor({
      getOrchestratorInfo: () => ({
        phase: this.phase || 'idle',
        agentCount: this.agents ? this.agents.length : 0,
        activeAgents: this.agents ? this.agents.filter(a => a.status === 'running').length : 0,
      }),
    });
    this.healthMonitor.on('health_check', (data) => {
      this.emit('health_check', data);
    });
    this.healthMonitor.on('alert_triggered', (data) => {
      this.emit('alert_triggered', data);
    });
    this.healthMonitor.on('alert_cleared', (data) => {
      this.emit('alert_cleared', data);
    });
    this.healthMonitor.on('status_changed', (data) => {
      this.emit('status_changed', data);
    });
    this.healthMonitor.start();
    this.reset();
  }

  // ── Hook ausführen (Fehler dürfen NIEMALS den Hauptprozess crashen) ──
  async _runHook(name, data) {
    if (!this.hooks[name] || typeof this.hooks[name] !== 'function') return;
    try {
      await this.hooks[name](data);
    } catch (e) {
      logger.warn('Hook-Fehler', { hook: name, error: e.message });
    }
  }

  // ── Webhook-Benachrichtigung senden ──────────────────────────
  async _sendWebhook(event, data) {
    const webhookUrl = CONFIG.webhookUrl;
    if (!webhookUrl) return;

    try {
      const parsed = new URL(webhookUrl);
      const transport = parsed.protocol === 'https:' ? https : http;

      const payload = JSON.stringify({
        event,
        data,
        projectId: this.projectId,
        timestamp: new Date().toISOString(),
      });

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      };

      await new Promise((resolve, reject) => {
        const req = transport.request(options, (res) => {
          // Antwort verwerfen, uns interessiert nur ob es ankam
          res.resume();
          resolve();
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Webhook Timeout nach 5s'));
        });
        req.write(payload);
        req.end();
      });

      logger.info('Webhook gesendet', { event, url: parsed.hostname });
    } catch (e) {
      // Webhook-Fehler dürfen NIEMALS den Hauptprozess crashen
      logger.warn('Webhook-Fehler', { event, error: e.message });
    }
  }

  reset() {
    // Ausstehende State-Saves abbrechen
    if (this._saveStateTimer) {
      clearTimeout(this._saveStateTimer);
      this._saveStateTimer = null;
    }
    this._saveStatePending = false;
    this._lastSavedStateHash = null; // Letzter gespeicherter State-Hash für Delta-Write

    // Alle laufenden Prozesse beenden
    this._abortController.abort();
    this._abortController = new AbortController();
    for (const proc of this._activeProcesses) {
      try { proc.kill('SIGTERM'); } catch { /* best-effort, Prozess evtl. bereits beendet */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort, Prozess evtl. bereits beendet */ } }, 5000);
    }
    this._activeProcesses.clear();

    this.projectId = null;
    this.projectDir = null;
    this.projectDesc = '';
    this.projectTitle = '';
    this.tags = [];
    this.projectSummary = '';
    this.tasks = [];
    this._lastMergeResult = null;
    this.agents = [];
    this.coordLog = [];
    this.coordStatus = 'idle';
    this.coordActiveQ = null;
    this.coordInterimReports = [];
    this.coordFinalReport = null;
    this.coordAdaptations = [];
    this.phase = 'idle';
    this.startedAt = null;
    this.completedAt = null;
    this.totalDuration = null;
    this.projectScore = null;
    this.projectEta = null;
    this.projectPercent = 0;
    this._lastProjectEtaSeconds = null;
    this._approvalResolver = null;
    this._messageBoard = new Map(); // Inter-Agent Nachrichten: agentIndex → [{from, text}]
    this._sharedContextBoard = []; // Shared Context Board: [{agentIndex, key, value, timestamp}]
    this.activityLog = [];
    this.coordinatorTokenUsage = createTokenUsage();
    this._budgetWarned = false;
    this._budgetExceeded = false;

    // Pending Interventions zurücksetzen
    if (this.agents && this.agents.length > 0) {
      for (const agent of this.agents) {
        agent.pendingIntervention = null;
        agent.pendingInterventionType = null;
        agent.interventionHistory = [];
      }
    }

    // Undo/Redo Stacks leeren
    this._configUndoStack = [];
    this._configRedoStack = [];
    this._planUndoStack = [];
    this._planRedoStack = [];

    // Aktives Profil zuruecksetzen
    if (this.profileManager) {
      this.profileManager.setActiveProfile(null);
    }
  }

  emit(event, data) {
    super.emit('update', { event, data, ts: Date.now() });
    super.emit(event, data);
  }

  _logActivity(type, data) {
    const entry = { type, data, ts: Date.now() };
    this.activityLog.push(entry);
    if (this.activityLog.length > 200) {
      this.activityLog.shift();
    }
    this.emit('activity', entry);
  }

  getState() {
    // Projekt-Statistiken aus Agent-Stats aggregieren
    let totalFiles = 0, totalSize = 0, totalLines = 0;
    for (const agent of this.agents) {
      if (agent.stats) {
        totalFiles += agent.stats.filesCreated || 0;
        totalSize += agent.stats.totalFileSize || 0;
        totalLines += agent.stats.linesOfCode || 0;
      }
    }
    // Token-Usage aggregieren
    const totalTokenUsage = createTokenUsage();
    totalTokenUsage.inputTokens += this.coordinatorTokenUsage.inputTokens;
    totalTokenUsage.outputTokens += this.coordinatorTokenUsage.outputTokens;
    for (const agent of this.agents) {
      if (agent.tokenUsage) {
        totalTokenUsage.inputTokens += agent.tokenUsage.inputTokens;
        totalTokenUsage.outputTokens += agent.tokenUsage.outputTokens;
      }
    }
    totalTokenUsage.totalTokens = totalTokenUsage.inputTokens + totalTokenUsage.outputTokens;
    totalTokenUsage.estimatedCost = parseFloat(estimateCost(totalTokenUsage.inputTokens, totalTokenUsage.outputTokens).toFixed(6));

    return {
      phase: this.phase,
      projectId: this.projectId,
      projectTitle: this.projectTitle,
      projectSummary: this.projectSummary,
      projectDesc: this.projectDesc || '',
      tags: this.tags || [],
      tasks: this.tasks,
      coordinator: {
        status: this.coordStatus,
        summary: this.projectSummary,
        activeQuestion: this.coordActiveQ,
        log: this.coordLog,
        tokenUsage: this.coordinatorTokenUsage,
        interimReports: this.coordInterimReports,
        finalReport: this.coordFinalReport,
        adaptations: this.coordAdaptations
      },
      agents: this.agents,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      totalDuration: this.totalDuration,
      projectStats: { totalFiles, totalSize, totalLines },
      projectScore: this.projectScore || null,
      totalTokenUsage,
      budget: {
        maxTokenBudget: CONFIG.tokenBudget,
        warnTokenBudget: CONFIG.warnTokenBudget,
        inputCostPerMTok: CONFIG.inputCostPerMTok,
        outputCostPerMTok: CONFIG.outputCostPerMTok,
        exceeded: this._budgetExceeded || false,
        warned: this._budgetWarned || false,
      },
      activityLog: this.activityLog.slice(-100), // Nur letzte 100 in state.json
      sharedContextBoard: this._sharedContextBoard || [],
      projectEta: this.projectEta || null,
      projectPercent: this.projectPercent || 0,
    };
  }

  // ── State auf Disk speichern (gedrosselt: max 1x pro 2s, mit Delta-Write) ───
  async _saveState() {
    if (!this.projectDir) return;
    this._saveStatePending = true;
    if (this._saveStateTimer) return; // Bereits geplant
    this._saveStateTimer = setTimeout(async () => {
      this._saveStateTimer = null;
      if (!this._saveStatePending) return;
      this._saveStatePending = false;
      try {
        const json = JSON.stringify(this.getState(), null, 2);
        const hash = djb2Hash(json);
        // Delta-Write: überspringe wenn sich nichts geändert hat
        if (hash === this._lastSavedStateHash) {
          logger.debug('State-Save übersprungen (keine Änderung)', { hash });
          return;
        }
        await fsp.writeFile(
          path.join(this.projectDir, 'state.json'),
          json
        );
        this._lastSavedStateHash = hash;
      } catch (e) {
        logger.error('State-Save fehlgeschlagen', { error: e.message });
      }
    }, STATE_SAVE_INTERVAL);
  }

  // Sofortiges Speichern erzwingen (z.B. bei Projektende/Shutdown – immer schreiben)
  async _saveStateImmediate() {
    if (this._saveStateTimer) {
      clearTimeout(this._saveStateTimer);
      this._saveStateTimer = null;
    }
    this._saveStatePending = false;
    if (!this.projectDir) return;
    try {
      const json = JSON.stringify(this.getState(), null, 2);
      await fsp.writeFile(
        path.join(this.projectDir, 'state.json'),
        json
      );
      this._lastSavedStateHash = djb2Hash(json);
    } catch (e) {
      logger.error('State-Save fehlgeschlagen', { error: e.message });
    }
  }

  // ── Checkpoint-System (Crash-Recovery) ─────────────────────
  async _createCheckpoint(reason) {
    if (!this.projectDir) return;
    try {
      const json = JSON.stringify({
        ...this.getState(),
        _checkpoint: {
          reason,
          createdAt: Date.now(),
          createdAtISO: new Date().toISOString(),
          projectDir: this.projectDir,
          projectDesc: this.projectDesc,
        }
      }, null, 2);

      // Atomar: in temp-Datei schreiben, dann umbenennen
      const tempFile = path.join(this.projectDir, 'state.checkpoint.tmp');
      const targetFile = path.join(this.projectDir, 'state.checkpoint.1.json');

      // Rotation: 3 → löschen, 2 → 3, 1 → 2
      for (let i = MAX_CHECKPOINTS; i >= 2; i--) {
        const from = path.join(this.projectDir, `state.checkpoint.${i - 1}.json`);
        const to = path.join(this.projectDir, `state.checkpoint.${i}.json`);
        try {
          await fsp.rename(from, to);
        } catch (e) {
          if (e.code !== 'ENOENT') logger.warn('Checkpoint-Rotation fehlgeschlagen', { from, to, error: e.message });
        }
      }
      // Alten letzten Checkpoint löschen falls über Limit
      try {
        await fsp.unlink(path.join(this.projectDir, `state.checkpoint.${MAX_CHECKPOINTS + 1}.json`));
      } catch (e) {
        if (e.code !== 'ENOENT') logger.warn('Checkpoint-Cleanup fehlgeschlagen', { error: e.message });
      }

      // Atomares Schreiben: temp → rename
      await fsp.writeFile(tempFile, json);
      await fsp.rename(tempFile, targetFile);

      logger.info('Checkpoint erstellt', { reason, projectId: this.projectId });
      this.emit('checkpoint_created', { reason, projectId: this.projectId, timestamp: Date.now() });
    } catch (e) {
      logger.error('Checkpoint-Erstellung fehlgeschlagen', { reason, error: e.message });
    }
  }

  // ── Crash-Recovery Erkennung ──────────────────────────────
  static async _detectCrashRecovery() {
    try {
      const projectsDir = PROJECTS_DIR;
      let entries;
      try {
        entries = await fsp.readdir(projectsDir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return { hasCrash: false };
        throw e;
      }

      // Suche nach dem neuesten Projekt mit Checkpoint
      const projDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('proj_'))
        .sort((a, b) => b.name.localeCompare(a.name));

      for (const dir of projDirs) {
        const projPath = path.join(projectsDir, dir.name);
        const checkpointFile = path.join(projPath, 'state.checkpoint.1.json');

        try {
          const raw = await fsp.readFile(checkpointFile, 'utf-8');
          const checkpoint = JSON.parse(raw);

          // Prüfe ob das Projekt noch lief (phase === running/awaiting_approval)
          if (checkpoint.phase === 'running' || checkpoint.phase === 'awaiting_approval') {
            return {
              hasCrash: true,
              checkpoint,
              projectDir: projPath,
              projectId: dir.name,
              reason: checkpoint._checkpoint ? checkpoint._checkpoint.reason : 'unbekannt',
              createdAt: checkpoint._checkpoint ? checkpoint._checkpoint.createdAt : null,
              createdAtISO: checkpoint._checkpoint ? checkpoint._checkpoint.createdAtISO : null,
              phase: checkpoint.phase,
              projectTitle: checkpoint.projectTitle || '',
              agentCount: (checkpoint.agents || []).length,
              completedAgents: (checkpoint.agents || []).filter(a => a.status === 'done').length,
            };
          }
        } catch (e) {
          continue;
        }
      }

      return { hasCrash: false };
    } catch (e) {
      logger.error('Crash-Recovery Erkennung fehlgeschlagen', { error: e.message });
      return { hasCrash: false, error: e.message };
    }
  }

  // ── Checkpoint verwerfen ──────────────────────────────────
  static async _discardCheckpoints(projectDir) {
    if (!projectDir) return;
    for (let i = 1; i <= MAX_CHECKPOINTS; i++) {
      try {
        await fsp.unlink(path.join(projectDir, `state.checkpoint.${i}.json`));
      } catch (e) {
        if (e.code !== 'ENOENT') logger.warn('Checkpoint-Loeschung fehlgeschlagen', { i, error: e.message });
      }
    }
    try {
      await fsp.unlink(path.join(projectDir, 'state.checkpoint.tmp'));
    } catch (e) {
      if (e.code !== 'ENOENT') { /* ignorieren */ }
    }
    logger.info('Checkpoints verworfen', { projectDir });
  }

  // ── State aus Checkpoint wiederherstellen ─────────────────
  async restoreFromCheckpoint(checkpointData, projectDir) {
    this.reset();

    this.projectId = checkpointData.projectId;
    this.projectDir = projectDir;
    this.projectDesc = checkpointData.projectDesc || (checkpointData._checkpoint ? checkpointData._checkpoint.projectDesc : '') || '';
    this.projectTitle = checkpointData.projectTitle || '';
    this.projectSummary = checkpointData.projectSummary || '';
    this.tags = checkpointData.tags || [];
    this.tasks = checkpointData.tasks || [];
    this.startedAt = checkpointData.startedAt || Date.now();
    this.phase = 'running';

    // Agents wiederherstellen
    this.agents = (checkpointData.agents || []).map(function(a) {
      return {
        ...a,
        status: (a.status === 'done' || a.status === 'error' || a.status === 'skipped') ? a.status : 'waiting',
        conversation: a.conversation || [],
      };
    });

    // Coordinator-State wiederherstellen
    if (checkpointData.coordinator) {
      this.coordLog = checkpointData.coordinator.log || [];
      this.coordStatus = 'ready';
      this.coordInterimReports = checkpointData.coordinator.interimReports || [];
      this.coordFinalReport = checkpointData.coordinator.finalReport || null;
      this.coordAdaptations = checkpointData.coordinator.adaptations || [];
      if (checkpointData.coordinator.tokenUsage) {
        this.coordinatorTokenUsage = checkpointData.coordinator.tokenUsage;
      }
    }

    // Checkpoints fuer dieses Projekt verwerfen
    await Orchestrator._discardCheckpoints(projectDir);

    logger.info('State aus Checkpoint wiederhergestellt', { projectId: this.projectId, agents: this.agents.length });
    this.emit('phase', { phase: 'running', startedAt: this.startedAt, restored: true });
    this.emit('coordinator', this._coordState());
    for (let i = 0; i < this.agents.length; i++) {
      this.emit('agent', { index: i, agent: this.agents[i] });
    }
    await this._saveStateImmediate();

    // Nicht-fertige Agenten fortsetzen
    await this._resumeAgents();
  }

  // ── Prüfe ob abgebrochen ────────────────────────────────────
  _checkAborted() {
    if (this._abortController.signal.aborted) {
      throw new Error('Abgebrochen');
    }
  }

  // ── Plan genehmigen ──────────────────────────────────────
  approvePlan() {
    if (this.phase !== 'awaiting_approval' || !this._approvalResolver) {
      throw new Error('Kein Plan wartet auf Genehmigung');
    }
    this._approvalResolver();
    this._approvalResolver = null;
  }

  // ── Plan modifizieren und genehmigen ────────────────────
  modifyPlan(tasks, _skipHistory) {
    if (this.phase !== 'awaiting_approval' || !this._approvalResolver) {
      throw new Error('Kein Plan wartet auf Genehmigung');
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Tasks müssen ein nicht-leeres Array sein');
    }
    // Validierung der modifizierten Tasks
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t.title || !t.task || !t.deliverable) {
        throw new Error(`Task ${i + 1} fehlt title, task oder deliverable`);
      }
    }
    // Vorherigen Plan für Undo speichern
    if (!_skipHistory) {
      const planSnapshot = {
        tasks: JSON.parse(JSON.stringify(this.tasks)),
        agents: JSON.parse(JSON.stringify(this.agents)),
      };
      this._planUndoStack.push(planSnapshot);
      if (this._planUndoStack.length > MAX_PLAN_HISTORY) {
        this._planUndoStack.shift();
      }
      this._planRedoStack = [];
    }
    // Tasks aktualisieren
    this.tasks = tasks;
    // Agents-Array anpassen
    this.agents = tasks.map((task, i) => ({
      id: i, title: task.title, task: task.task, deliverable: task.deliverable,
      role: task.role || '', depends_on: task.depends_on || [],
      status: 'waiting', progress: 0, conversation: [], rounds: 0,
      questions: 0, startTime: null, endTime: null, duration: null,
      workDir: path.join(this.projectDir, `agent-${i + 1}`)
    }));
    this.emit('agents_updated', { agents: this.agents });
    this._approvalResolver();
    this._approvalResolver = null;
  }

  // ── Start project ─────────────────────────────────────────
  async start(desc, agentCount, requireApproval, options = {}) {
    this.reset();

    // CLI-Check bevor wir starten (Verfügbarkeit + Versions-Kompatibilität)
    const cliCheck = checkClaudeCli();
    if (!cliCheck.ok) {
      this.phase = 'error';
      const errorMsg = cliCheck.error || t('error.cli_not_found', CONFIG.language);
      logger.error('Claude CLI Check fehlgeschlagen', { error: errorMsg });
      this.emit('phase', { phase: 'error', error: errorMsg });
      this.emit('error', { message: errorMsg, type: 'cli_not_found' });
      return;
    }

    // Tags uebernehmen (optional, Array von Strings, max 10, je max 30 Zeichen)
    if (Array.isArray(options.tags)) {
      this.tags = options.tags
        .filter(t => typeof t === 'string' && t.trim())
        .map(t => t.trim().toLowerCase().slice(0, 30))
        .slice(0, 10);
    }

    // Input sanitieren
    this.projectDesc = sanitizeInput(desc);
    if (!this.projectDesc) {
      this.phase = 'error';
      this.emit('phase', { phase: 'error', error: t('error.empty_description', CONFIG.language) });
      this.emit('error', { message: t('error.empty_description', CONFIG.language) });
      return;
    }

    // Agent-Anzahl begrenzen
    const clampedCount = Math.min(Math.max(1, parseInt(agentCount) || 1), CONFIG.maxAgents);

    this.projectId = `proj_${Date.now()}`;
    this.projectDir = path.join(PROJECTS_DIR, this.projectId);

    // Pfad validieren
    validateWorkDir(this.projectDir);

    try {
      await fsp.mkdir(this.projectDir, { recursive: true });
      // Shared-Verzeichnis fuer Agent-zu-Agent Dateiaustausch erstellen
      await fsp.mkdir(path.join(this.projectDir, 'shared'), { recursive: true });
    } catch (e) {
      if (e.code === 'ENOSPC') {
        this.phase = 'error';
        this.emit('phase', { phase: 'error', error: sanitizeError(t('error.no_disk_space', CONFIG.language)) });
        this.emit('error', { message: sanitizeError(t('error.no_disk_space', CONFIG.language)) });
        return;
      }
      throw e;
    }

    logger.info('Projekt gestartet', { projectId: this.projectId, agents: clampedCount });

    this.phase = 'running';
    this.coordStatus = 'planning';
    this.startedAt = Date.now();
    this.completedAt = null;
    this.totalDuration = null;
    this.agents = Array.from({ length: clampedCount }, (_, i) => ({
      id: i, title: t('agent.status.planning', CONFIG.language), task: '', deliverable: '', role: '',
      status: 'waiting', progress: 0, conversation: [], rounds: 0, questions: 0,
      startTime: null, endTime: null, duration: null,
      workDir: path.join(this.projectDir, `agent-${i + 1}`)
    }));
    this.emit('phase', { phase: 'running', startedAt: this.startedAt });
    this.emit('coordinator', this._coordState());
    await this._saveState();

    // Schritt 1: Koordinator plant
    try {
      this._checkAborted();
      await this._runHook('beforePlan', { description: this.projectDesc, agentCount: clampedCount });
      await this._coordinatorPlan(clampedCount);
      await this._runHook('afterPlan', { tasks: this.tasks, projectTitle: this.projectTitle });
      await this._sendWebhook('project_started', { title: this.projectTitle, agentCount: this.tasks.length });
      this._logActivity('project_started', { title: this.projectTitle, agentCount: this.tasks.length });
      // Auto-Snapshot nach erfolgreicher Planung
      this._autoSnapshot('phase_change').catch(() => {});
    } catch (e) {
      if (this._abortController.signal.aborted) return;
      this.coordStatus = 'error';
      this.emit('coordinator', { ...this._coordState(), error: sanitizeError(e.message) });
      this.phase = 'error';
      this.emit('phase', { phase: 'error' });
      await this._runHook('onError', { phase: 'planning', error: e });
      await this._saveState();
      return;
    }

    // Schritt 1.5: Optional auf Genehmigung warten
    if (requireApproval) {
      this.phase = 'awaiting_approval';
      this.emit('phase', { phase: 'awaiting_approval' });
      await this._saveState();
      await new Promise(resolve => { this._approvalResolver = resolve; });
      // Nach Genehmigung: Agent-Verzeichnisse und task.md ggf. neu erstellen (bei modifiziertem Plan)
      for (let i = 0; i < this.tasks.length; i++) {
        const task = this.tasks[i];
        const agentDir = path.join(this.projectDir, `agent-${i + 1}`);
        validateWorkDir(agentDir);
        try {
          await fsp.mkdir(agentDir, { recursive: true });
          await fsp.writeFile(path.join(agentDir, 'task.md'),
            `# Agent ${i + 1}: ${task.title}\n\n## Aufgabe\n${task.task}\n\n## Lieferergebnis\n${task.deliverable}\n`);
        } catch (e) {
          if (e.code === 'ENOSPC') throw new Error(t('error.no_disk_space', CONFIG.language));
          throw e;
        }
        this._patchAgent(i, { title: task.title, task: task.task, deliverable: task.deliverable, role: task.role || '', depends_on: task.depends_on || [], workDir: agentDir });
      }
      this.phase = 'running';
      this.emit('phase', { phase: 'running', startedAt: this.startedAt });
      await this._saveState();
    }

    // Schritt 2: Agenten mit Abhaengigkeiten und Semaphore ausfuehren
    this._checkAborted();
    const semaphore = new Semaphore(CONFIG.maxParallelAgents);
    logger.info('Parallele Ausfuehrung gestartet', { maxParallelAgents: CONFIG.maxParallelAgents, agentCount: this.tasks.length });
    this.emit('parallel_start', { maxParallelAgents: CONFIG.maxParallelAgents, agentCount: this.tasks.length });
    const taskCount = this.tasks.length;
    const agentCompletions = new Array(taskCount);

    for (let i = 0; i < taskCount; i++) {
      agentCompletions[i] = (async () => {
        // Auf Abhaengigkeiten warten
        const deps = this.tasks[i].depends_on || [];
        if (deps.length > 0) {
          const validDeps = deps.filter(d => d >= 0 && d < taskCount && d !== i);
          if (validDeps.length > 0) {
            const depsLabel = validDeps.map(d => `Agent ${d + 1}`).join(', ');
            this._patchAgent(i, { status: 'waiting_deps', waitingFor: depsLabel });
            // Warte auf alle Abhaengigkeiten (auch fehlgeschlagene)
            const results = await Promise.allSettled(validDeps.map(d => agentCompletions[d]));
            // Warnung wenn eine Abhaengigkeit fehlgeschlagen ist
            for (let r = 0; r < results.length; r++) {
              if (results[r].status === 'rejected' || (this.agents[validDeps[r]] && this.agents[validDeps[r]].status === 'error')) {
                logger.warn('Abhaengigkeit fehlgeschlagen, Agent startet trotzdem', {
                  agent: i + 1, failedDep: validDeps[r] + 1
                });
                this._addAgentMsg(i, { from: 'system', text: 'Warnung: Abhängigkeit Agent ' + (validDeps[r] + 1) + ' ist fehlgeschlagen. Agent startet trotzdem.', type: 'work' });
              }
            }
          }
        }
        // Dann Semaphore holen und ausfuehren
        await semaphore.acquire();
        try {
          this._checkAborted();
          await this._runHook('beforeAgent', { index: i, task: this.tasks[i], role: this.tasks[i].role || '' });
          await this._runAgent(i);
          let agentFiles = [];
          try { agentFiles = fs.readdirSync(this.agents[i].workDir).filter(f => f !== 'conversation.jsonl'); } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
          await this._runHook('afterAgent', { index: i, status: this.agents[i].status, duration: this.agents[i].duration, files: agentFiles });
        } catch (e) {
          if (!this._abortController.signal.aborted) {
            logger.error('Agent-Fehler', { agent: i + 1, error: e.message });
            this._logActivity('agent_error', { agentIndex: i, agentNum: i + 1, title: this.tasks[i]?.title || '', error: sanitizeError(e.message) });
            await this._sendWebhook('agent_error', { agentIndex: i, task: this.tasks[i]?.title || '', error: sanitizeError(e.message) });
            await this._runHook('onError', { phase: `agent-${i + 1}`, error: e });

            // Auto-Retry: einmal automatisch wiederholen
            if (CONFIG.autoRetry && !this._abortController.signal.aborted) {
              logger.info('Auto-Retry Agent', { agent: i + 1 });
              this._patchAgent(i, { status: 'retrying' });
              this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${sanitizeError(e.message)} — Automatischer Neuversuch in ${Math.round(AUTO_RETRY_DELAY / 1000)}s…`, type: 'work' });
              this.emit('auto_retry', { index: i, attempt: 2, reason: sanitizeError(e.message) });
              await new Promise(r => setTimeout(r, AUTO_RETRY_DELAY));
              try {
                // Agent-State zurücksetzen für den Retry
                this.agents[i].conversation = [];
                this.agents[i].rounds = 0;
                this.agents[i].questions = 0;
                this.agents[i].progress = 0;
                this.agents[i].startTime = null;
                this.agents[i].endTime = null;
                this.agents[i].duration = null;
                await this._runAgent(i);
              } catch (e2) {
                // Zweiter Fehlschlag — endgültig aufgeben
                logger.error('Auto-Retry fehlgeschlagen', { agent: i + 1, error: e2.message });
                this._logActivity('agent_error', { agentIndex: i, agentNum: i + 1, title: this.tasks[i]?.title || '', error: sanitizeError(e2.message) });
                this._patchAgent(i, { status: 'error' });
                this._addAgentMsg(i, { from: 'agent', text: `Endgültiger Fehler: ${sanitizeError(e2.message)}`, type: 'work' });
                // Plan-Anpassung durch Koordinator
                try { await this._coordinatorAdaptPlan(i, e2.message); } catch (adaptErr) { logger.warn('Plan-Anpassung Fehler', { error: adaptErr.message }); }
              }
            } else {
              this._patchAgent(i, { status: 'error' });
              this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${sanitizeError(e.message)}`, type: 'work' });
              // Plan-Anpassung durch Koordinator
              try { await this._coordinatorAdaptPlan(i, e.message); } catch (adaptErr) { logger.warn('Plan-Anpassung Fehler', { error: adaptErr.message }); }
            }
          }
        } finally {
          semaphore.release();
          // Zwischenbericht prüfen: nach jedem N-ten abgeschlossenen Agent
          if (!this._abortController.signal.aborted) {
            const completedIndices = this.agents.map((a, idx) => ({ a, idx }))
              .filter(({ a }) => a.status === 'done' || a.status === 'error' || a.status === 'skipped')
              .map(({ idx }) => idx);
            const completedCount = completedIndices.length;
            if (completedCount > 0 && completedCount < this.agents.length && completedCount % CONFIG.interimReportInterval === 0) {
              try { await this._coordinatorInterimReport(completedIndices); } catch (irErr) { logger.warn('Zwischenbericht Fehler', { error: irErr.message }); }
            }
          }
        }
      })();
    }

    await Promise.allSettled(agentCompletions);

    if (this._abortController.signal.aborted) return;

    // Ergebnis-Analyse: welche Agenten erfolgreich, welche fehlgeschlagen?
    const successAgents = this.agents.filter(a => a.status === 'done' || a.status === 'skipped');
    const failedAgents = this.agents.filter(a => a.status === 'error');
    const allFailed = failedAgents.length === this.agents.length;
    const someFailed = failedAgents.length > 0 && !allFailed;

    if (allFailed) {
      // Alle Agenten fehlgeschlagen → Error-Phase
      this.phase = 'error';
      this.completedAt = Date.now();
      this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);
      logger.error('Alle Agenten fehlgeschlagen', { projectId: this.projectId, totalDuration: this.totalDuration });
      this.emit('phase', { phase: 'error', totalDuration: this.totalDuration, failedAgents: failedAgents.map(a => a.id) });
      await this._sendWebhook('project_error', {
        title: this.projectTitle,
        totalDuration: this.totalDuration,
        agents: this.agents.map(a => ({ title: a.title, status: a.status })),
      });
      await this._runHook('onError', { phase: 'all_agents_failed', failedCount: failedAgents.length });
      this._autoSnapshot('error').catch(() => {});
      await this._saveState();
      return;
    }

    // Koordinator-Zusammenfassung erstellen (auch bei teilweisem Erfolg)
    await this._coordinatorSummary();

    // Agenten-Outputs zusammenführen (nur von erfolgreichen Agenten)
    await this._mergeOutputs(someFailed ? successAgents.map(a => a.id) : null);

    this.completedAt = Date.now();
    this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);

    // Durchschnittlichen Projekt-Score berechnen
    const projectScore = this._calculateProjectScore();
    this.projectScore = projectScore;
    logger.info('Projekt-Score berechnet', { projectId: this.projectId, projectScore });

    if (someFailed) {
      // Teilweiser Erfolg → Partial-Phase
      this.phase = 'partial';
      logger.warn('Projekt teilweise abgeschlossen', {
        projectId: this.projectId,
        success: successAgents.length,
        failed: failedAgents.length,
        totalDuration: this.totalDuration,
      });
      this.emit('phase', {
        phase: 'partial',
        totalDuration: this.totalDuration,
        successCount: successAgents.length,
        failedCount: failedAgents.length,
        failedAgents: failedAgents.map(a => a.id),
        projectScore,
      });
      await this._sendWebhook('project_partial', {
        title: this.projectTitle,
        totalDuration: this.totalDuration,
        agents: this.agents.map(a => ({ title: a.title, status: a.status })),
      });
    } else {
      // Alle erfolgreich → Complete-Phase
      this.phase = 'complete';
      logger.info('Projekt abgeschlossen', { projectId: this.projectId, agents: this.tasks.length, totalDuration: this.totalDuration });
      this.emit('phase', { phase: 'complete', totalDuration: this.totalDuration, projectScore });
      this._logActivity('project_complete', { title: this.projectTitle, totalDuration: this.totalDuration, agentCount: this.tasks.length });
      await this._sendWebhook('project_completed', {
        title: this.projectTitle,
        totalDuration: this.totalDuration,
        agents: this.agents.map(a => ({ title: a.title, status: a.status })),
      });
    }

    // Auto-Snapshot bei Projekt-Ende (Phase-Wechsel)
    this._autoSnapshot('phase_change').catch(() => {});

    await this._runHook('onComplete', { projectId: this.projectId, totalDuration: this.totalDuration, agents: this.agents });
    await this._saveStateImmediate();
  }

  // ── Koordinator: Aufgaben planen ────────────────────────────
  async _coordinatorPlan(agentCount) {
    const prompt = renderPrompt(this.prompts.coordinator_plan, {
      agentCount: agentCount,
      description: this.projectDesc,
    });

    const raw = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
    accumulateTokenUsage(this.coordinatorTokenUsage, prompt, raw);
    this._checkTokenBudget();

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
    } catch {
      // Versuche JSON aus Ausgabe zu extrahieren
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error(`Koordinator-Ausgabe kein JSON: ${raw.slice(0, 200)}`);
    }

    // JSON-Validierung
    validatePlan(parsed);

    this.projectTitle = parsed.project_title || t('project.default_title', CONFIG.language);
    this.projectSummary = parsed.summary || '';
    this.tasks = (parsed.tasks || []).slice(0, agentCount);
    this.coordStatus = 'ready';

    // Agent-Verzeichnisse erstellen und Task-Dateien speichern
    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i];
      const agentDir = path.join(this.projectDir, `agent-${i + 1}`);
      validateWorkDir(agentDir);
      try {
        await fsp.mkdir(agentDir, { recursive: true });
        await fsp.writeFile(path.join(agentDir, 'task.md'),
          `# Agent ${i + 1}: ${task.title}\n\n## Aufgabe\n${task.task}\n\n## Lieferergebnis\n${task.deliverable}\n`);
      } catch (e) {
        if (e.code === 'ENOSPC') throw new Error(t('error.no_disk_space', CONFIG.language));
        throw e;
      }
      this._patchAgent(i, { title: task.title, task: task.task, deliverable: task.deliverable, role: task.role || '', depends_on: task.depends_on || [], workDir: agentDir });
    }

    // Projekt-Uebersicht speichern
    try {
      await fsp.writeFile(path.join(this.projectDir, 'project.md'),
        `# ${this.projectTitle}\n\n${this.projectSummary}\n\n## Agenten\n${this.tasks.map((t, i) => `- Agent ${i + 1}: ${t.title}`).join('\n')}\n`);
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }

    this.emit('coordinator', this._coordState());
    this.emit('project_meta', { title: this.projectTitle, summary: this.projectSummary, dir: this.projectDir });
    await this._saveState();
    await this._createCheckpoint('plan_erstellt');
  }

  // ── Einen Agenten ausführen (mit Frage-Antwort-Schleife) ───
  async _runAgent(idx) {
    const task = this.tasks[idx];
    const agentDir = this.agents[idx].workDir;
    const agentNum = idx + 1;

    // Budget-Check: Stoppe neue Agenten wenn Budget überschritten
    if (this._isBudgetExceeded()) {
      logger.warn('Agent nicht gestartet: Token-Budget überschritten', { agent: agentNum });
      this._patchAgent(idx, { status: 'skipped', skipReason: t('agent.skipped_budget', CONFIG.language, { id: agentNum }) });
      this._addAgentMsg(idx, { from: 'system', text: t('agent.skipped_budget', CONFIG.language, { id: agentNum }), type: 'system' });
      this.emit('agent_skipped_budget', { index: idx, agentNum, reason: t('agent.skipped_budget', CONFIG.language, { id: agentNum }) });
      return;
    }

    validateWorkDir(agentDir);
    logger.info('Agent gestartet', { agent: agentNum, task: task.title });
    this._logActivity('agent_started', { agentIndex: idx, agentNum, title: task.title });
    this.emit('agent-start', { index: idx, agentNum, title: task.title, task: task.task });

    // Datei-Snapshot VOR Agent-Start erstellen
    const fileSnapshotBefore = this._snapshotDir(agentDir);

    // Token-Usage initialisieren falls nicht vorhanden
    if (!this.agents[idx].tokenUsage) {
      this.agents[idx].tokenUsage = createTokenUsage();
    }

    this.agents[idx].promptLog = [];
    // ETA-Tracking initialisieren
    this.agents[idx].roundDurations = [];
    this.agents[idx].estimatedTotalRounds = CONFIG.maxRounds;
    this.agents[idx].estimatedCompletion = null;
    this.agents[idx].etaSeconds = null;
    this._patchAgent(idx, { status: 'working', progress: 10, startTime: Date.now() });
    await this._saveState();

    // Pfad für Prompt-Log-Datei (JSONL)
    const promptsLogFile = path.join(agentDir, 'prompts.jsonl');

    // Kontext über andere Agenten (was sie tun, ohne Details)
    // Im strikten Modus kein Kontext über andere Agenten
    const isStrict = CONFIG.isolation === 'strict';
    const otherAgentsCtx = isStrict ? '' : this.tasks
      .map((t, i) => i !== idx ? `- Agent ${i + 1}: ${t.title}` : null)
      .filter(Boolean)
      .join('\n');

    // Shared Context von bereits fertigen Agenten lesen
    // Im strikten Modus kein gemeinsamer Kontext
    const sharedCtx = isStrict ? '' : await this._readSharedContext();

    // Shared Context Board laden (fuer erweiterte Agent-Kommunikation)
    if (!isStrict) {
      await this._loadSharedContextBoard();
    }

    // Lokaler Fragen-Zähler
    let questionsUsed = 0;

    // Verlauf für Multi-Turn (wird in den Prompt injiziert)
    let historyText = '';

    // Rollen-Prefix: Zuerst Rolle aus Rollen-System laden, Fallback auf einfachen Text
    const roleObj = getRoleById(task.role);
    const rolePrefix = roleObj ? buildRolePrefix(task.role) : (task.role ? `Du bist ein erfahrener ${task.role}.\n` : '');

    const isolationHint = isStrict
      ? '\nDu arbeitest in einer isolierten Umgebung. Du kannst NUR Dateien in deinem eigenen Verzeichnis erstellen und lesen. Greife NICHT auf Dateien anderer Agenten zu.\n'
      : '';

    // Erweiterten Shared Context aufbauen (Board + Messages + Shared Files)
    const enhancedSharedCtx = isStrict ? '' : await this._buildAgentSharedContext(idx);
    const sharedCtxBlock = (sharedCtx || enhancedSharedCtx) ?
      `\nBisheriger Kontext anderer Agenten:\n${sharedCtx}\n${enhancedSharedCtx ? '\n' + enhancedSharedCtx + '\n' : ''}` : '';

    const agentSystemPrompt = renderPrompt(this.prompts.agent_system, {
      rolePrefix: rolePrefix,
      agentNum: agentNum,
      projectTitle: this.projectTitle,
      agentDir: agentDir,
      task: task.task,
      deliverable: task.deliverable,
      otherAgentsCtx: otherAgentsCtx || 'Keine',
      sharedCtx: sharedCtxBlock,
    }) + isolationHint;

    for (let round = 0; round < CONFIG.maxRounds; round++) {
      this._checkAborted();
      const roundStartTime = Date.now();

      // ETA-basierter Fortschritt: nutze geschaetzte Gesamtrunden statt CONFIG.maxRounds
      const estTotalRounds = this.agents[idx].estimatedTotalRounds || CONFIG.maxRounds;
      const roundProgress = Math.min(90, Math.round(((round + 1) / estTotalRounds) * 80 + 10));
      // Fortschritt darf nie rueckwaerts gehen
      const prevProgress = this.agents[idx].progress || 0;
      const safeProgress = Math.max(prevProgress, roundProgress);
      this._patchAgent(idx, { rounds: round + 1, progress: safeProgress });

      // Benutzer-Intervention prüfen und anwenden
      if (this.agents[idx].pendingIntervention) {
        const interventionText = this.agents[idx].pendingIntervention;
        const interventionType = this.agents[idx].pendingInterventionType || 'redirect';

        // Typ-spezifische Behandlung
        if (interventionType === 'restart') {
          // Agent komplett neu starten: History zurücksetzen, Runde auf 0
          historyText = '';
          this.agents[idx].rounds = 0;
          this.agents[idx].questions = 0;
          questionsUsed = 0;
          this.agents[idx].pendingIntervention = null;
          this.agents[idx].pendingInterventionType = null;
          this._addAgentMsg(idx, { from: 'system', text: '[Neustart] ' + (interventionText || 'Agent wird neu gestartet'), type: 'intervention' });
          this.emit('agent_intervention_applied', { agentIndex: idx, agentNum, type: 'restart', message: interventionText });
          this._logActivity('agent_intervention_applied', { agentIndex: idx, agentNum, type: 'restart', message: interventionText });
          logger.info('Agent-Neustart durch Intervention', { agent: agentNum });
          // Loop von vorne starten (round wird bei continue inkrementiert, daher round auf -1 setzen geht nicht direkt - wir nutzen den normalen Ablauf)
          continue;
        }

        if (interventionType === 'inject') {
          // Zusätzlicher Kontext wird injiziert, ohne bestehende Anweisungen zu ersetzen
          historyText += `\n[Zusätzlicher Kontext vom Benutzer]: ${interventionText}\n`;
        } else {
          // redirect (Standard): Neue Anweisung für nächste Runde
          historyText += `\n[Benutzer-Intervention – neue Anweisung]: ${interventionText}\n`;
        }

        this.emit('agent_intervention_applied', { agentIndex: idx, agentNum, type: interventionType, message: interventionText });
        this.agents[idx].pendingIntervention = null;
        this.agents[idx].pendingInterventionType = null;
        this._logActivity('agent_intervention_applied', { agentIndex: idx, agentNum, type: interventionType, message: interventionText });
        logger.info('Intervention angewendet', { agent: agentNum, type: interventionType, message: interventionText.slice(0, 100) });
      }

      // Auto-Intervention: Warnung nach N Runden ohne FERTIG
      if (CONFIG.autoInterventionEnabled && round + 1 >= CONFIG.autoInterventionRounds) {
        if (round + 1 === CONFIG.autoInterventionRounds) {
          this._addAgentMsg(idx, { from: 'system', text: '[Auto-Warnung] Agent hat ' + (round + 1) + ' Runden ohne FERTIG erreicht. Bitte prüfen und ggf. eingreifen.', type: 'intervention' });
          this.emit('auto_intervention_warning', { agentIndex: idx, agentNum, round: round + 1, reason: 'max_rounds_warning' });
          this._logActivity('auto_intervention_warning', { agentIndex: idx, agentNum, round: round + 1 });
          logger.warn('Auto-Intervention Warnung: Agent ohne FERTIG', { agent: agentNum, round: round + 1 });
        }
      }

      // Auto-Intervention: Wiederholungs-Erkennung (gleicher Output 2x)
      if (CONFIG.autoInterventionEnabled && round > 0) {
        const prevMsgs = this.agents[idx].conversation.filter(m => m.from === 'agent' && m.type === 'work');
        if (prevMsgs.length >= 2) {
          const last = prevMsgs[prevMsgs.length - 1];
          const secondLast = prevMsgs[prevMsgs.length - 2];
          if (last && secondLast && last.text && secondLast.text && last.text === secondLast.text) {
            this._addAgentMsg(idx, { from: 'system', text: '[Auto-Warnung] Agent wiederholt sich (gleicher Output in 2 aufeinanderfolgenden Runden). Intervention empfohlen.', type: 'intervention' });
            this.emit('auto_intervention_warning', { agentIndex: idx, agentNum, round: round + 1, reason: 'repeated_output' });
            this._logActivity('auto_intervention_warning', { agentIndex: idx, agentNum, round: round + 1, reason: 'repeated_output' });
            logger.warn('Auto-Intervention Warnung: Agent wiederholt sich', { agent: agentNum, round: round + 1 });
          }
        }
      }

      // Budget-Check innerhalb des Runden-Loops
      if (this._isBudgetExceeded()) {
        logger.warn('Agent gestoppt (Runde): Token-Budget überschritten', { agent: agentNum, round: round + 1 });
        this._patchAgent(idx, { status: 'skipped', skipReason: t('agent.stopped_budget', CONFIG.language, { id: agentNum, round: round + 1 }) });
        this._addAgentMsg(idx, { from: 'system', text: t('agent.stopped_budget', CONFIG.language, { id: agentNum, round: round + 1 }), type: 'system' });
        return;
      }

      // Inter-Agent Nachrichten injizieren
      let messageBoardText = '';
      const pendingMessages = this._messageBoard.get(idx);
      if (pendingMessages && pendingMessages.length > 0) {
        messageBoardText = '\n\nNachrichten von anderen Agenten:\n' +
          pendingMessages.map(m => `- Agent ${m.from + 1}: "${m.text}"`).join('\n') + '\n';
        this._messageBoard.delete(idx);
      }

      const trimmedHistory = trimHistory(historyText);
      const fullPrompt = trimmedHistory
        ? `${agentSystemPrompt}${messageBoardText}\n\n## Bisheriger Verlauf:\n${trimmedHistory}\n\n## Nächster Schritt:\nFahre fort.`
        : `${agentSystemPrompt}${messageBoardText}\n\nStarte jetzt deine Aufgabe.`;

      // liveOutput zurücksetzen und Typing-Indikator starten
      if (this.agents[idx]) this.agents[idx].liveOutput = '';
      this.emit('agent_typing', { agentIndex: idx, isTyping: true });
      this._streamingAgentIdx = idx;
      const response = await runClaude(fullPrompt, agentDir, this, this._activeProcesses, this._abortController.signal);
      this._streamingAgentIdx = undefined;
      // Typing-Indikator stoppen und letzten Stream-Timer aufräumen
      if (this._streamThrottleTimer) {
        clearTimeout(this._streamThrottleTimer);
        this._streamThrottleTimer = null;
      }
      if (this.agents[idx]) this.agents[idx].liveOutput = '';
      this.emit('agent_typing', { agentIndex: idx, isTyping: false });

      // Token-Usage tracken
      accumulateTokenUsage(this.agents[idx].tokenUsage, fullPrompt, response);
      this._patchAgent(idx, { tokenUsage: this.agents[idx].tokenUsage });
      this._checkTokenBudget();

      // ── ETA-Berechnung nach Runde ─────────────────────────
      {
        const roundDurationMs = Date.now() - roundStartTime;
        this.agents[idx].roundDurations.push(roundDurationMs);
        const durations = this.agents[idx].roundDurations;
        const avgRoundMs = durations.reduce((s, d) => s + d, 0) / durations.length;
        const completedRounds = round + 1;
        let estTotalRounds = CONFIG.maxRounds;
        // Nutze Durchschnitt abgeschlossener Agenten als Heuristik
        const doneAgents = this.agents.filter(a => a.status === 'done' && a.rounds > 0);
        if (doneAgents.length > 0) {
          const avgDoneRounds = Math.ceil(doneAgents.reduce((s, a) => s + a.rounds, 0) / doneAgents.length);
          estTotalRounds = Math.max(completedRounds, Math.min(CONFIG.maxRounds, avgDoneRounds));
        } else if (completedRounds >= 2) {
          estTotalRounds = Math.max(completedRounds, Math.min(CONFIG.maxRounds, completedRounds + 2));
        }
        this.agents[idx].estimatedTotalRounds = estTotalRounds;
        const roundsLeft = Math.max(0, estTotalRounds - completedRounds);
        const etaMs = Math.round(roundsLeft * avgRoundMs);
        const etaSeconds = Math.round(etaMs / 1000);
        const estimatedCompletion = Date.now() + etaMs;
        // ETA darf nicht rueckwaerts gehen
        const prevEta = this.agents[idx].estimatedCompletion;
        if (!prevEta || estimatedCompletion >= prevEta || roundsLeft === 0) {
          this.agents[idx].estimatedCompletion = estimatedCompletion;
          this.agents[idx].etaSeconds = etaSeconds;
        }
        // Fortschritt auf Basis geschaetzter Gesamtrunden (nie rueckwaerts)
        const etaProgress = Math.min(90, Math.round((completedRounds / estTotalRounds) * 80 + 10));
        const currentProgress = this.agents[idx].progress || 0;
        if (etaProgress > currentProgress) {
          this._patchAgent(idx, { progress: etaProgress });
        }
        this._patchAgent(idx, {
          roundDurations: durations,
          estimatedTotalRounds: estTotalRounds,
          estimatedCompletion: this.agents[idx].estimatedCompletion,
          etaSeconds: this.agents[idx].etaSeconds,
        });
        // SSE-Event: progress-update
        this.emit('progress-update', {
          agentIndex: idx,
          percent: this.agents[idx].progress,
          eta: this.agents[idx].etaSeconds,
          roundsLeft,
          roundDurationMs: Math.round(avgRoundMs),
        });
        // Projekt-ETA berechnen und senden
        this._emitProjectEta();
      }

      // Prompt/Response für Debugging aufzeichnen
      this.agents[idx].promptLog.push({
        round: round + 1,
        promptTokens: estimateTokens(fullPrompt),
        responseTokens: estimateTokens(response),
        promptLength: fullPrompt.length,
        responseLength: response.length,
      });
      // JSONL-Datei schreiben (eine Zeile pro Runde)
      try {
        const logEntry = JSON.stringify({
          round: round + 1,
          prompt: fullPrompt,
          response,
          ts: new Date().toISOString(),
        });
        await fsp.appendFile(promptsLogFile, logEntry + '\n');
      } catch (e) {
        logger.warn('Prompt-Log schreiben fehlgeschlagen', { agent: agentNum, round: round + 1, error: e.message });
      }

      this._checkAborted();

      // Inter-Agent Nachrichten erkennen
      const msgRegex = /NACHRICHT AN Agent (\d+):\s*(.+?)(?:\n|$)/gi;
      let msgMatch;
      while ((msgMatch = msgRegex.exec(response)) !== null) {
        const targetIdx = parseInt(msgMatch[1]) - 1; // 1-basiert → 0-basiert
        const msgText = msgMatch[2].trim();
        if (targetIdx >= 0 && targetIdx < this.tasks.length && targetIdx !== idx && msgText) {
          // Max 3 Nachrichten pro Ziel-Agent
          if (!this._messageBoard.has(targetIdx)) {
            this._messageBoard.set(targetIdx, []);
          }
          const inbox = this._messageBoard.get(targetIdx);
          if (inbox.length < MAX_MESSAGES_PER_AGENT) {
            inbox.push({ from: idx, text: msgText });
            logger.info('Inter-Agent Nachricht', { from: idx + 1, to: targetIdx + 1, text: msgText.slice(0, 100) });
            this._logActivity('agent_message', { fromAgent: idx, toAgent: targetIdx, fromNum: idx + 1, toNum: targetIdx + 1, text: msgText.slice(0, 100) });
            this.emit('agent_message', { from: idx, to: targetIdx, text: msgText });
            this._addAgentMsg(idx, { from: 'message', text: `→ Agent ${targetIdx + 1}: ${msgText}`, type: 'message', targetAgent: targetIdx });
          } else {
            logger.warn('Inter-Agent Nachricht abgelehnt (Limit)', { from: idx + 1, to: targetIdx + 1 });
          }
        }
      }

      // Shared Context Eintraege aus Agent-Output extrahieren (KONTEXT: key = value)
      const ctxEntries = this._parseSharedContextFromOutput(response, idx);
      for (const ce of ctxEntries) {
        await this._addToSharedContextBoard(idx, ce.key, ce.value);
        this._addAgentMsg(idx, { from: 'context', text: `[Kontext] ${ce.key} = ${ce.value}`, type: 'context' });
      }

      // Shared Files erkennen und kopieren (SHARED FILE: dateiname)
      await this._detectAndCopySharedFiles(response, idx);

      const qMatch = response.match(/FRAGE:\s*(.+?)(?:\n|$)/i);
      const isDone = /FERTIG/i.test(response);

      // Bei FRAGE + FERTIG in gleicher Antwort: FRAGE hat Vorrang
      if (qMatch && questionsUsed < MAX_QUESTIONS_PER_AGENT) {
        const question = qMatch[1].trim();
        const beforeQ = response.split(/FRAGE:/i)[0].trim();

        if (beforeQ) {
          await this._addAgentMsg(idx, { from: 'agent', text: beforeQ, type: 'work' });
          historyText += `\nAgent (Runde ${round + 1}):\n${beforeQ}\n`;
        }
        await this._addAgentMsg(idx, { from: 'agent', text: question, type: 'question' });
        questionsUsed++;
        this._patchAgent(idx, { status: 'asking', questions: questionsUsed });
        await this._saveState();

        // Koordinator antwortet
        logger.info('Agent fragt Koordinator', { agent: idx + 1, question });
        this._logActivity('agent_question', { agentIndex: idx, agentNum: idx + 1, question });
        this._checkAborted();
        const answer = await this._coordinatorAnswer(question, idx);
        await this._addAgentMsg(idx, { from: 'coordinator', text: answer, type: 'answer' });
        this._patchAgent(idx, { status: 'working' });

        historyText += `\nAgent fragt: ${question}\nKoordinator antwortet: ${answer}\n`;

      } else {
        await this._addAgentMsg(idx, { from: 'agent', text: response, type: isDone ? 'final' : 'work' });
        historyText += `\nAgent (Runde ${round + 1}):\n${response}\n`;

        if (isDone || round >= CONFIG.maxRounds - 1) {
          logger.info('Agent fertig', { agent: idx + 1, rounds: this.agents[idx].rounds });
          this._logActivity('agent_done', { agentIndex: idx, agentNum: idx + 1, title: task.title, rounds: this.agents[idx].rounds });
          if (isDone) this._patchAgent(idx, { progress: 95 });
          const agentEndTime = Date.now();
          const agentDuration = Math.round((agentEndTime - (this.agents[idx].startTime || agentEndTime)) / 1000);
          // Datei-Diff nach Agent-Abschluss
          const fileSnapshotAfter = this._snapshotDir(agentDir);
          const fileChanges = this._diffSnapshot(fileSnapshotBefore, fileSnapshotAfter);
          this._patchAgent(idx, { status: 'done', progress: 100, endTime: agentEndTime, duration: agentDuration, fileChanges, etaSeconds: 0, estimatedCompletion: null });
          // ETA-Events bei Fertigstellung
          this.emit('progress-update', { agentIndex: idx, percent: 100, eta: 0, roundsLeft: 0, roundDurationMs: 0 });
          this._emitProjectEta();
          // Statistiken berechnen
          try {
            const stats = await this._calculateAgentStats(agentDir);
            this._patchAgent(idx, { stats });
          } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
          // Transcript speichern
          try {
            await fsp.writeFile(path.join(agentDir, 'transcript.md'),
              `# Agent ${agentNum} Verlauf\n\n${historyText}`);
          } catch (e) {
            if (e.code === 'ENOSPC') {
              this._addAgentMsg(idx, { from: 'agent', text: t('misc.transcript_no_space', CONFIG.language), type: 'work' });
            }
          }
          // Deliverable-Verifikation (immer, unabhaengig von CONFIG.verifyAgents)
          const deliverableCheck = this._verifyAgentDeliverables(idx);
          this._patchAgent(idx, { deliverableCheck });
          if (!deliverableCheck.passed) {
            for (const warn of deliverableCheck.warnings) {
              this._addAgentMsg(idx, { from: 'system', text: `Verifikation: ${warn}`, type: 'work' });
            }
          }
          // Qualitaets-Score berechnen
          this._scoreAgent(idx);
          // Agent-Verifizierung (optional)
          if (CONFIG.verifyAgents) {
            const verifyResult = await this._verifyAgent(idx);
            // Bei 'fail' und verbleibenden Runden: Vorschläge injizieren und weitermachen
            if (verifyResult.verdict === 'fail' && round < CONFIG.maxRounds - 1) {
              historyText += `\nVerifizierung fehlgeschlagen: ${verifyResult.findings}\nVorschläge: ${verifyResult.suggestions}\n`;
              this._patchAgent(idx, { status: 'working', progress: roundProgress });
              this._scoreAgent(idx);
              continue;
            }
            // Score nach Verifizierung neu berechnen
            this._patchAgent(idx, { status: 'done', progress: 100 });
            this._scoreAgent(idx);
          }
          // Shared Context aktualisieren für nachfolgende Agenten
          await this._writeSharedContext(idx);
          await this._saveState();
          await this._createCheckpoint('agent_fertig_' + (idx + 1));
          return;
        }
      }
    }
    this._logActivity('agent_done', { agentIndex: idx, agentNum: idx + 1, title: task.title, rounds: this.agents[idx].rounds });
    const agentEndTime2 = Date.now();
    const agentDuration2 = Math.round((agentEndTime2 - (this.agents[idx].startTime || agentEndTime2)) / 1000);
    // Datei-Diff nach Agent-Abschluss (Fallback-Ende)
    const fileSnapshotAfter2 = this._snapshotDir(agentDir);
    const fileChanges2 = this._diffSnapshot(fileSnapshotBefore, fileSnapshotAfter2);
    this._patchAgent(idx, { status: 'done', progress: 100, endTime: agentEndTime2, duration: agentDuration2, fileChanges: fileChanges2, etaSeconds: 0, estimatedCompletion: null });
    // ETA-Events bei Fertigstellung (Fallback-Ende)
    this.emit('progress-update', { agentIndex: idx, percent: 100, eta: 0, roundsLeft: 0, roundDurationMs: 0 });
    this._emitProjectEta();
    // Statistiken berechnen
    try {
      const stats = await this._calculateAgentStats(agentDir);
      this._patchAgent(idx, { stats });
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
    // Deliverable-Verifikation (Fallback-Ende)
    const deliverableCheck2 = this._verifyAgentDeliverables(idx);
    this._patchAgent(idx, { deliverableCheck: deliverableCheck2 });
    if (!deliverableCheck2.passed) {
      for (const warn of deliverableCheck2.warnings) {
        this._addAgentMsg(idx, { from: 'system', text: `Verifikation: ${warn}`, type: 'work' });
      }
    }
    // Qualitaets-Score berechnen
    this._scoreAgent(idx);
    // Agent-Verifizierung (optional) - Fallback-Ende
    if (CONFIG.verifyAgents) {
      await this._verifyAgent(idx);
      // Status zurücksetzen und Score nach Verifizierung neu berechnen
      this._patchAgent(idx, { status: 'done', progress: 100 });
      this._scoreAgent(idx);
    }
    await this._writeSharedContext(idx);
    await this._saveState();
    await this._createCheckpoint('agent_fertig_' + (idx + 1));
  }

  // ── Koordinator beantwortet Agenten-Frage ───────────────────
  async _coordinatorAnswer(question, agentIdx) {
    this.coordStatus = 'thinking';
    this.coordActiveQ = { agentIndex: agentIdx, question };
    this.emit('coordinator', this._coordState());
    await this._saveState();

    const taskSummary = this.tasks.map((t, i) => `Agent ${i + 1}: ${t.title} – ${t.task}`).join('\n');

    // Bisherige Fragen dieses Agents als Kontext
    const previousQuestions = this.coordLog
      .filter(entry => entry.agentIndex === agentIdx)
      .map((entry, i) => `Frage ${i + 1}: ${entry.question}\nAntwort: ${entry.answer}`)
      .join('\n');

    const agentTask = this.tasks[agentIdx];
    const prevQText = previousQuestions ? `Bisherige Fragen dieses Agents:\n${previousQuestions}\n` : '';
    const prompt = renderPrompt(this.prompts.coordinator_answer, {
      description: this.projectDesc,
      taskSummary: taskSummary,
      agentNum: agentIdx + 1,
      agentTitle: agentTask.title,
      agentTask: agentTask.task,
      previousQuestions: prevQText,
      question: question,
    });

    const answer = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
    accumulateTokenUsage(this.coordinatorTokenUsage, prompt, answer);
    this._checkTokenBudget();

    this.coordLog.push({ agentIndex: agentIdx, question, answer });
    this._logActivity('agent_answer', { agentIndex: agentIdx, agentNum: agentIdx + 1, question, answer: answer.slice(0, 200) });
    this.coordStatus = 'ready';
    this.coordActiveQ = null;
    this.emit('coordinator', this._coordState());
    await this._saveState();
    await this._createCheckpoint('frage_beantwortet_agent_' + (agentIdx + 1));
    return answer;
  }

  // ── Koordinator: Abschluss-Zusammenfassung (erweiterter Finalbericht) ──
  async _coordinatorSummary() {
    try {
      this.coordStatus = 'summarizing';
      this.emit('coordinator', this._coordState());

      const agentResults = this.agents.map((a, i) => {
        const task = this.tasks[i];
        const scoreInfo = a.score != null ? `, Score=${a.score}/100` : '';
        const fileInfo = a.stats ? `, Dateien=${a.stats.filesCreated || 0}, Zeilen=${a.stats.linesOfCode || 0}` : '';
        const durationInfo = a.duration ? `, Dauer=${a.duration}s` : '';
        return `- Agent ${i + 1} "${a.title}": Status=${a.status}${scoreInfo}${fileInfo}${durationInfo}, Lieferergebnis: ${task ? task.deliverable : 'n/a'}`;
      }).join('\n');

      const interimSummary = this.coordInterimReports.length > 0
        ? `\nBisherige Zwischenberichte: ${this.coordInterimReports.length}\nLetzter Zwischenbericht: ${this.coordInterimReports[this.coordInterimReports.length - 1].report.slice(0, 200)}`
        : '';

      const adaptationsSummary = this.coordAdaptations.length > 0
        ? `\nPlan-Anpassungen: ${this.coordAdaptations.map(a => `Agent ${a.failedAgentIndex + 1}: ${a.adaptation.action} (${a.adaptation.reason})`).join('; ')}`
        : '';

      const prompt = `Du bist Projekt-Koordinator. Alle Agenten sind fertig. Erstelle einen detaillierten Abschlussbericht auf Deutsch.

Projektbeschreibung: ${this.projectDesc}
Projekttitel: ${this.projectTitle}

Ergebnisse der Agenten:
${agentResults}
${interimSummary}
${adaptationsSummary}

Erstelle einen detaillierten Abschlussbericht mit folgender Struktur:
1. ZUSAMMENFASSUNG: Was wurde insgesamt erreicht? (2-3 Sätze)
2. ERFOLGE: Welche Agenten waren erfolgreich und was haben sie geliefert?
3. PROBLEME: Welche Agenten hatten Probleme oder sind fehlgeschlagen?
4. OFFENE PUNKTE: Was fehlt noch oder sollte verbessert werden?
5. NÄCHSTE SCHRITTE: Konkrete Empfehlungen für die Weiterarbeit (3-5 Punkte)
6. GESAMTBEWERTUNG: Eine Bewertung auf einer Skala von 1-10 mit Begründung

Antworte NUR mit validem JSON:
{"summary":"Zusammenfassung","achievements":["Erfolg 1","Erfolg 2"],"issues":["Problem 1"],"openItems":["Offener Punkt 1"],"nextSteps":["Schritt 1","Schritt 2"],"overallRating":7,"ratingReason":"Begründung"}`;

      const response = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
      accumulateTokenUsage(this.coordinatorTokenUsage, prompt, response);
      this._checkTokenBudget();

      // Versuche JSON zu parsen für strukturierten Bericht
      let finalReport = null;
      try {
        const jsonMatch = response.match(/\{[\s\S]*?"summary"[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          finalReport = {
            summary: parsed.summary || '',
            achievements: Array.isArray(parsed.achievements) ? parsed.achievements : [],
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            openItems: Array.isArray(parsed.openItems) ? parsed.openItems : [],
            nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
            overallRating: typeof parsed.overallRating === 'number' ? Math.max(1, Math.min(10, parsed.overallRating)) : null,
            ratingReason: parsed.ratingReason || '',
            timestamp: Date.now()
          };
        }
      } catch (parseErr) {
        logger.warn('Finalbericht JSON Parse-Fehler, verwende Freitext', { error: parseErr.message });
      }

      // Fallback: wenn kein JSON geparst werden konnte
      if (!finalReport) {
        finalReport = {
          summary: response.slice(0, 500),
          achievements: [],
          issues: [],
          openItems: [],
          nextSteps: [],
          overallRating: null,
          ratingReason: '',
          timestamp: Date.now()
        };
      }

      this.coordFinalReport = finalReport;
      this.projectSummary = finalReport.summary || response.slice(0, 300);
      this.coordStatus = 'done';
      this.emit('coordinator', this._coordState());
      this.emit('project_meta', { title: this.projectTitle, summary: this.projectSummary, dir: this.projectDir });
      await this._saveState();
    } catch (e) {
      // Nicht-kritisch: bei Fehler alte Zusammenfassung behalten
      logger.warn('Koordinator-Zusammenfassung fehlgeschlagen', { error: e.message });
      this.coordStatus = 'done';
      this.emit('coordinator', this._coordState());
    }
  }

  // ── Koordinator: Zwischenbericht erstellen ──────────────────
  async _coordinatorInterimReport(completedAgentIndices) {
    try {
      this.coordStatus = 'interim_report';
      this.emit('coordinator', this._coordState());

      const completedInfo = completedAgentIndices.map(i => {
        const a = this.agents[i];
        const t = this.tasks[i];
        return `- Agent ${i + 1} "${a.title}": Status=${a.status}, Score=${a.score || 'n/a'}, Dateien=${(a.stats && a.stats.filesCreated) || 0}`;
      }).join('\n');

      const pendingInfo = this.agents
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.status !== 'done' && a.status !== 'error' && a.status !== 'skipped')
        .map(({ a, i }) => `- Agent ${i + 1} "${a.title}": Status=${a.status}, Fortschritt=${a.progress || 0}%`)
        .join('\n');

      const prompt = `Du bist Projekt-Koordinator. Erstelle einen kurzen Zwischenbericht auf Deutsch.

Projektbeschreibung: ${this.projectDesc}
Projekttitel: ${this.projectTitle}

Abgeschlossene Agenten:
${completedInfo || 'Keine'}

Noch laufende/wartende Agenten:
${pendingInfo || 'Keine'}

Bisherige Fragen und Antworten: ${this.coordLog.length}

Erstelle einen kurzen Zwischenbericht (3-5 Sätze):
1. Was wurde bisher erreicht?
2. Wie ist der aktuelle Fortschritt?
3. Gibt es Auffälligkeiten oder Risiken?

Antworte direkt und konkret auf Deutsch.`;

      const report = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
      accumulateTokenUsage(this.coordinatorTokenUsage, prompt, report);
      this._checkTokenBudget();

      const interimEntry = {
        timestamp: Date.now(),
        completedAgents: completedAgentIndices.length,
        totalAgents: this.agents.length,
        report: report,
        agentStatuses: this.agents.map((a, i) => ({ index: i, title: a.title, status: a.status, score: a.score || null }))
      };

      this.coordInterimReports.push(interimEntry);
      this.coordStatus = 'ready';
      this.emit('coordinator-interim', interimEntry);
      this.emit('coordinator', this._coordState());
      this._logActivity('coordinator_interim_report', { completedAgents: completedAgentIndices.length, reportLength: report.length });
      logger.info('Koordinator-Zwischenbericht erstellt', { completedAgents: completedAgentIndices.length });
      await this._saveState();
    } catch (e) {
      logger.warn('Koordinator-Zwischenbericht fehlgeschlagen', { error: e.message });
      this.coordStatus = 'ready';
      this.emit('coordinator', this._coordState());
    }
  }

  // ── Koordinator: Plan anpassen nach Agent-Fehler ────────────
  async _coordinatorAdaptPlan(failedAgentIdx, error) {
    try {
      this.coordStatus = 'adapting';
      this.emit('coordinator', this._coordState());

      const failedTask = this.tasks[failedAgentIdx];
      const agentNum = failedAgentIdx + 1;

      const otherAgentsInfo = this.agents
        .map((a, i) => i !== failedAgentIdx ? `- Agent ${i + 1} "${a.title}": Status=${a.status}` : null)
        .filter(Boolean)
        .join('\n');

      const prompt = `Du bist Projekt-Koordinator. Agent ${agentNum} ("${failedTask.title}") ist fehlgeschlagen.

Projektbeschreibung: ${this.projectDesc}
Fehler: ${sanitizeError(error, 500)}

Fehlgeschlagene Aufgabe:
- Titel: ${failedTask.title}
- Aufgabe: ${failedTask.task}
- Lieferergebnis: ${failedTask.deliverable}

Andere Agenten:
${otherAgentsInfo}

Analysiere die Situation und entscheide:
1. Kann die Aufgabe auf bestehende Agenten umverteilt werden?
2. Ist die Aufgabe kritisch für das Gesamtprojekt?
3. Welche Empfehlung gibst du?

Antworte NUR mit validem JSON:
{"action":"redistribute|skip|accept_loss","reason":"Kurze Begründung","recommendation":"Empfehlung für nächste Schritte","affectedAgents":[],"critical":true|false}`;

      const response = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
      accumulateTokenUsage(this.coordinatorTokenUsage, prompt, response);
      this._checkTokenBudget();

      let adaptation = {
        action: 'accept_loss',
        reason: 'Automatische Analyse nicht möglich',
        recommendation: '',
        affectedAgents: [],
        critical: false
      };

      try {
        const jsonMatch = response.match(/\{[\s\S]*?"action"[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (['redistribute', 'skip', 'accept_loss'].includes(parsed.action)) {
            adaptation = {
              action: parsed.action,
              reason: parsed.reason || '',
              recommendation: parsed.recommendation || '',
              affectedAgents: Array.isArray(parsed.affectedAgents) ? parsed.affectedAgents : [],
              critical: parsed.critical === true
            };
          }
        }
      } catch (parseErr) {
        logger.warn('Plan-Anpassung JSON Parse-Fehler', { error: parseErr.message });
        adaptation.reason = response.slice(0, 300);
      }

      const adaptEntry = {
        timestamp: Date.now(),
        failedAgentIndex: failedAgentIdx,
        failedAgentTitle: failedTask.title,
        error: sanitizeError(error, 200),
        adaptation: adaptation
      };

      this.coordAdaptations.push(adaptEntry);
      this.coordStatus = 'ready';
      this.emit('plan-adapted', adaptEntry);
      this.emit('coordinator', this._coordState());
      this._logActivity('plan_adapted', { failedAgent: agentNum, action: adaptation.action, critical: adaptation.critical });
      logger.info('Plan-Anpassung erstellt', { failedAgent: agentNum, action: adaptation.action });
      await this._saveState();

      return adaptation;
    } catch (e) {
      logger.warn('Plan-Anpassung fehlgeschlagen', { error: e.message });
      this.coordStatus = 'ready';
      this.emit('coordinator', this._coordState());
      return { action: 'accept_loss', reason: 'Analyse fehlgeschlagen', recommendation: '', affectedAgents: [], critical: false };
    }
  }

  // ── Agenten-Outputs zusammenführen (Intelligentes Merge-System) ──
  async _mergeOutputs(onlyAgentIds = null, strategy = null) {
    const mergeStrategy = strategy || CONFIG.mergeStrategy || 'latest';
    const mergeStartTime = Date.now();

    try {
      this.emit('merge-start', { strategy: mergeStrategy, timestamp: mergeStartTime });
      logger.info('Merge gestartet', { strategy: mergeStrategy, onlyAgentIds });

      const mergedDir = path.join(this.projectDir, 'merged');
      await fsp.mkdir(mergedDir, { recursive: true });

      const SKIP_FILES = new Set(['conversation.jsonl', 'task.md', 'transcript.md', 'prompts.jsonl']);
      const fileMap = new Map(); // Dateiname → [{ agentIndex, srcPath, stat }]
      let totalSize = 0;
      let scannedAgents = 0;

      // Phase 1: Alle Agent-Verzeichnisse scannen und Dateien sammeln
      for (let i = 0; i < this.agents.length; i++) {
        if (onlyAgentIds !== null && !onlyAgentIds.includes(i)) continue;
        const agent = this.agents[i];
        if (!agent.workDir) continue;

        let entries;
        try {
          entries = await fsp.readdir(agent.workDir, { withFileTypes: true });
        } catch (e) {
          logger.warn('Agent-Verzeichnis nicht lesbar', { agent: i + 1, error: e.message });
          continue;
        }
        scannedAgents++;

        for (const entry of entries) {
          if (entry.isDirectory() || SKIP_FILES.has(entry.name)) continue;
          const srcPath = path.join(agent.workDir, entry.name);
          let stat;
          try { stat = await fsp.stat(srcPath); } catch (e) { continue; }
          totalSize += stat.size;
          if (!fileMap.has(entry.name)) fileMap.set(entry.name, []);
          fileMap.get(entry.name).push({ agentIndex: i, srcPath, stat });
        }
      }

      // Phase 2: Konflikte erkennen und nach Strategie auflösen
      const mergedFiles = [];
      const conflicts = [];
      const fileOrigins = [];

      for (const [fileName, sources] of fileMap) {
        if (sources.length === 1) {
          const src = sources[0];
          try {
            await fsp.copyFile(src.srcPath, path.join(mergedDir, fileName));
            mergedFiles.push(fileName);
            fileOrigins.push({ name: fileName, agentIndex: src.agentIndex, agentNum: src.agentIndex + 1, size: src.stat.size, isConflict: false, resolution: null });
          } catch (e) { logger.warn('Kopieren fehlgeschlagen', { file: fileName, error: e.message }); }
        } else {
          const conflictInfo = {
            fileName,
            agents: sources.map(s => ({ agentIndex: s.agentIndex, agentNum: s.agentIndex + 1, agentTitle: this.agents[s.agentIndex]?.title || 'Unbekannt', size: s.stat.size, modified: s.stat.mtimeMs })),
            strategy: mergeStrategy, resolution: '',
          };

          if (mergeStrategy === 'manual') {
            for (const src of sources) {
              const ext = path.extname(fileName);
              const base = path.basename(fileName, ext);
              const destName = `${base}-agent${src.agentIndex + 1}${ext}`;
              try {
                await fsp.copyFile(src.srcPath, path.join(mergedDir, destName));
                mergedFiles.push(destName);
                fileOrigins.push({ name: destName, agentIndex: src.agentIndex, agentNum: src.agentIndex + 1, size: src.stat.size, isConflict: true, resolution: 'manual', originalName: fileName });
              } catch (e) { logger.warn('Kopieren fehlgeschlagen', { file: destName, error: e.message }); }
            }
            conflictInfo.resolution = `Alle ${sources.length} Versionen behalten mit Agent-Suffix`;
          } else {
            let winner;
            if (mergeStrategy === 'largest') {
              winner = sources.reduce((a, b) => a.stat.size >= b.stat.size ? a : b);
              conflictInfo.resolution = `Größte Datei gewählt (Agent ${winner.agentIndex + 1}, ${winner.stat.size} Bytes)`;
            } else {
              winner = sources.reduce((a, b) => a.stat.mtimeMs >= b.stat.mtimeMs ? a : b);
              conflictInfo.resolution = `Neueste Datei gewählt (Agent ${winner.agentIndex + 1}, ${new Date(winner.stat.mtimeMs).toISOString()})`;
            }
            try {
              await fsp.copyFile(winner.srcPath, path.join(mergedDir, fileName));
              mergedFiles.push(fileName);
              fileOrigins.push({ name: fileName, agentIndex: winner.agentIndex, agentNum: winner.agentIndex + 1, size: winner.stat.size, isConflict: true, resolution: mergeStrategy, originalName: fileName });
            } catch (e) { logger.warn('Kopieren fehlgeschlagen', { file: fileName, error: e.message }); }
          }
          conflicts.push(conflictInfo);
        }
      }

      // Phase 3: CONFLICTS.md erstellen (nur bei Konflikten)
      if (conflicts.length > 0) {
        let conflictsMd = `# Merge-Konflikte\n\n`;
        conflictsMd += `**Strategie:** ${mergeStrategy}\n`;
        conflictsMd += `**Anzahl Konflikte:** ${conflicts.length}\n`;
        conflictsMd += `**Zeitpunkt:** ${new Date().toISOString()}\n\n`;
        for (const c of conflicts) {
          conflictsMd += `## ${c.fileName}\n\n`;
          conflictsMd += `**Auflösung:** ${c.resolution}\n\n`;
          conflictsMd += `| Agent | Größe | Geändert |\n|-------|-------|----------|\n`;
          for (const a of c.agents) {
            const sizeStr = a.size < 1024 ? `${a.size} B` : `${Math.round(a.size / 1024)} KB`;
            conflictsMd += `| Agent ${a.agentNum} (${a.agentTitle}) | ${sizeStr} | ${new Date(a.modified).toLocaleString('de-DE')} |\n`;
          }
          conflictsMd += '\n';
        }
        try { await fsp.writeFile(path.join(mergedDir, 'CONFLICTS.md'), conflictsMd); mergedFiles.push('CONFLICTS.md'); } catch (e) { logger.warn('CONFLICTS.md schreiben fehlgeschlagen', { error: e.message }); }
      }

      // Phase 4: MERGE_REPORT.md erstellen
      const mergeDuration = Date.now() - mergeStartTime;
      let reportMd = `# Merge-Report\n\n`;
      reportMd += `**Projekt:** ${this.projectTitle || 'Unbenannt'}\n`;
      reportMd += `**Zeitpunkt:** ${new Date().toISOString()}\n`;
      reportMd += `**Strategie:** ${mergeStrategy}\n`;
      reportMd += `**Dauer:** ${mergeDuration}ms\n\n`;
      reportMd += `## Statistik\n\n| Metrik | Wert |\n|--------|------|\n`;
      reportMd += `| Gescannte Agenten | ${scannedAgents} |\n`;
      reportMd += `| Dateien gesamt | ${mergedFiles.length} |\n`;
      reportMd += `| Konflikte | ${conflicts.length} |\n`;
      const totalSizeStr = totalSize < 1024 ? `${totalSize} B` : totalSize < 1048576 ? `${Math.round(totalSize / 1024)} KB` : `${(totalSize / 1048576).toFixed(2)} MB`;
      reportMd += `| Gesamtgröße (Quellen) | ${totalSizeStr} |\n\n`;
      reportMd += `## Dateien nach Agent\n\n`;
      const byAgent = new Map();
      for (const fo of fileOrigins) {
        if (!byAgent.has(fo.agentNum)) byAgent.set(fo.agentNum, []);
        byAgent.get(fo.agentNum).push(fo);
      }
      for (const [agentNum, files] of byAgent) {
        const agentTitle = this.agents[agentNum - 1]?.title || 'Unbekannt';
        reportMd += `### Agent ${agentNum}: ${agentTitle}\n\n`;
        for (const f of files) {
          const sizeStr = f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`;
          const conflictMark = f.isConflict ? ` (Konflikt: ${f.resolution})` : '';
          reportMd += `- \`${f.name}\` (${sizeStr})${conflictMark}\n`;
        }
        reportMd += '\n';
      }
      if (conflicts.length > 0) {
        reportMd += `## Konflikt-Details\n\n`;
        for (const c of conflicts) {
          reportMd += `### ${c.fileName}\n- **Beteiligte Agenten:** ${c.agents.map(a => `Agent ${a.agentNum}`).join(', ')}\n- **Auflösung:** ${c.resolution}\n\n`;
        }
      }
      try { await fsp.writeFile(path.join(mergedDir, 'MERGE_REPORT.md'), reportMd); mergedFiles.push('MERGE_REPORT.md'); } catch (e) { logger.warn('MERGE_REPORT.md schreiben fehlgeschlagen', { error: e.message }); }

      // Phase 5: README.md erstellen (Abwärtskompatibel)
      let readme = `# ${this.projectTitle || 'Projekt'}\n\n`;
      readme += `${this.projectSummary || ''}\n\n`;
      readme += `## Agenten-Beiträge\n\n`;
      for (let i = 0; i < this.agents.length; i++) {
        const agent = this.agents[i];
        const task = this.tasks[i];
        readme += `### Agent ${i + 1}: ${agent.title || 'Unbekannt'}\n`;
        readme += `- **Aufgabe:** ${task ? task.task : 'n/a'}\n`;
        readme += `- **Lieferergebnis:** ${task ? task.deliverable : 'n/a'}\n`;
        readme += `- **Status:** ${agent.status || 'unbekannt'}\n\n`;
      }
      readme += `## Dateien\n\n`;
      for (const f of mergedFiles) {
        if (f === 'README.md' || f === 'MERGE_REPORT.md' || f === 'CONFLICTS.md') continue;
        readme += `- ${f}\n`;
      }
      if (conflicts.length > 0) {
        readme += `\n## Hinweise\n\nEs gab **${conflicts.length} Konflikte** beim Zusammenführen. Details siehe [CONFLICTS.md](CONFLICTS.md) und [MERGE_REPORT.md](MERGE_REPORT.md).\n`;
      }
      try { await fsp.writeFile(path.join(mergedDir, 'README.md'), readme); mergedFiles.push('README.md'); } catch (e) { logger.warn('README.md schreiben fehlgeschlagen', { error: e.message }); }

      // Merge-Ergebnis speichern und Events emittieren
      const mergeResult = {
        files: mergedFiles, dir: mergedDir, totalFiles: mergedFiles.length,
        conflicts: conflicts.length, strategy: mergeStrategy, totalSize,
        scannedAgents, duration: mergeDuration, conflictDetails: conflicts, fileOrigins,
      };
      this._lastMergeResult = mergeResult;

      logger.info('Merge abgeschlossen', { files: mergedFiles.length, conflicts: conflicts.length, strategy: mergeStrategy, duration: mergeDuration, dir: mergedDir });
      this.emit('merge-complete', { totalFiles: mergedFiles.length, conflicts: conflicts.length, strategy: mergeStrategy, duration: mergeDuration });
      // Abwärtskompatibilität: altes Event auch senden
      this.emit('merge_complete', { files: mergedFiles, dir: mergedDir });
      return mergeResult;
    } catch (e) {
      logger.error('Merge fehlgeschlagen', { error: e.message, strategy: mergeStrategy });
      this.emit('merge-complete', { totalFiles: 0, conflicts: 0, strategy: mergeStrategy, error: e.message });
      return null;
    }
  }

  // ── Manuelles Re-Merge mit anderer Strategie ──────────────────
  async remerge(strategy = null) {
    if (!this.projectDir || !this.projectId) {
      throw new Error('Kein aktives Projekt für Re-Merge');
    }
    if (this.phase !== 'complete' && this.phase !== 'partial') {
      throw new Error('Projekt muss abgeschlossen sein für Re-Merge');
    }
    const mergeStrategy = strategy || CONFIG.mergeStrategy || 'latest';
    const validStrategies = ['latest', 'largest', 'manual'];
    if (!validStrategies.includes(mergeStrategy)) {
      throw new Error(`Ungültige Merge-Strategie: ${mergeStrategy}. Erlaubt: ${validStrategies.join(', ')}`);
    }
    // Altes merged/ Verzeichnis leeren
    const mergedDir = path.join(this.projectDir, 'merged');
    try {
      const entries = await fsp.readdir(mergedDir);
      for (const entry of entries) { await fsp.unlink(path.join(mergedDir, entry)); }
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn('Altes merged/ konnte nicht geleert werden', { error: e.message });
    }
    // Nur erfolgreiche Agenten mergen
    const successAgentIds = this.agents.map((a, i) => (a.status === 'done' || a.status === 'skipped') ? i : -1).filter(i => i >= 0);
    const onlyIds = successAgentIds.length < this.agents.length ? successAgentIds : null;
    const result = await this._mergeOutputs(onlyIds, mergeStrategy);
    await this._saveState();
    return result;
  }

  // ── Letztes Merge-Ergebnis abrufen ────────────────────────────
  getLastMergeResult() {
    return this._lastMergeResult || null;
  }

  // ── Einzelnen Agenten neu starten ───────────────────────────
  async retryAgent(idx) {
    if (idx < 0 || idx >= this.tasks.length) throw new Error('Ungültiger Agent-Index');
    this.agents[idx].conversation = [];
    this.agents[idx].rounds = 0;
    this.agents[idx].questions = 0;
    this.agents[idx].progress = 0;
    this.agents[idx].startTime = null;
    this.agents[idx].endTime = null;
    this.agents[idx].duration = null;
    await this._runAgent(idx);
  }

  // ── Benutzer-Intervention für laufenden Agenten setzen ──────
  setIntervention(agentIdx, message, type = 'redirect') {
    if (agentIdx < 0 || agentIdx >= this.agents.length) {
      throw new Error('Ungültiger Agent-Index');
    }

    // Typ validieren
    if (!VALID_INTERVENTION_TYPES.includes(type)) {
      throw new Error('Ungültiger Intervention-Typ: ' + type + '. Erlaubt: ' + VALID_INTERVENTION_TYPES.join(', '));
    }

    // Status-Prüfung je nach Typ
    const agent = this.agents[agentIdx];
    const allowedForNonWorking = ['skip', 'complete', 'restart'];
    if (agent.status !== 'working' && !allowedForNonWorking.includes(type)) {
      throw new Error('Agent ist nicht im Arbeitsstatus (Typ "' + type + '" erfordert Status "working")');
    }
    if (type === 'skip' && (agent.status === 'done' || agent.status === 'skipped')) {
      throw new Error('Agent ist bereits fertig oder übersprungen');
    }
    if (type === 'complete' && agent.status === 'done') {
      throw new Error('Agent ist bereits fertig');
    }
    if (type === 'restart' && agent.status === 'done') {
      throw new Error('Agent ist bereits fertig');
    }

    // Intervention-History initialisieren falls nicht vorhanden
    if (!Array.isArray(agent.interventionHistory)) {
      agent.interventionHistory = [];
    }

    // Intervention in History speichern
    const interventionEntry = {
      type,
      message: message || '',
      timestamp: Date.now(),
      round: agent.rounds || 0,
    };
    agent.interventionHistory.push(interventionEntry);

    // Sofort-Aktionen: skip und complete werden direkt ausgeführt
    if (type === 'skip') {
      this._patchAgent(agentIdx, {
        status: 'skipped',
        endTime: Date.now(),
        duration: agent.startTime ? Math.round((Date.now() - agent.startTime) / 1000) : 0,
        interventionHistory: agent.interventionHistory,
      });
      this._addAgentMsg(agentIdx, { from: 'system', text: '[Übersprungen] ' + (message || 'Agent wurde manuell übersprungen'), type: 'intervention' });
      this.emit('agent_intervention_applied', { agentIndex: agentIdx, agentNum: agentIdx + 1, type, message });
      this._logActivity('agent_skipped', { agentIndex: agentIdx, agentNum: agentIdx + 1, message });
      logger.info('Agent übersprungen', { agent: agentIdx + 1 });
      this._saveState();
      return;
    }

    if (type === 'complete') {
      this._patchAgent(agentIdx, {
        status: 'done',
        progress: 100,
        endTime: Date.now(),
        duration: agent.startTime ? Math.round((Date.now() - agent.startTime) / 1000) : 0,
        interventionHistory: agent.interventionHistory,
      });
      this._addAgentMsg(agentIdx, { from: 'system', text: '[Manuell fertig] ' + (message || 'Agent wurde manuell als fertig markiert'), type: 'intervention' });
      this.emit('agent_intervention_applied', { agentIndex: agentIdx, agentNum: agentIdx + 1, type, message });
      this._logActivity('agent_completed_manually', { agentIndex: agentIdx, agentNum: agentIdx + 1, message });
      logger.info('Agent manuell als fertig markiert', { agent: agentIdx + 1 });
      this._saveState();
      return;
    }

    // Für redirect, inject, restart: als pending speichern
    agent.pendingIntervention = message;
    agent.pendingInterventionType = type;
    this._patchAgent(agentIdx, { interventionHistory: agent.interventionHistory });
    this.emit('agent_intervention_queued', { agentIndex: agentIdx, agentNum: agentIdx + 1, type, message });
    this._logActivity('agent_intervention_queued', { agentIndex: agentIdx, agentNum: agentIdx + 1, type, message });
    logger.info('Intervention eingereiht', { agent: agentIdx + 1, type, message: (message || '').slice(0, 100) });
  }

  // ── Shared Context: lesen und schreiben ─────────────────────
  async _readSharedContext() {
    if (!this.projectDir) return '';
    const ctxFile = path.join(this.projectDir, 'shared-context.md');
    try {
      const content = await fsp.readFile(ctxFile, 'utf-8');
      return content.trim();
    } catch {
      return '';
    }
  }

  async _writeSharedContext(agentIdx) {
    if (!this.projectDir) return;
    const agent = this.agents[agentIdx];
    const task = this.tasks[agentIdx];
    const agentNum = agentIdx + 1;

    // Dateien im Agent-Verzeichnis auflesen
    let files = [];
    try {
      files = fs.readdirSync(agent.workDir).filter(f => f !== 'conversation.jsonl');
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }

    const entry = `## Agent ${agentNum}: ${task.title}\n` +
      `${task.deliverable}\n` +
      `Dateien: ${files.length > 0 ? files.join(', ') : 'keine'}\n\n`;

    const ctxFile = path.join(this.projectDir, 'shared-context.md');
    try {
      await fsp.appendFile(ctxFile, entry);
    } catch (e) {
      if (e.code === 'ENOSPC') {
        logger.warn('Kein Speicherplatz für shared-context.md');
      }
    }

    // Shared Context Board aktualisieren
    await this._addToSharedContextBoard(agentIdx, 'status', 'fertig');
    if (files.length > 0) {
      await this._addToSharedContextBoard(agentIdx, 'dateien', files.join(', '));
    }
  }

  // ── Shared Context Board: JSON-basierter gemeinsamer Speicher ──
  async _loadSharedContextBoard() {
    if (!this.projectDir) return [];
    const boardFile = path.join(this.projectDir, 'shared-context.json');
    try {
      const raw = await fsp.readFile(boardFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this._sharedContextBoard = parsed;
        return parsed;
      }
    } catch {
      // Datei existiert nicht oder ist ungueltig
    }
    return [];
  }

  async _saveSharedContextBoard() {
    if (!this.projectDir) return;
    const boardFile = path.join(this.projectDir, 'shared-context.json');
    try {
      await fsp.writeFile(boardFile, JSON.stringify(this._sharedContextBoard, null, 2));
    } catch (e) {
      logger.warn('Shared Context Board speichern fehlgeschlagen', { error: e.message });
    }
  }

  async _addToSharedContextBoard(agentIdx, key, value) {
    if (!this.projectDir) return;
    const entry = {
      agentIndex: agentIdx,
      key: String(key).slice(0, 100),
      value: String(value).slice(0, 1000),
      timestamp: Date.now(),
    };
    this._sharedContextBoard.push(entry);
    // Limit: max 200 Eintraege
    if (this._sharedContextBoard.length > 200) {
      this._sharedContextBoard = this._sharedContextBoard.slice(-200);
    }
    await this._saveSharedContextBoard();
    this.emit('shared_context_update', entry);
    logger.info('Shared Context Board Eintrag', { agent: agentIdx + 1, key, value: value.slice(0, 80) });
  }

  // ── Shared Files: Dateien im shared/ Ordner verwalten ──────────
  async _listSharedFiles() {
    if (!this.projectDir) return [];
    const sharedDir = path.join(this.projectDir, 'shared');
    try {
      const entries = await fsp.readdir(sharedDir, { withFileTypes: true });
      return entries
        .filter(e => e.isFile())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  async _ensureSharedDir() {
    if (!this.projectDir) return;
    const sharedDir = path.join(this.projectDir, 'shared');
    try {
      await fsp.mkdir(sharedDir, { recursive: true });
    } catch (e) {
      if (e.code !== 'EEXIST') logger.warn('shared/ Ordner erstellen fehlgeschlagen', { error: e.message });
    }
  }

  // ── Context-Zusammenfassung fuer Agent-Prompt (max 500 Woerter) ──
  async _buildAgentSharedContext(agentIdx) {
    const parts = [];
    const MAX_WORDS = 500;

    // 1. Shared Context Board Eintraege (von anderen Agenten)
    const boardEntries = this._sharedContextBoard
      .filter(e => e.agentIndex !== agentIdx)
      .slice(-30); // Letzte 30 relevante Eintraege
    if (boardEntries.length > 0) {
      parts.push('=== Shared Context Board ===');
      for (const e of boardEntries) {
        parts.push(`Agent ${e.agentIndex + 1} [${e.key}]: ${e.value}`);
      }
    }

    // 2. Pending Inter-Agent Nachrichten
    const pending = this._messageBoard.get(agentIdx);
    if (pending && pending.length > 0) {
      parts.push('=== Nachrichten an dich ===');
      for (const m of pending) {
        parts.push(`Agent ${m.from + 1}: ${m.text}`);
      }
    }

    // 3. Shared Files
    const sharedFiles = await this._listSharedFiles();
    if (sharedFiles.length > 0) {
      parts.push('=== Verfuegbare Shared Files (in shared/) ===');
      parts.push(sharedFiles.join(', '));
      parts.push('Du kannst diese Dateien lesen mit dem Pfad: ' + path.join(this.projectDir, 'shared') + '/<dateiname>');
    }

    if (parts.length === 0) return '';

    // Auf max 500 Woerter kuerzen
    let text = parts.join('\n');
    const words = text.split(/\s+/);
    if (words.length > MAX_WORDS) {
      text = '[... gekuerzt ...]\n' + words.slice(-MAX_WORDS).join(' ');
    }

    return text;
  }

  // ── Shared Context Entry aus Agent-Output extrahieren ──────────
  _parseSharedContextFromOutput(response, agentIdx) {
    // Pattern: KONTEXT: schluessel = wert
    const ctxRegex = /KONTEXT:\s*(\S+)\s*=\s*(.+?)(?:\n|$)/gi;
    let match;
    const entries = [];
    while ((match = ctxRegex.exec(response)) !== null) {
      const key = match[1].trim().slice(0, 100);
      const value = match[2].trim().slice(0, 1000);
      if (key && value) {
        entries.push({ key, value });
      }
    }
    return entries;
  }

  // ── Shared File Erkennung aus Agent-Output ─────────────────────
  async _detectAndCopySharedFiles(response, agentIdx) {
    // Pattern: SHARED FILE: dateiname
    const sharedRegex = /SHARED FILE:\s*(.+?)(?:\n|$)/gi;
    let match;
    while ((match = sharedRegex.exec(response)) !== null) {
      const fileName = match[1].trim();
      if (!fileName) continue;
      const agent = this.agents[agentIdx];
      if (!agent || !agent.workDir) continue;

      const srcPath = path.join(agent.workDir, fileName);
      const sharedDir = path.join(this.projectDir, 'shared');
      await this._ensureSharedDir();

      try {
        // Sicherheitscheck: Datei muss im Agent-Verzeichnis liegen
        const resolvedSrc = path.resolve(srcPath);
        const resolvedAgent = path.resolve(agent.workDir);
        if (!resolvedSrc.startsWith(resolvedAgent)) {
          logger.warn('Shared File: Pfad ausserhalb Agent-Verzeichnis', { agent: agentIdx + 1, file: fileName });
          continue;
        }

        await fsp.copyFile(srcPath, path.join(sharedDir, fileName));
        logger.info('Shared File kopiert', { agent: agentIdx + 1, file: fileName });
        this._logActivity('shared_file', { agentIndex: agentIdx, agentNum: agentIdx + 1, fileName });
        this.emit('shared_file', { agentIndex: agentIdx, fileName });
        await this._addToSharedContextBoard(agentIdx, 'shared_file', fileName);
      } catch (e) {
        logger.warn('Shared File kopieren fehlgeschlagen', { agent: agentIdx + 1, file: fileName, error: e.message });
      }
    }
  }

  // ── Datei-Snapshot: Verzeichnisinhalt mit Größe/mtime erfassen ──
  _snapshotDir(dir) {
    const snapshot = {};
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: false });
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            const filePath = path.join(dir, entry.name);
            const stat = fs.statSync(filePath);
            snapshot[entry.name] = { size: stat.size, mtime: stat.mtimeMs };
          } catch { /* best-effort, Datei evtl. zwischenzeitlich geloescht */ }
        }
      }
    } catch { /* best-effort, Verzeichnis evtl. nicht lesbar */ }
    return snapshot;
  }

  // ── Diff zwischen zwei Snapshots: erstellt/geändert ermitteln ──
  _diffSnapshot(before, after) {
    const changes = [];
    for (const [file, info] of Object.entries(after)) {
      if (!before[file]) {
        changes.push({ path: file, type: 'created', size: info.size });
      } else if (before[file].size !== info.size || before[file].mtime !== info.mtime) {
        changes.push({ path: file, type: 'modified', size: info.size });
      }
    }
    return changes;
  }

  // ── Agent-Statistiken berechnen ─────────────────────────────
  async _calculateAgentStats(agentDir) {
    const SKIP = new Set(['conversation.jsonl', 'task.md', 'transcript.md']);
    const TXT = new Set(['.js','.ts','.jsx','.tsx','.py','.rb','.go','.rs','.java','.c','.cpp','.h','.hpp','.cs','.php','.swift','.kt','.scala','.sh','.bash','.zsh','.ps1','.bat','.cmd','.sql','.html','.htm','.css','.scss','.less','.sass','.xml','.svg','.yaml','.yml','.toml','.ini','.cfg','.conf','.env','.md','.txt','.json','.jsonl','.csv','.tsv','.log','.vue','.svelte','.astro','.graphql','.gql','.proto','.dockerfile','.makefile','.cmake','.gradle','.r','.m','.mm','.lua','.dart','.ex','.exs','.erl','.hs','.elm','.clj','.cljs','.lisp','.scheme','.pl','.pm','.zig','.nim','.v','.tf','.hcl']);
    let filesCreated = 0, totalFileSize = 0, linesOfCode = 0, responseLength = 0;
    try {
      const entries = fs.readdirSync(agentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || SKIP.has(entry.name)) continue;
        filesCreated++;
        try {
          const fp = path.join(agentDir, entry.name);
          const st = fs.statSync(fp);
          totalFileSize += st.size;
          const ext = path.extname(entry.name).toLowerCase();
          if (TXT.has(ext) || ext === '') {
            linesOfCode += fs.readFileSync(fp, 'utf-8').split('\n').length;
          }
        } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
      }
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
    try {
      const convContent = await fsp.readFile(path.join(agentDir, 'conversation.jsonl'), 'utf-8');
      for (const line of convContent.trim().split('\n').filter(Boolean)) {
        try { const m = JSON.parse(line); if (m.from === 'agent' && m.text) responseLength += m.text.length; } catch { /* ungueltige JSONL-Zeile ignoriert */ }
      }
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
    return { filesCreated, totalFileSize, linesOfCode, responseLength };
  }

  // ── Qualitäts-Score für einen Agenten berechnen ─────────────

  // ── Agent-Output verifizieren ──────────────────────────────────
  async _verifyAgent(idx) {
    const task = this.tasks[idx];
    const agent = this.agents[idx];
    const agentDir = agent.workDir;
    const agentNum = idx + 1;

    logger.info('Agent-Verifizierung gestartet', { agent: agentNum });
    this._patchAgent(idx, { status: 'verifying' });

    // Dateien im Agent-Verzeichnis lesen (ohne Meta-Dateien)
    const SKIP_FILES = new Set(['conversation.jsonl', 'task.md', 'transcript.md']);
    let fileList = '(keine Dateien)';
    try {
      const entries = fs.readdirSync(agentDir, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile() && !SKIP_FILES.has(e.name))
        .map(e => e.name);
      if (files.length > 0) {
        fileList = files.join(', ');
      }
    } catch (e) {
      logger.warn('Fehler beim Lesen des Agent-Verzeichnisses für Verifizierung', { agent: agentNum, error: e.message });
    }

    const verifyPrompt = renderPrompt(this.prompts.agent_verify, {
      task: task.task,
      deliverable: task.deliverable,
      fileList: fileList,
    });

    let result = { verdict: 'partial', findings: 'Verifizierung fehlgeschlagen', suggestions: '' };

    try {
      const response = await runClaude(verifyPrompt, agentDir, this, this._activeProcesses, this._abortController.signal);

      // Token-Usage tracken
      accumulateTokenUsage(this.agents[idx].tokenUsage, verifyPrompt, response);
      this._patchAgent(idx, { tokenUsage: this.agents[idx].tokenUsage });

      // JSON aus Antwort extrahieren
      const jsonMatch = response.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (['pass', 'partial', 'fail'].includes(parsed.verdict)) {
            result = {
              verdict: parsed.verdict,
              findings: parsed.findings || '',
              suggestions: parsed.suggestions || '',
            };
          }
        } catch (parseErr) {
          logger.warn('Verifizierungs-JSON Parse-Fehler', { agent: agentNum, error: parseErr.message });
        }
      }

      // Fallback: Wenn kein JSON geparst werden konnte, Antwort als findings nutzen
      if (!jsonMatch) {
        result = {
          verdict: 'partial',
          findings: response.slice(0, 500),
          suggestions: '',
        };
      }
    } catch (e) {
      logger.warn('Verifizierung fehlgeschlagen', { agent: agentNum, error: e.message });
      result = {
        verdict: 'partial',
        findings: 'Verifizierung konnte nicht durchgeführt werden: ' + sanitizeError(e.message),
        suggestions: '',
      };
    }

    logger.info('Agent-Verifizierung abgeschlossen', { agent: agentNum, verdict: result.verdict });
    this._logActivity('agent_verified', { agentIndex: idx, agentNum, verdict: result.verdict, findings: result.findings });
    this._patchAgent(idx, { verification: result });
    this.emit('agent_verified', { index: idx, agentNum, verification: result });

    return result;
  }

  _scoreAgent(idx) {
    const agent = this.agents[idx];
    if (!agent) return 0;

    // ── 1. completionScore (0 oder 30): Hat der Agent "FERTIG" geschrieben? ──
    const completionScore = (agent.status === 'done') ? 30 : 0;

    // ── 2. fileScore (0-20): Hat der Agent Dateien erstellt? ──
    const filesCreated = (agent.stats && agent.stats.filesCreated) || 0;
    let fileScore = 0;
    if (filesCreated >= 5) fileScore = 20;
    else if (filesCreated >= 3) fileScore = 15;
    else if (filesCreated >= 2) fileScore = 10;
    else if (filesCreated >= 1) fileScore = 5;

    // ── 3. qualityScore (0-20): Laenge und Substanz des Outputs ──
    const responseLength = (agent.stats && agent.stats.responseLength) || 0;
    const linesOfCode = (agent.stats && agent.stats.linesOfCode) || 0;
    let qualityScore = 0;
    // Output-Laenge bewerten (mindestens 100 Zeichen fuer Punkte)
    if (responseLength >= 2000) qualityScore += 10;
    else if (responseLength >= 500) qualityScore += 7;
    else if (responseLength >= 100) qualityScore += 3;
    // Code-Zeilen als Substanz-Indikator
    if (linesOfCode >= 100) qualityScore += 10;
    else if (linesOfCode >= 30) qualityScore += 7;
    else if (linesOfCode >= 10) qualityScore += 4;
    else if (linesOfCode >= 1) qualityScore += 2;
    qualityScore = Math.min(20, qualityScore);

    // ── 4. efficiencyScore (0-15): Weniger Runden = besser ──
    const rounds = agent.rounds || 1;
    let efficiencyScore = 15;
    if (rounds <= 2) efficiencyScore = 15;      // 1-2 Runden = volle Punktzahl
    else if (rounds === 3) efficiencyScore = 10;
    else if (rounds === 4) efficiencyScore = 5;
    else efficiencyScore = 0;                    // 5+ Runden = 0

    // ── 5. questionScore (0-15): Wenige Fragen = besser ──
    const questions = agent.questions || 0;
    const questionScore = Math.max(0, 15 - (questions * 5));

    // ── Gesamt: Summe aller Teil-Scores ──
    const scores = {
      completion: completionScore,
      file: fileScore,
      quality: qualityScore,
      efficiency: efficiencyScore,
      question: questionScore,
      total: completionScore + fileScore + qualityScore + efficiencyScore + questionScore,
    };

    // Verifizierungs-Bonus/Malus (auf Gesamt anwenden)
    if (agent.verification) {
      if (agent.verification.verdict === 'pass') scores.total += 5;
      else if (agent.verification.verdict === 'fail') scores.total -= 10;
    }

    // Score auf 0-100 begrenzen
    scores.total = Math.max(0, Math.min(100, scores.total));

    this._patchAgent(idx, { score: scores.total, scores });
    logger.info('Agent-Score berechnet', { agent: idx + 1, scores });

    // SSE-Event: agent-score
    this.emit('agent-score', { agentIndex: idx, scores });

    return scores.total;
  }

  // ── Verifikation nach Agent-Abschluss ─────────────────────────
  _verifyAgentDeliverables(idx) {
    const agent = this.agents[idx];
    const task = this.tasks[idx];
    const agentNum = idx + 1;
    const warnings = [];

    // 1. Prüfe ob Deliverable-Dateien im agent-N/ Verzeichnis existieren
    const SKIP_FILES = new Set(['conversation.jsonl', 'task.md', 'transcript.md', 'prompts.jsonl']);
    let deliverableFiles = [];
    try {
      const entries = fs.readdirSync(agent.workDir, { withFileTypes: true });
      deliverableFiles = entries
        .filter(e => e.isFile() && !SKIP_FILES.has(e.name))
        .map(e => e.name);
    } catch (e) {
      warnings.push(`Verzeichnis konnte nicht gelesen werden: ${sanitizeError(e.message)}`);
    }

    if (deliverableFiles.length === 0) {
      warnings.push(`Agent ${agentNum} hat keine Deliverable-Dateien erstellt`);
    }

    // 2. Prüfe ob Output mindestens 100 Zeichen lang ist
    const responseLength = (agent.stats && agent.stats.responseLength) || 0;
    if (responseLength < 100) {
      warnings.push(`Agent ${agentNum} Output ist zu kurz (${responseLength} Zeichen, Minimum: 100)`);
    }

    // 3. Prüfe ob das erwartete Deliverable plausibel vorhanden ist
    if (task && task.deliverable && deliverableFiles.length > 0) {
      // Einfache Heuristik: Deliverable-Beschreibung gegen Dateinamen prüfen
      const delivLower = task.deliverable.toLowerCase();
      const hasRelevantFile = deliverableFiles.some(f => {
        const fLower = f.toLowerCase();
        return delivLower.includes(fLower.replace(/\.[^.]+$/, '')) ||
               fLower.includes('index') || fLower.includes('main') || fLower.includes('app');
      });
      if (!hasRelevantFile && deliverableFiles.length < 2) {
        warnings.push(`Agent ${agentNum}: Deliverable "${task.deliverable}" moeglicherweise nicht vollstaendig erfuellt`);
      }
    }

    // Warnungen loggen
    for (const warn of warnings) {
      logger.warn('Agent-Verifikation', { agent: agentNum, warning: warn });
      this._logActivity('agent_verification_warning', { agentIndex: idx, agentNum, warning: warn });
    }

    return {
      passed: warnings.length === 0,
      warnings,
      filesFound: deliverableFiles,
      responseLength,
    };
  }

  // ── Durchschnittlichen Projekt-Score berechnen ──────────────
  _calculateProjectScore() {
    const scoredAgents = this.agents.filter(a => a.score != null);
    if (scoredAgents.length === 0) return 0;

    // Durchschnitt aller Agent-Scores
    const avgScore = scoredAgents.reduce((sum, a) => sum + a.score, 0) / scoredAgents.length;

    // Bonus wenn alle Agents 'done' sind (+10)
    const allDone = this.agents.every(a => a.status === 'done');
    const doneBonus = allDone ? 10 : 0;

    // Malus fuer fehlgeschlagene Agents (-20 pro error)
    const errorCount = this.agents.filter(a => a.status === 'error').length;
    const errorMalus = errorCount * 20;

    // Breakdown erstellen
    const breakdown = {
      averageAgentScore: Math.round(avgScore),
      allDoneBonus: doneBonus,
      errorMalus: -errorMalus,
      errorCount,
      agentScores: this.agents.map((a, i) => ({
        agent: i + 1,
        title: a.title || '',
        score: a.score || 0,
        scores: a.scores || null,
        status: a.status,
      })),
    };

    // Gesamt berechnen und begrenzen
    const projectScore = Math.max(0, Math.min(100, Math.round(avgScore + doneBonus - errorMalus)));

    // SSE-Event: project-score
    this.emit('project-score', { score: projectScore, breakdown });

    logger.info('Projekt-Score berechnet', { projectScore, breakdown: { avg: breakdown.averageAgentScore, bonus: doneBonus, malus: -errorMalus } });

    return projectScore;
  }

  // ── Token-Budget prüfen ─────────────────────────────────────
  _checkTokenBudget() {
    const state = this.getState();
    const total = state.totalTokenUsage.totalTokens;
    const cost = state.totalTokenUsage.estimatedCost;

    // Warn-Budget prüfen
    if (CONFIG.warnTokenBudget > 0 && total >= CONFIG.warnTokenBudget && !this._budgetWarned) {
      this._budgetWarned = true;
      this.emit('budget_warning', {
        totalTokens: total,
        warnTokenBudget: CONFIG.warnTokenBudget,
        maxTokenBudget: CONFIG.tokenBudget,
        estimatedCost: cost,
        message: `Token-Warnschwelle erreicht: ${total} / ${CONFIG.warnTokenBudget} Tokens (geschätzte Kosten: $${cost.toFixed(4)})`
      });
      logger.warn('Token-Budget Warnschwelle erreicht', { total, warn: CONFIG.warnTokenBudget, cost });
    }

    // Max-Budget prüfen
    if (CONFIG.tokenBudget > 0 && total >= CONFIG.tokenBudget) {
      this._budgetExceeded = true;
      this.emit('budget_exceeded', {
        totalTokens: total,
        tokenBudget: CONFIG.tokenBudget,
        estimatedCost: cost,
        message: `Token-Budget überschritten: ${total} / ${CONFIG.tokenBudget} Tokens – neue Agenten werden gestoppt`
      });
      logger.error('Token-Budget überschritten', { total, budget: CONFIG.tokenBudget, cost });
    }
  }

  // ── Prüft ob Budget überschritten ist (für Agent-Stop) ──────
  _isBudgetExceeded() {
    if (CONFIG.tokenBudget <= 0) return false;
    const state = this.getState();
    return state.totalTokenUsage.totalTokens >= CONFIG.tokenBudget;
  }

  // ── Projekt-ETA berechnen und als SSE-Event senden ──────────
  _emitProjectEta() {
    const agents = this.agents;
    if (!agents || agents.length === 0) return;

    const activeAgents = agents.filter(a =>
      a.status === 'working' || a.status === 'asking' ||
      a.status === 'waiting' || a.status === 'waiting_deps' || a.status === 'retrying'
    );
    const doneCount = agents.filter(a =>
      a.status === 'done' || a.status === 'error' || a.status === 'skipped'
    ).length;
    const totalCount = agents.length;

    // Gesamt-Fortschritt in Prozent
    const projectPercent = totalCount > 0
      ? Math.round(agents.reduce((s, a) => s + (a.progress || 0), 0) / totalCount)
      : 0;

    // Projekt-ETA: laengster verbleibender Agent bestimmt die Restzeit
    let maxEtaSeconds = 0;
    for (const a of activeAgents) {
      const eta = a.etaSeconds || 0;
      if (eta > maxEtaSeconds) maxEtaSeconds = eta;
    }

    // Fuer wartende Agenten ohne ETA: schaetze auf Basis durchschnittlicher Agenten-Dauer
    const finishedAgents = agents.filter(a => a.status === 'done' && a.duration > 0);
    if (finishedAgents.length > 0 && activeAgents.some(a => !a.etaSeconds)) {
      const avgAgentDuration = finishedAgents.reduce((s, a) => s + a.duration, 0) / finishedAgents.length;
      const waitingWithoutEta = activeAgents.filter(a => !a.etaSeconds);
      // Bei paralleler Ausfuehrung: Semaphore-Concurrency beruecksichtigen
      const concurrency = CONFIG.maxParallelAgents || 1;
      const batchesLeft = Math.ceil(waitingWithoutEta.length / concurrency);
      const waitingEta = Math.round(batchesLeft * avgAgentDuration);
      if (waitingEta > maxEtaSeconds) maxEtaSeconds = waitingEta;
    }

    // Koordinator-Summary-Zeit schaetzen (ca. 30s wenn noch ausstehend)
    const summaryBuffer = (doneCount < totalCount) ? 30 : 0;
    const totalEtaSeconds = maxEtaSeconds + summaryBuffer;

    // Projekt-ETA darf nicht rueckwaerts gehen
    const prevProjectEta = this._lastProjectEtaSeconds;
    if (prevProjectEta != null && totalEtaSeconds > prevProjectEta && doneCount < totalCount) {
      this._lastProjectEtaSeconds = totalEtaSeconds;
    } else if (totalEtaSeconds <= (prevProjectEta || Infinity)) {
      this._lastProjectEtaSeconds = totalEtaSeconds;
    }
    const safeEta = this._lastProjectEtaSeconds || totalEtaSeconds;

    this.projectEta = safeEta;
    this.projectPercent = projectPercent;

    this.emit('project-eta', {
      eta: safeEta,
      percent: projectPercent,
      activeAgents: activeAgents.length,
      doneAgents: doneCount,
      totalAgents: totalCount,
    });
  }

  // ── Hilfsfunktionen ─────────────────────────────────────────
  _coordState() {
    return {
      status: this.coordStatus,
      summary: this.projectSummary,
      activeQuestion: this.coordActiveQ,
      log: this.coordLog,
      interimReports: this.coordInterimReports,
      finalReport: this.coordFinalReport,
      adaptations: this.coordAdaptations
    };
  }

  _patchAgent(i, patch) {
    this.agents[i] = { ...this.agents[i], ...patch };
    this.emit('agent', { index: i, agent: this.agents[i] });
  }

  async _addAgentMsg(i, msg) {
    // Auf Disk schreiben (append)
    const logFile = path.join(this.agents[i].workDir, 'conversation.jsonl');
    try {
      await fsp.appendFile(logFile, JSON.stringify({ ...msg, ts: Date.now() }) + '\n');
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }

    // Im RAM: nur letzte 20 Messages behalten
    this.agents[i].conversation.push(msg);
    if (this.agents[i].conversation.length > MAX_CONVERSATION_RAM) {
      this.agents[i].conversation = this.agents[i].conversation.slice(-MAX_CONVERSATION_RAM);
    }

    this.emit('agent_msg', { index: i, msg });
  }
}

// ── Resume-Logik: nicht-fertige Agenten nach Recovery fortsetzen ──
Orchestrator.prototype._resumeAgents = async function() {
  const pendingIndices = [];
  for (let i = 0; i < this.agents.length; i++) {
    if (this.agents[i].status === 'waiting') {
      pendingIndices.push(i);
    }
  }

  if (pendingIndices.length === 0) {
    // Alle Agenten bereits fertig → Zusammenfassung + Abschluss
    logger.info('Alle Agenten bereits fertig, erstelle Zusammenfassung');
    await this._coordinatorSummary();
    const successAgents = this.agents.filter(a => a.status === 'done' || a.status === 'skipped');
    const failedAgents = this.agents.filter(a => a.status === 'error');
    await this._mergeOutputs(failedAgents.length > 0 ? successAgents.map(a => a.id) : null);
    this.completedAt = Date.now();
    this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);
    this.projectScore = this._calculateProjectScore();

    if (failedAgents.length === this.agents.length) {
      this.phase = 'error';
      this.emit('phase', { phase: 'error', totalDuration: this.totalDuration });
    } else if (failedAgents.length > 0) {
      this.phase = 'partial';
      this.emit('phase', { phase: 'partial', totalDuration: this.totalDuration, successCount: successAgents.length, failedCount: failedAgents.length, projectScore: this.projectScore });
    } else {
      this.phase = 'complete';
      this.emit('phase', { phase: 'complete', totalDuration: this.totalDuration, projectScore: this.projectScore });
    }
    await this._saveStateImmediate();
    return;
  }

  logger.info('Resume: starte nicht-fertige Agenten', { pending: pendingIndices.map(i => i + 1) });
  this._logActivity('recovery_resume', { pendingAgents: pendingIndices.map(i => i + 1) });

  const semaphore = new Semaphore(CONFIG.maxParallelAgents);
  const agentCompletions = [];

  for (const i of pendingIndices) {
    agentCompletions.push((async () => {
      // Abhaengigkeiten: nur auf noch nicht fertige warten
      const deps = this.tasks[i] ? (this.tasks[i].depends_on || []) : [];
      const pendingDeps = deps.filter(d => d >= 0 && d < this.agents.length && d !== i &&
        this.agents[d].status !== 'done' && this.agents[d].status !== 'error' && this.agents[d].status !== 'skipped');
      if (pendingDeps.length > 0) {
        const depsLabel = pendingDeps.map(d => 'Agent ' + (d + 1)).join(', ');
        this._patchAgent(i, { status: 'waiting_deps', waitingFor: depsLabel });
        // Warte bis Abhaengigkeiten fertig
        while (pendingDeps.some(d => this.agents[d].status === 'waiting' || this.agents[d].status === 'working' || this.agents[d].status === 'asking')) {
          await new Promise(r => setTimeout(r, 2000));
          if (this._abortController.signal.aborted) return;
        }
      }

      await semaphore.acquire();
      try {
        this._checkAborted();
        await this._runAgent(i);
      } catch (e) {
        if (!this._abortController.signal.aborted) {
          logger.error('Agent-Fehler (Resume)', { agent: i + 1, error: e.message });
          this._patchAgent(i, { status: 'error' });
          this._addAgentMsg(i, { from: 'agent', text: 'Fehler (Resume): ' + sanitizeError(e.message), type: 'work' });
        }
      } finally {
        semaphore.release();
      }
    })());
  }

  await Promise.allSettled(agentCompletions);

  if (this._abortController.signal.aborted) return;

  // Ergebnis-Analyse
  const successAgents = this.agents.filter(a => a.status === 'done' || a.status === 'skipped');
  const failedAgents = this.agents.filter(a => a.status === 'error');
  const allFailed = failedAgents.length === this.agents.length;

  if (!allFailed) {
    await this._coordinatorSummary();
    await this._mergeOutputs(failedAgents.length > 0 ? successAgents.map(a => a.id) : null);
  }

  this.completedAt = Date.now();
  this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);
  this.projectScore = this._calculateProjectScore();

  if (allFailed) {
    this.phase = 'error';
    this.emit('phase', { phase: 'error', totalDuration: this.totalDuration });
  } else if (failedAgents.length > 0) {
    this.phase = 'partial';
    this.emit('phase', {
      phase: 'partial',
      totalDuration: this.totalDuration,
      successCount: successAgents.length,
      failedCount: failedAgents.length,
      failedAgents: failedAgents.map(a => a.id),
      projectScore: this.projectScore,
    });
  } else {
    this.phase = 'complete';
    this.emit('phase', { phase: 'complete', totalDuration: this.totalDuration, projectScore: this.projectScore });
  }

  await this._saveStateImmediate();
};

// ── Konfiguration lesen und aktualisieren ─────────────────────
Orchestrator.prototype.getConfig = function() {
  return {
    agentTimeout: CONFIG.timeout,
    maxRetries: CONFIG.maxRetries,
    retryBaseDelay: CONFIG.baseDelay,
    maxAgents: CONFIG.maxAgents,
    concurrency: CONFIG.maxParallelAgents,
    maxParallelAgents: CONFIG.maxParallelAgents,
    maxRounds: CONFIG.maxRounds,
    isolation: CONFIG.isolation,
    webhookUrl: CONFIG.webhookUrl || '',
    tokenBudget: CONFIG.tokenBudget,
    warnTokenBudget: CONFIG.warnTokenBudget,
    inputCostPerMTok: CONFIG.inputCostPerMTok,
    outputCostPerMTok: CONFIG.outputCostPerMTok,
    verifyAgents: CONFIG.verifyAgents,
    autoInterventionEnabled: CONFIG.autoInterventionEnabled,
    autoInterventionRounds: CONFIG.autoInterventionRounds,
    interimReportInterval: CONFIG.interimReportInterval,
    language: CONFIG.language,
    retryStrategy: _activeRetryStrategy.toJSON(),
    activeProfile: this.profileManager ? this.profileManager.getActiveProfile() : null,
  };
};

Orchestrator.prototype.updateConfig = function(patch, _skipHistory) {
  // Vorherigen Zustand für Undo speichern (nicht bei Undo/Redo selbst)
  if (!_skipHistory) {
    const snapshot = JSON.parse(JSON.stringify(CONFIG));
    this._configUndoStack.push(snapshot);
    if (this._configUndoStack.length > MAX_CONFIG_HISTORY) {
      this._configUndoStack.shift();
    }
    // Redo-Stack leeren bei neuer Änderung
    this._configRedoStack = [];
  }

  const RULES = {
    agentTimeout:      { key: 'timeout',          min: 30000,  max: 1800000 },
    maxRetries:        { key: 'maxRetries',        min: 0,      max: 20 },
    retryBaseDelay:    { key: 'baseDelay',         min: 1000,   max: 60000 },
    maxAgents:         { key: 'maxAgents',         min: 1,      max: 50 },
    concurrency:       { key: 'maxParallelAgents', min: 1,      max: 10 },
    maxParallelAgents: { key: 'maxParallelAgents', min: 1,      max: 10 },
    maxRounds:         { key: 'maxRounds',         min: 1,      max: 20 },
    tokenBudget:       { key: 'tokenBudget',       min: 0,      max: 100000000 },
    warnTokenBudget:   { key: 'warnTokenBudget',   min: 0,      max: 100000000 },
    inputCostPerMTok:  { key: 'inputCostPerMTok',  min: 0,      max: 1000, float: true },
    outputCostPerMTok: { key: 'outputCostPerMTok', min: 0,      max: 1000, float: true },
    autoInterventionRounds: { key: 'autoInterventionRounds', min: 2, max: 50 },
    interimReportInterval: { key: 'interimReportInterval', min: 1, max: 20 },
  };

  const VALID_ISOLATION_MODES = ['shared', 'strict'];

  const errors = [];
  const VALID_LANGUAGES = Object.keys(LANGUAGES);
  for (const [field, val] of Object.entries(patch)) {
    if (field === 'language') {
      if (VALID_LANGUAGES.includes(val)) {
        CONFIG.language = val;
        setLanguage(val);
      } else {
        errors.push(t('error.invalid_language', CONFIG.language, { lang: val, allowed: VALID_LANGUAGES.join(', ') }));
      }
      continue;
    }
    if (field === 'webhookUrl') {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === '') {
          CONFIG.webhookUrl = '';
        } else {
          try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              errors.push('webhookUrl muss mit http:// oder https:// beginnen');
            } else {
              CONFIG.webhookUrl = trimmed;
            }
          } catch {
            errors.push('webhookUrl ist keine gültige URL');
          }
        }
      }
      continue;
    }
    if (field === 'verifyAgents') {
      CONFIG.verifyAgents = val === true || val === 'true';
      continue;
    }
    if (field === 'autoInterventionEnabled') {
      CONFIG.autoInterventionEnabled = val === true || val === 'true';
      continue;
    }
    if (field === 'isolation') {
      if (!VALID_ISOLATION_MODES.includes(val)) {
        errors.push(`isolation muss 'shared' oder 'strict' sein`);
      } else {
        CONFIG.isolation = val;
      }
      continue;
    }
    const rule = RULES[field];
    if (!rule) {
      errors.push(`Unbekanntes Feld: ${field}`);
      continue;
    }
    const num = Number(val);
    if (!Number.isFinite(num) || num < rule.min || num > rule.max) {
      errors.push(`${field} muss zwischen ${rule.min} und ${rule.max} liegen`);
      continue;
    }
    CONFIG[rule.key] = rule.float ? parseFloat(num.toFixed(4)) : Math.round(num);
  }
  // Budget-Flags zurücksetzen wenn Budget geändert wurde
  if ('tokenBudget' in patch || 'warnTokenBudget' in patch) {
    this._budgetWarned = false;
    this._budgetExceeded = false;
  }
  // Retry-Strategie aktualisieren
  if ('retryStrategy' in patch) {
    try {
      const rsConfig = patch.retryStrategy;
      if (!rsConfig || typeof rsConfig !== 'object') {
        errors.push('retryStrategy muss ein Objekt sein');
      } else {
        validateRetryConfig(rsConfig);
        _activeRetryStrategy = createRetryStrategy(rsConfig);
        CONFIG.retryStrategy = rsConfig;
        this.emit('retry_strategy_changed', { strategy: _activeRetryStrategy.toJSON() });
      }
    } catch (e) {
      errors.push('retryStrategy: ' + e.message);
    }
  }
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
};

// ── Projekt-State aus Disk laden (für Wiederherstellung) ─────
Orchestrator.prototype.loadProject = function(projectId) {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const stateFile = path.join(projectDir, 'state.json');

  if (!fs.existsSync(stateFile)) {
    throw new Error(`Projekt ${projectId} nicht gefunden`);
  }

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));

  this.projectId = state.projectId || projectId;
  this.projectDir = projectDir;
  this.projectDesc = state.projectDesc || '';
  this.projectTitle = state.projectTitle || '';
  this.projectSummary = state.projectSummary || '';
  this.tags = state.tags || [];
  this.tasks = state.tasks || [];
  this.agents = state.agents || [];
  this.coordLog = (state.coordinator && state.coordinator.log) || [];
  this.coordStatus = (state.coordinator && state.coordinator.status) || 'done';
  this.coordInterimReports = (state.coordinator && state.coordinator.interimReports) || [];
  this.coordFinalReport = (state.coordinator && state.coordinator.finalReport) || null;
  this.coordAdaptations = (state.coordinator && state.coordinator.adaptations) || [];
  this.phase = state.phase || 'complete';
  this.startedAt = state.startedAt || null;
  this.completedAt = state.completedAt || null;
  this.totalDuration = state.totalDuration || null;
  this.projectScore = state.projectScore || null;

  // Conversations von Disk nachladen (JSONL)
  for (let i = 0; i < this.agents.length; i++) {
    const agentDir = path.join(projectDir, `agent-${i + 1}`);
    const logFile = path.join(agentDir, 'conversation.jsonl');
    if (fs.existsSync(logFile)) {
      try {
        const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
        this.agents[i].conversation = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .slice(-MAX_CONVERSATION_RAM); // nur letzte N im RAM
      } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
    }
  }

  this.emit('state', this.getState());
  logger.info('Projekt geladen', { projectId, phase: this.phase, agents: this.agents.length });
  return this.getState();
};


// ── Prompt-Templates API ──────────────────────────────────────
const PROMPT_VARIABLES = {
  coordinator_plan: ['agentCount', 'description'],
  coordinator_answer: ['description', 'taskSummary', 'agentNum', 'agentTitle', 'agentTask', 'previousQuestions', 'question'],
  coordinator_summary: ['description', 'agentResults'],
  agent_system: ['rolePrefix', 'agentNum', 'projectTitle', 'agentDir', 'task', 'deliverable', 'otherAgentsCtx', 'sharedCtx'],
  agent_verify: ['task', 'deliverable', 'fileList'],
};

Orchestrator.prototype.getPrompts = function() {
  return {
    prompts: { ...this.prompts },
    variables: { ...PROMPT_VARIABLES },
  };
};

Orchestrator.prototype.updatePrompts = function(patches) {
  const validKeys = Object.keys(HARDCODED_PROMPTS);
  const errors = [];

  for (const [key, value] of Object.entries(patches)) {
    if (!validKeys.includes(key)) {
      errors.push('Unbekanntes Prompt-Template: ' + key);
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(key + ' muss ein nicht-leerer String sein');
      continue;
    }
  }

  if (errors.length) {
    throw new Error(errors.join('; '));
  }

  for (const [key, value] of Object.entries(patches)) {
    if (validKeys.includes(key)) {
      this.prompts[key] = value;
    }
  }

  const promptsFile = path.join(__dirname, 'prompts.json');
  try {
    fs.writeFileSync(promptsFile, JSON.stringify(this.prompts, null, 2), 'utf-8');
    logger.info('Prompt-Templates gespeichert', { keys: Object.keys(patches) });
  } catch (e) {
    logger.error('Prompt-Templates speichern fehlgeschlagen', { error: e.message });
    throw new Error('Prompts konnten nicht gespeichert werden: ' + e.message);
  }
};

Orchestrator.prototype.resetPrompts = function() {
  this.prompts = { ...HARDCODED_PROMPTS };

  const promptsFile = path.join(__dirname, 'prompts.json');
  try {
    if (fs.existsSync(promptsFile)) {
      fs.unlinkSync(promptsFile);
    }
    logger.info('Prompt-Templates auf Standard zurueckgesetzt');
  } catch (e) {
    logger.warn('prompts.json konnte nicht geloescht werden', { error: e.message });
  }
};

// ── Projekt abbrechen (Abort) ────────────────────────────────
Orchestrator.prototype.abort = async function() {
  if (this.phase !== 'running') {
    throw new Error('Kein laufendes Projekt zum Abbrechen');
  }

  // Abort signal setzen
  this._abortController.abort();
  this._abortController = new AbortController();

  // Alle laufenden Prozesse beenden
  for (const proc of this._activeProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* best-effort, Prozess evtl. bereits beendet */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort, Prozess evtl. bereits beendet */ } }, 5000);
  }
  this._activeProcesses.clear();

  // Laufende Agenten als abgebrochen markieren
  for (let i = 0; i < this.agents.length; i++) {
    if (this.agents[i].status === 'working' || this.agents[i].status === 'asking' ||
        this.agents[i].status === 'waiting' || this.agents[i].status === 'waiting_deps' ||
        this.agents[i].status === 'retrying') {
      this.agents[i].status = 'error';
      this.agents[i].endTime = Date.now();
      if (this.agents[i].startTime) {
        this.agents[i].duration = Math.round((this.agents[i].endTime - this.agents[i].startTime) / 1000);
      }
      this.emit('agent', { index: i, agent: this.agents[i] });
    }
  }

  // Phase bestimmen
  const doneCount = this.agents.filter(a => a.status === 'done').length;
  const errorCount = this.agents.filter(a => a.status === 'error').length;

  this.completedAt = Date.now();
  this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);
  this.projectScore = this._calculateProjectScore();

  if (doneCount > 0) {
    this.phase = 'partial';
    this.emit('phase', {
      phase: 'partial',
      totalDuration: this.totalDuration,
      successCount: doneCount,
      failedCount: errorCount,
      failedAgents: this.agents.map((a, i) => a.status === 'error' ? i : -1).filter(i => i >= 0),
      projectScore: this.projectScore,
      aborted: true
    });
  } else {
    this.phase = 'error';
    this.emit('phase', { phase: 'error', totalDuration: this.totalDuration, aborted: true });
  }

  this._logActivity('project_aborted', { doneCount, errorCount, totalDuration: this.totalDuration });

  // State sofort speichern
  await this._saveStateImmediate();

  logger.info('Projekt abgebrochen', { doneCount, errorCount, totalDuration: this.totalDuration });
};

// ── Projekt fortsetzen (Resume) ──────────────────────────────
Orchestrator.prototype.resume = async function(projectId) {
  // State von Disk laden
  this.loadProject(projectId);

  // Sicherstellen, dass Agent workDir gesetzt ist
  for (let i = 0; i < this.agents.length; i++) {
    if (!this.agents[i].workDir) {
      this.agents[i].workDir = path.join(this.projectDir, `agent-${i + 1}`);
    }
  }

  // Conversation-History aus JSONL-Dateien laden (für Prompt-Kontext)
  const agentHistories = [];
  for (let i = 0; i < this.agents.length; i++) {
    const logFile = path.join(this.agents[i].workDir, 'conversation.jsonl');
    let historyText = '';
    try {
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.from === 'agent' && msg.text) {
              historyText += `\nAgent (vorherige Sitzung):\n${msg.text}\n`;
            } else if (msg.from === 'coordinator' && msg.text) {
              historyText += `\nKoordinator antwortet: ${msg.text}\n`;
            }
          } catch { /* ungueltige JSONL-Zeile ignoriert */ }
        }
      }
    } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
    agentHistories.push(historyText);
  }

  // Incomplete Statuse identifizieren
  const INCOMPLETE_STATUSES = new Set(['waiting', 'working', 'waiting_deps', 'retrying', 'asking']);

  // Error-Agenten zurücksetzen
  for (let i = 0; i < this.agents.length; i++) {
    if (this.agents[i].status === 'error') {
      this.agents[i].status = 'waiting';
      this.agents[i].conversation = [];
      this.agents[i].rounds = 0;
      this.agents[i].questions = 0;
      this.agents[i].progress = 0;
      this.agents[i].startTime = null;
      this.agents[i].endTime = null;
      this.agents[i].duration = null;
      this.agents[i].score = null;
      this.agents[i].stats = null;
      agentHistories[i] = ''; // Kein History für zurückgesetzte Agenten
      this._patchAgent(i, this.agents[i]);
    }
  }

  // Phase auf running setzen
  this.phase = 'running';
  this.coordStatus = 'ready';
  this.completedAt = null;
  this.totalDuration = null;
  this._abortController = new AbortController();
  this.emit('phase', { phase: 'running', startedAt: this.startedAt, resumed: true });
  await this._saveState();

  logger.info('Projekt wird fortgesetzt', {
    projectId,
    totalAgents: this.agents.length,
    doneAgents: this.agents.filter(a => a.status === 'done').length,
    incompleteAgents: this.agents.filter(a => INCOMPLETE_STATUSES.has(a.status)).length,
  });

  // Agenten mit Semaphore + Dependency-Handling ausführen (wie in start())
  const semaphore = new Semaphore(CONFIG.maxParallelAgents);
  logger.info('Parallele Ausfuehrung gestartet (Resume)', { maxParallelAgents: CONFIG.maxParallelAgents, agentCount: this.tasks.length });
  this.emit('parallel_start', { maxParallelAgents: CONFIG.maxParallelAgents, agentCount: this.tasks.length });
  const taskCount = this.tasks.length;
  const agentCompletions = new Array(taskCount);

  for (let i = 0; i < taskCount; i++) {
    agentCompletions[i] = (async () => {
      // Done-Agenten überspringen
      if (this.agents[i].status === 'done') {
        return;
      }

      // Auf Abhängigkeiten warten
      const deps = this.tasks[i].depends_on || [];
      if (deps.length > 0) {
        const validDeps = deps.filter(d => d >= 0 && d < taskCount && d !== i);
        if (validDeps.length > 0) {
          // Nur auf incomplete deps warten (done deps sind schon fertig)
          const incompleteDeps = validDeps.filter(d => this.agents[d].status !== 'done');
          if (incompleteDeps.length > 0) {
            const depsLabel = incompleteDeps.map(d => `Agent ${d + 1}`).join(', ');
            this._patchAgent(i, { status: 'waiting_deps', waitingFor: depsLabel });
            await Promise.allSettled(incompleteDeps.map(d => agentCompletions[d]));
            for (let r = 0; r < incompleteDeps.length; r++) {
              if (this.agents[incompleteDeps[r]] && this.agents[incompleteDeps[r]].status === 'error') {
                logger.warn('Abhängigkeit fehlgeschlagen (Resume), Agent startet trotzdem', {
                  agent: i + 1, failedDep: incompleteDeps[r] + 1
                });
                this._addAgentMsg(i, { from: 'system', text: 'Warnung: Abhängigkeit Agent ' + (incompleteDeps[r] + 1) + ' ist fehlgeschlagen. Agent startet trotzdem.', type: 'work' });
              }
            }
          }
        }
      }

      // Semaphore holen und ausführen
      await semaphore.acquire();
      try {
        this._checkAborted();
        await this._runHook('beforeAgent', { index: i, task: this.tasks[i], role: this.tasks[i].role || '', resumed: true });
        await this._runAgent(i);
        let agentFiles = [];
        try { agentFiles = fs.readdirSync(this.agents[i].workDir).filter(f => f !== 'conversation.jsonl'); } catch (e) { logger.warn('Dateioperation fehlgeschlagen', { error: e.message }); }
        await this._runHook('afterAgent', { index: i, status: this.agents[i].status, duration: this.agents[i].duration, files: agentFiles });
      } catch (e) {
        if (!this._abortController.signal.aborted) {
          logger.error('Agent-Fehler (Resume)', { agent: i + 1, error: e.message });
          await this._sendWebhook('agent_error', { agentIndex: i, task: this.tasks[i]?.title || '', error: sanitizeError(e.message) });
          await this._runHook('onError', { phase: `agent-${i + 1}`, error: e });

          if (CONFIG.autoRetry && !this._abortController.signal.aborted) {
            logger.info('Auto-Retry Agent (Resume)', { agent: i + 1 });
            this._patchAgent(i, { status: 'retrying' });
            this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${sanitizeError(e.message)} — Automatischer Neuversuch in ${Math.round(AUTO_RETRY_DELAY / 1000)}s…`, type: 'work' });
            this.emit('auto_retry', { index: i, attempt: 2, reason: sanitizeError(e.message) });
            await new Promise(r => setTimeout(r, AUTO_RETRY_DELAY));
            try {
              this.agents[i].conversation = [];
              this.agents[i].rounds = 0;
              this.agents[i].questions = 0;
              this.agents[i].progress = 0;
              this.agents[i].startTime = null;
              this.agents[i].endTime = null;
              this.agents[i].duration = null;
              await this._runAgent(i);
            } catch (e2) {
              logger.error('Auto-Retry fehlgeschlagen (Resume)', { agent: i + 1, error: e2.message });
              this._patchAgent(i, { status: 'error' });
              this._addAgentMsg(i, { from: 'agent', text: `Endgültiger Fehler: ${sanitizeError(e2.message)}`, type: 'work' });
            }
          } else {
            this._patchAgent(i, { status: 'error' });
            this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${sanitizeError(e.message)}`, type: 'work' });
          }
        }
      } finally {
        semaphore.release();
      }
    })();
  }

  await Promise.allSettled(agentCompletions);

  if (this._abortController.signal.aborted) return;

  // Ergebnis-Analyse (identisch zu start())
  const successAgents = this.agents.filter(a => a.status === 'done');
  const failedAgents = this.agents.filter(a => a.status === 'error');
  const allFailed = failedAgents.length === this.agents.length;
  const someFailed = failedAgents.length > 0 && !allFailed;

  if (allFailed) {
    this.phase = 'error';
    this.completedAt = Date.now();
    this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);
    logger.error('Alle Agenten fehlgeschlagen (Resume)', { projectId: this.projectId, totalDuration: this.totalDuration });
    this.emit('phase', { phase: 'error', totalDuration: this.totalDuration, failedAgents: failedAgents.map(a => a.id) });
    await this._sendWebhook('project_error', {
      title: this.projectTitle,
      totalDuration: this.totalDuration,
      agents: this.agents.map(a => ({ title: a.title, status: a.status })),
    });
    await this._runHook('onError', { phase: 'all_agents_failed', failedCount: failedAgents.length });
    await this._saveState();
    return;
  }

  // Koordinator-Zusammenfassung und Merge
  await this._coordinatorSummary();
  await this._mergeOutputs(someFailed ? successAgents.map(a => a.id) : null);

  this.completedAt = Date.now();
  this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);

  const projectScore = this._calculateProjectScore();
  this.projectScore = projectScore;
  logger.info('Projekt-Score berechnet (Resume)', { projectId: this.projectId, projectScore });

  if (someFailed) {
    this.phase = 'partial';
    logger.warn('Projekt teilweise abgeschlossen (Resume)', {
      projectId: this.projectId,
      success: successAgents.length,
      failed: failedAgents.length,
      totalDuration: this.totalDuration,
    });
    this.emit('phase', {
      phase: 'partial',
      totalDuration: this.totalDuration,
      successCount: successAgents.length,
      failedCount: failedAgents.length,
      failedAgents: failedAgents.map(a => a.id),
      projectScore,
    });
    await this._sendWebhook('project_partial', {
      title: this.projectTitle,
      totalDuration: this.totalDuration,
      agents: this.agents.map(a => ({ title: a.title, status: a.status })),
    });
  } else {
    this.phase = 'complete';
    logger.info('Projekt abgeschlossen (Resume)', { projectId: this.projectId, agents: this.tasks.length, totalDuration: this.totalDuration });
    this.emit('phase', { phase: 'complete', totalDuration: this.totalDuration, projectScore });
    await this._sendWebhook('project_completed', {
      title: this.projectTitle,
      totalDuration: this.totalDuration,
      agents: this.agents.map(a => ({ title: a.title, status: a.status })),
    });
  }

  await this._runHook('onComplete', { projectId: this.projectId, totalDuration: this.totalDuration, agents: this.agents });
  await this._saveStateImmediate();
};

// ── Process-Signal-Handler fuer Crash-Recovery ──────────────────
// Wird vom Server aufgerufen, um den Orchestrator zu registrieren
Orchestrator.prototype._installSignalHandlers = function() {
  if (this._signalHandlersInstalled) return;
  this._signalHandlersInstalled = true;

  const self = this;

  const emergencySave = async (reason) => {
    try {
      if (self.projectDir && (self.phase === 'running' || self.phase === 'awaiting_approval')) {
        logger.info('Notfall-Checkpoint wird erstellt', { reason });
        // Synchron-Variante fuer Notfall (writeFileSync)
        const json = JSON.stringify({
          ...self.getState(),
          _checkpoint: {
            reason: 'signal_' + reason,
            createdAt: Date.now(),
            createdAtISO: new Date().toISOString(),
            projectDir: self.projectDir,
            projectDesc: self.projectDesc,
          }
        }, null, 2);
        const targetFile = path.join(self.projectDir, 'state.checkpoint.1.json');
        fs.writeFileSync(targetFile, json);
        logger.info('Notfall-Checkpoint gespeichert', { reason, file: targetFile });
      }
    } catch (e) {
      logger.error('Notfall-Checkpoint fehlgeschlagen', { reason, error: e.message });
    }
  };

  process.on('uncaughtException', async (err) => {
    logger.error('Unbehandelte Ausnahme', { error: err.message, stack: err.stack });
    await emergencySave('uncaughtException');
    // Error-Log in Projektordner speichern
    if (self.projectDir) {
      try {
        fs.writeFileSync(path.join(self.projectDir, 'crash.log'),
          '[' + new Date().toISOString() + '] uncaughtException: ' + err.message + '\n' + (err.stack || '') + '\n');
      } catch (e) { /* ignorieren */ }
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('Unbehandelte Promise-Rejection', { error: msg });
    await emergencySave('unhandledRejection');
    if (self.projectDir) {
      try {
        fs.appendFileSync(path.join(self.projectDir, 'crash.log'),
          '[' + new Date().toISOString() + '] unhandledRejection: ' + msg + '\n');
      } catch (e) { /* ignorieren */ }
    }
  });
};

// ── Rollen-Management Methoden ────────────────────────────────

Orchestrator.prototype.getRoles = function() {
  return getAllRoles();
};

Orchestrator.prototype.getRolesData = function() {
  return loadRoles();
};

Orchestrator.prototype.createRole = function(roleData) {
  if (!roleData || !roleData.name || !roleData.systemPrompt) {
    throw new Error('Name und System-Prompt sind Pflichtfelder');
  }
  // ID generieren aus Name
  const id = roleData.id || roleData.name.toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

  if (!id) throw new Error('Ungültiger Rollen-Name');

  const data = loadRoles();
  // Prüfe ob ID bereits existiert
  const allExisting = [...data.defaultRoles, ...data.customRoles];
  if (allExisting.find(r => r.id === id)) {
    throw new Error('Eine Rolle mit dieser ID existiert bereits: ' + id);
  }

  const newRole = {
    id,
    name: roleData.name.trim(),
    description: (roleData.description || '').trim(),
    systemPrompt: roleData.systemPrompt.trim(),
    color: roleData.color || '#6b7280',
    icon: roleData.icon || 'custom',
    builtin: false
  };

  data.customRoles.push(newRole);
  saveRoles(data);
  logger.info('Neue Rolle erstellt', { id: newRole.id, name: newRole.name });
  return newRole;
};

Orchestrator.prototype.updateRole = function(roleId, patch) {
  if (!roleId) throw new Error('Rollen-ID fehlt');
  const data = loadRoles();

  // Nur custom Rollen dürfen bearbeitet werden
  const idx = data.customRoles.findIndex(r => r.id === roleId);
  if (idx === -1) {
    // Prüfe ob es eine builtin-Rolle ist
    if (data.defaultRoles.find(r => r.id === roleId)) {
      throw new Error('Vordefinierte Rollen können nicht bearbeitet werden');
    }
    throw new Error('Rolle nicht gefunden: ' + roleId);
  }

  const role = data.customRoles[idx];
  if (patch.name) role.name = patch.name.trim();
  if (patch.description !== undefined) role.description = (patch.description || '').trim();
  if (patch.systemPrompt) role.systemPrompt = patch.systemPrompt.trim();
  if (patch.color) role.color = patch.color;
  if (patch.icon) role.icon = patch.icon;

  data.customRoles[idx] = role;
  saveRoles(data);
  logger.info('Rolle aktualisiert', { id: roleId });
  return role;
};

Orchestrator.prototype.deleteRole = function(roleId) {
  if (!roleId) throw new Error('Rollen-ID fehlt');
  const data = loadRoles();

  // Nur custom Rollen dürfen gelöscht werden
  if (data.defaultRoles.find(r => r.id === roleId)) {
    throw new Error('Vordefinierte Rollen können nicht gelöscht werden');
  }

  const idx = data.customRoles.findIndex(r => r.id === roleId);
  if (idx === -1) {
    throw new Error('Rolle nicht gefunden: ' + roleId);
  }

  data.customRoles.splice(idx, 1);
  saveRoles(data);
  logger.info('Rolle gelöscht', { id: roleId });
  return { ok: true };
};


// ── Retry-Strategie API ──────────────────────────────────────
Orchestrator.prototype.getRetryStrategy = function() {
  return _activeRetryStrategy.toJSON();
};

Orchestrator.prototype.setRetryStrategy = function(config) {
  validateRetryConfig(config);
  const oldStrategy = _activeRetryStrategy;
  _activeRetryStrategy = createRetryStrategy(config);
  CONFIG.retryStrategy = config;
  this.emit('retry_strategy_changed', { strategy: _activeRetryStrategy.toJSON() });

  // CircuitBreaker Events
  if (oldStrategy.name === 'circuit-breaker' && _activeRetryStrategy.name !== 'circuit-breaker') {
    this.emit('circuit_breaker_closed', { reason: 'strategy_changed' });
  }

  return _activeRetryStrategy.toJSON();
};

Orchestrator.prototype.getRetryStrategies = function() {
  return RETRY_STRATEGIES;
};

Orchestrator.prototype.resetRetryStrategy = function() {
  _activeRetryStrategy.reset();
  if (_activeRetryStrategy.name === 'circuit-breaker') {
    this.emit('circuit_breaker_closed', { reason: 'manual_reset' });
  }
  return _activeRetryStrategy.toJSON();
};

// ── Profil-Management ─────────────────────────────────────────
Orchestrator.prototype.applyProfile = function(name) {
  const profile = this.profileManager.loadProfile(name);
  const fromProfile = this.profileManager.getActiveProfile();

  // Config-Werte aus dem Profil anwenden
  const errors = [];
  if (profile.config && typeof profile.config === 'object') {
    const result = this.updateConfig(profile.config);
    if (result && result.errors) {
      errors.push(...result.errors);
    }
  }

  this.profileManager.setActiveProfile(name);

  this.emit('profile_changed', {
    from: fromProfile,
    to: name,
    config: this.getConfig(),
  });

  return { ok: true, profile: name, config: this.getConfig(), errors };
};

Orchestrator.prototype.saveCurrentAsProfile = function(name, description) {
  const config = this.getConfig();
  // retryStrategy und activeProfile nicht im Profil-Config speichern
  const { retryStrategy, activeProfile, ...profileConfig } = config;
  const profile = this.profileManager.saveProfile(name, profileConfig, description);
  return profile;
};

Orchestrator.prototype.getProfiles = function() {
  return this.profileManager.listProfiles();
};

Orchestrator.prototype.getActiveProfile = function() {
  return this.profileManager.getActiveProfile();
};

// ── Config Undo/Redo ──────────────────────────────────────────
Orchestrator.prototype.undoConfig = function() {
  if (this._configUndoStack.length === 0) {
    throw new Error('Kein Config-Undo verfügbar');
  }
  this._configRedoStack.push(JSON.parse(JSON.stringify(CONFIG)));
  const prev = this._configUndoStack.pop();
  Object.assign(CONFIG, prev);
  this.emit('config_changed', { action: 'undo', config: this.getConfig() });
  return this.getConfig();
};

Orchestrator.prototype.redoConfig = function() {
  if (this._configRedoStack.length === 0) {
    throw new Error('Kein Config-Redo verfügbar');
  }
  this._configUndoStack.push(JSON.parse(JSON.stringify(CONFIG)));
  const next = this._configRedoStack.pop();
  Object.assign(CONFIG, next);
  this.emit('config_changed', { action: 'redo', config: this.getConfig() });
  return this.getConfig();
};

// ── Plan Undo/Redo ────────────────────────────────────────────
Orchestrator.prototype.undoPlan = function() {
  if (this._planUndoStack.length === 0) {
    throw new Error('Kein Plan-Undo verfügbar');
  }
  if (this.phase !== 'awaiting_approval') {
    throw new Error('Plan-Undo ist nur während der Plan-Genehmigung möglich');
  }
  this._planRedoStack.push({
    tasks: JSON.parse(JSON.stringify(this.tasks)),
    agents: JSON.parse(JSON.stringify(this.agents)),
  });
  const prev = this._planUndoStack.pop();
  this.tasks = prev.tasks;
  this.agents = prev.agents;
  this.emit('agents_updated', { agents: this.agents });
  this.emit('plan_changed', { action: 'undo', tasks: this.tasks });
  return { tasks: this.tasks, agents: this.agents };
};

Orchestrator.prototype.redoPlan = function() {
  if (this._planRedoStack.length === 0) {
    throw new Error('Kein Plan-Redo verfügbar');
  }
  if (this.phase !== 'awaiting_approval') {
    throw new Error('Plan-Redo ist nur während der Plan-Genehmigung möglich');
  }
  this._planUndoStack.push({
    tasks: JSON.parse(JSON.stringify(this.tasks)),
    agents: JSON.parse(JSON.stringify(this.agents)),
  });
  const next = this._planRedoStack.pop();
  this.tasks = next.tasks;
  this.agents = next.agents;
  this.emit('agents_updated', { agents: this.agents });
  this.emit('plan_changed', { action: 'redo', tasks: this.tasks });
  return { tasks: this.tasks, agents: this.agents };
};

Orchestrator.prototype.getUndoRedoStatus = function() {
  return {
    config: {
      canUndo: this._configUndoStack.length > 0,
      canRedo: this._configRedoStack.length > 0,
      undoCount: this._configUndoStack.length,
      redoCount: this._configRedoStack.length,
    },
    plan: {
      canUndo: this._planUndoStack.length > 0,
      canRedo: this._planRedoStack.length > 0,
      undoCount: this._planUndoStack.length,
      redoCount: this._planRedoStack.length,
    },
  };
};

// ── Snapshot-System ──────────────────────────────────────────

Orchestrator.prototype.createSnapshot = async function(name, description) {
  if (!this.projectId) {
    throw new Error('Kein aktives Projekt');
  }
  const state = this.getState();
  const result = await this.snapshotManager.createSnapshot(this.projectId, state, name, description);
  this.emit('snapshot_created', { snapshotId: result.snapshotId, name: result.name, trigger: 'manual' });
  return result;
};

Orchestrator.prototype.restoreSnapshot = async function(snapshotId) {
  const state = await this.snapshotManager.restoreSnapshot(snapshotId);

  // State wiederherstellen
  this.projectId = state.projectId;
  this.projectTitle = state.projectTitle || '';
  this.projectSummary = state.projectSummary || '';
  this.projectDesc = state.projectDesc || '';
  this.tasks = state.tasks || [];
  this.phase = state.phase || 'idle';
  this.startedAt = state.startedAt || null;
  this.completedAt = state.completedAt || null;
  this.totalDuration = state.totalDuration || null;
  this.projectScore = state.projectScore || null;
  this.projectEta = state.projectEta || null;
  this.projectPercent = state.projectPercent || 0;
  this.agents = (state.agents || []).map(a => ({
    ...a,
    conversation: a.conversation || [],
  }));
  if (state.coordinator) {
    this.coordLog = state.coordinator.log || [];
    this.coordStatus = state.coordinator.status || 'idle';
    this.coordInterimReports = state.coordinator.interimReports || [];
    this.coordFinalReport = state.coordinator.finalReport || null;
    this.coordAdaptations = state.coordinator.adaptations || [];
    if (state.coordinator.tokenUsage) {
      this.coordinatorTokenUsage = state.coordinator.tokenUsage;
    }
  }

  this.emit('snapshot_restored', { snapshotId });
  this.emit('state', this.getState());
  return state;
};

Orchestrator.prototype.getSnapshots = async function(projectId) {
  if (projectId) {
    return this.snapshotManager.listSnapshots(projectId);
  }
  return this.snapshotManager.listAllSnapshots();
};

Orchestrator.prototype.compareSnapshots = async function(id1, id2) {
  return this.snapshotManager.compareSnapshots(id1, id2);
};

Orchestrator.prototype._autoSnapshot = async function(trigger) {
  if (!this.projectId) return;
  try {
    const state = this.getState();
    const result = await this.snapshotManager.autoSnapshot(this.projectId, state, trigger);
    this.emit('snapshot_created', { snapshotId: result.snapshotId, name: result.name, trigger });
  } catch (e) {
    logger.warn('Auto-Snapshot fehlgeschlagen', { trigger, error: e.message });
  }
};

module.exports = Orchestrator;
