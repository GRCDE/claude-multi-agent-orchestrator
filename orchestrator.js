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

const PROJECTS_DIR = path.join(__dirname, 'projects');
const IS_WIN = process.platform === 'win32';

// ── Konfiguration ─────────────────────────────────────────────
const CONFIG = {
  timeout: parseInt(process.env.AGENT_TIMEOUT) || 300000,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
  baseDelay: parseInt(process.env.RETRY_BASE_DELAY) || 5000,
  maxAgents: parseInt(process.env.MAX_AGENTS) || 10,
  concurrency: parseInt(process.env.AGENT_CONCURRENCY) || 3,
  maxRounds: 5,
  autoRetry: process.env.AUTO_RETRY !== 'false',
};

// ── Semaphore für parallele Ausführung ────────────────────────
class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  async acquire() {
    if (this.count < this.max) { this.count++; return; }
    await new Promise(r => this.queue.push(r));
    this.count++;
  }
  release() { this.count--; if (this.queue.length) this.queue.shift()(); }
}

// ── Rate-Limit Patterns ───────────────────────────────────────
const RATE_LIMIT_PATTERNS = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /529/,
  /capacity/i,
  /try again/i,
];

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some(p => p.test(text));
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
  if (!message) return 'Unbekannter Fehler';
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
function trimHistory(text, maxWords = 2000) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return '[... gekürzt ...]\n' + words.slice(-maxWords).join(' ');
}

// ── Claude CLI Verfügbarkeit prüfen ───────────────────────────
function checkClaudeCli() {
  const cmd = IS_WIN ? 'claude.cmd' : 'claude';
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe', shell: true, timeout: 10000 });
    return { ok: true };
  } catch (e) {
    if (e.message.includes('ENOENT') || e.message.includes('not found') || e.message.includes('not recognized') || e.status === 127) {
      return {
        ok: false,
        error: 'Claude CLI nicht gefunden. Bitte installiere Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code\n\nStelle sicher, dass "claude" im PATH verfügbar ist.'
      };
    }
    // CLI existiert, anderer Fehler – wir lassen es durchgehen
    return { ok: true };
  }
}

// ── Run claude CLI (mit Rate-Limit Retry + Timeout + Process-Tracking) ──
function runClaude(prompt, workDir, emitter, activeProcesses, signal) {
  return _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, 0);
}

function _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, attempt) {
  return new Promise((resolve, reject) => {
    // Abbruch-Check
    if (signal && signal.aborted) {
      reject(new Error('Abgebrochen'));
      return;
    }

    const args = ['--dangerously-skip-permissions', '-p', prompt];
    // Security: shell:true nur auf Windows (nötig für .cmd), sonst weglassen
    const opts = {
      cwd: workDir || __dirname,
      env: { ...process.env },
    };
    if (IS_WIN) {
      opts.shell = true;
    }

    const cmd = IS_WIN ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, args, opts);

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
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
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
        emitter.emit('agent_stream', {
          index: emitter._streamingAgentIdx,
          chunk
        });
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

      // Rate-Limit Erkennung
      if (isRateLimited(combined) && attempt < CONFIG.maxRetries) {
        const delay = CONFIG.baseDelay * Math.pow(2, attempt);
        logger.warn('Rate-Limit erkannt', { attempt: attempt + 1, delay });
        if (emitter) {
          emitter.emit('rate_limit', {
            attempt: attempt + 1,
            maxRetries: CONFIG.maxRetries,
            waitMs: delay,
            message: `Rate-Limit erkannt, warte ${Math.round(delay / 1000)}s (Versuch ${attempt + 1}/${CONFIG.maxRetries})…`
          });
        }
        setTimeout(() => {
          _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, attempt + 1)
            .then(resolve)
            .catch(reject);
        }, delay);
        return;
      }

      if (isRateLimited(combined) && attempt >= CONFIG.maxRetries) {
        reject(new Error(`Rate-Limit nach ${CONFIG.maxRetries} Versuchen nicht aufgelöst. Bitte warte einige Minuten und versuche es erneut.`));
        return;
      }

      // Netzwerkfehler Erkennung
      if (isNetworkError(combined) && attempt < CONFIG.maxRetries) {
        const delay = CONFIG.baseDelay * Math.pow(2, attempt);
        if (emitter) {
          emitter.emit('network_error', {
            attempt: attempt + 1,
            maxRetries: CONFIG.maxRetries,
            waitMs: delay,
            message: `Netzwerkfehler, warte ${Math.round(delay / 1000)}s (Versuch ${attempt + 1}/${CONFIG.maxRetries})…`
          });
        }
        setTimeout(() => {
          _runClaudeWithRetry(prompt, workDir, emitter, activeProcesses, signal, attempt + 1)
            .then(resolve).catch(reject);
        }, delay);
        return;
      }

      if (isNetworkError(combined) && attempt >= CONFIG.maxRetries) {
        reject(new Error(`Netzwerkfehler nach ${CONFIG.maxRetries} Versuchen nicht behoben. Bitte Netzwerkverbindung prüfen.`));
        return;
      }

      if (out.trim()) resolve(out.trim());
      else if (err.trim()) resolve(err.trim());
      else reject(new Error(`claude exited with code ${code}`));
    });

    // Timeout: SIGTERM, nach 5s SIGKILL Fallback
    timer = setTimeout(() => {
      killed = true;
      cleanup();
      if (signal) signal.removeEventListener('abort', onAbort);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      reject(new Error(`Timeout nach ${Math.round(CONFIG.timeout / 1000)}s – der Agent hat zu lange gebraucht. Timeout konfigurierbar via AGENT_TIMEOUT Umgebungsvariable.`));
    }, CONFIG.timeout);
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

// ── Orchestrator ─────────────────────────────────────────────
class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this._abortController = new AbortController();
    this._activeProcesses = new Set();
    this.hooks = loadHooks();
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
    const webhookUrl = process.env.WEBHOOK_URL;
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
    // Alle laufenden Prozesse beenden
    this._abortController.abort();
    this._abortController = new AbortController();
    for (const proc of this._activeProcesses) {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    }
    this._activeProcesses.clear();

    this.projectId = null;
    this.projectDir = null;
    this.projectDesc = '';
    this.projectTitle = '';
    this.projectSummary = '';
    this.tasks = [];
    this.agents = [];
    this.coordLog = [];
    this.coordStatus = 'idle';
    this.coordActiveQ = null;
    this.phase = 'idle';
    this.startedAt = null;
    this.completedAt = null;
    this.totalDuration = null;
    this._approvalResolver = null;
  }

  emit(event, data) {
    super.emit('update', { event, data, ts: Date.now() });
    super.emit(event, data);
  }

  getState() {
    return {
      phase: this.phase,
      projectId: this.projectId,
      projectTitle: this.projectTitle,
      projectSummary: this.projectSummary,
      projectDesc: this.projectDesc || '',
      tasks: this.tasks,
      coordinator: {
        status: this.coordStatus,
        summary: this.projectSummary,
        activeQuestion: this.coordActiveQ,
        log: this.coordLog
      },
      agents: this.agents,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      totalDuration: this.totalDuration
    };
  }

  // ── State auf Disk speichern ────────────────────────────────
  async _saveState() {
    if (!this.projectDir) return;
    try {
      await fsp.writeFile(
        path.join(this.projectDir, 'state.json'),
        JSON.stringify(this.getState(), null, 2)
      );
    } catch {}
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
  modifyPlan(tasks) {
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
  async start(desc, agentCount, requireApproval) {
    this.reset();

    // CLI-Check bevor wir starten
    const cliCheck = checkClaudeCli();
    if (!cliCheck.ok) {
      this.phase = 'error';
      this.emit('phase', { phase: 'error', error: sanitizeError(cliCheck.error) });
      this.emit('error', { message: sanitizeError(cliCheck.error) });
      return;
    }

    // Input sanitieren
    this.projectDesc = sanitizeInput(desc);
    if (!this.projectDesc) {
      this.phase = 'error';
      this.emit('phase', { phase: 'error', error: 'Projektbeschreibung darf nicht leer sein' });
      this.emit('error', { message: 'Projektbeschreibung darf nicht leer sein' });
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
    } catch (e) {
      if (e.code === 'ENOSPC') {
        this.phase = 'error';
        this.emit('phase', { phase: 'error', error: sanitizeError('Kein Speicherplatz mehr verfügbar') });
        this.emit('error', { message: sanitizeError('Kein Speicherplatz mehr verfügbar') });
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
      id: i, title: 'Wird geplant…', task: '', deliverable: '', role: '',
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
          if (e.code === 'ENOSPC') throw new Error('Kein Speicherplatz mehr verfügbar');
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
    const semaphore = new Semaphore(CONFIG.concurrency);
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
          try { agentFiles = fs.readdirSync(this.agents[i].workDir).filter(f => f !== 'conversation.jsonl'); } catch {}
          await this._runHook('afterAgent', { index: i, status: this.agents[i].status, duration: this.agents[i].duration, files: agentFiles });
        } catch (e) {
          if (!this._abortController.signal.aborted) {
            logger.error('Agent-Fehler', { agent: i + 1, error: e.message });
            await this._sendWebhook('agent_error', { agentIndex: i, task: this.tasks[i]?.title || '', error: sanitizeError(e.message) });
            await this._runHook('onError', { phase: `agent-${i + 1}`, error: e });

            // Auto-Retry: einmal automatisch wiederholen
            if (CONFIG.autoRetry && !this._abortController.signal.aborted) {
              logger.info('Auto-Retry Agent', { agent: i + 1 });
              this._patchAgent(i, { status: 'retrying' });
              this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${sanitizeError(e.message)} — Automatischer Neuversuch in 10s…`, type: 'work' });
              this.emit('auto_retry', { index: i, attempt: 2, reason: sanitizeError(e.message) });
              await new Promise(r => setTimeout(r, 10000));
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

    // Ergebnis-Analyse: welche Agenten erfolgreich, welche fehlgeschlagen?
    const successAgents = this.agents.filter(a => a.status === 'done');
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
      await this._saveState();
      return;
    }

    // Koordinator-Zusammenfassung erstellen (auch bei teilweisem Erfolg)
    await this._coordinatorSummary();

    // Agenten-Outputs zusammenführen (nur von erfolgreichen Agenten)
    await this._mergeOutputs(someFailed ? successAgents.map(a => a.id) : null);

    this.completedAt = Date.now();
    this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);

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
      this.emit('phase', { phase: 'complete', totalDuration: this.totalDuration });
      await this._sendWebhook('project_completed', {
        title: this.projectTitle,
        totalDuration: this.totalDuration,
        agents: this.agents.map(a => ({ title: a.title, status: a.status })),
      });
    }

    await this._runHook('onComplete', { projectId: this.projectId, totalDuration: this.totalDuration, agents: this.agents });
    await this._saveState();
  }

  // ── Koordinator: Aufgaben planen ────────────────────────────
  async _coordinatorPlan(agentCount) {
    const prompt =
`Du bist Projekt-Koordinator. Analysiere das Projekt und erstelle genau ${agentCount} Teilaufgaben.

Constraints:
- Aufgaben sollen moeglichst unabhaengig sein
- Falls eine Aufgabe auf das Ergebnis einer anderen angewiesen ist, nutze "depends_on" mit den 0-basierten Indizes der Abhaengigkeiten
- Aufgaben ohne Abhaengigkeiten bekommen ein leeres Array: "depends_on":[]
- Jede Task-Beschreibung soll 100-500 Zeichen lang sein
- Keine Ueberlappung zwischen den Aufgaben
- Jede Aufgabe soll verschiedene Faehigkeiten/Bereiche abdecken

Antworte NUR mit validem JSON (kein Markdown, kein Text davor/danach):
{"project_title":"string","summary":"1-2 Saetze auf Deutsch","quality_notes":"Kurze Begruendung der Aufgabenstruktur","tasks":[{"title":"Kurztitel","task":"Detaillierte Aufgabe","deliverable":"Was der Agent liefern soll","role":"Passende Rolle, z.B. Backend-Entwickler, Frontend-Entwickler, DevOps-Ingenieur, etc.","depends_on":[]}]}

Projekt: ${this.projectDesc}`;

    const raw = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
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

    this.projectTitle = parsed.project_title || 'Projekt';
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
        if (e.code === 'ENOSPC') throw new Error('Kein Speicherplatz mehr verfügbar');
        throw e;
      }
      this._patchAgent(i, { title: task.title, task: task.task, deliverable: task.deliverable, role: task.role || '', depends_on: task.depends_on || [], workDir: agentDir });
    }

    // Projekt-Uebersicht speichern
    try {
      await fsp.writeFile(path.join(this.projectDir, 'project.md'),
        `# ${this.projectTitle}\n\n${this.projectSummary}\n\n## Agenten\n${this.tasks.map((t, i) => `- Agent ${i + 1}: ${t.title}`).join('\n')}\n`);
    } catch {}

    this.emit('coordinator', this._coordState());
    this.emit('project_meta', { title: this.projectTitle, summary: this.projectSummary, dir: this.projectDir });
    await this._saveState();
  }

  // ── Einen Agenten ausführen (mit Frage-Antwort-Schleife) ───
  async _runAgent(idx) {
    const task = this.tasks[idx];
    const agentDir = this.agents[idx].workDir;
    const agentNum = idx + 1;

    validateWorkDir(agentDir);
    logger.info('Agent gestartet', { agent: agentNum, task: task.title });
    this._patchAgent(idx, { status: 'working', progress: 10, startTime: Date.now() });
    await this._saveState();

    // Kontext über andere Agenten (was sie tun, ohne Details)
    const otherAgentsCtx = this.tasks
      .map((t, i) => i !== idx ? `- Agent ${i + 1}: ${t.title}` : null)
      .filter(Boolean)
      .join('\n');

    // Shared Context von bereits fertigen Agenten lesen
    const sharedCtx = await this._readSharedContext();

    // Lokaler Fragen-Zähler
    let questionsUsed = 0;

    // Verlauf für Multi-Turn (wird in den Prompt injiziert)
    let historyText = '';

    // Rollen-Prefix falls vorhanden
    const rolePrefix = task.role ? `Du bist ein erfahrener ${task.role}.\n` : '';

    const agentSystemPrompt =
`${rolePrefix}Du bist Agent ${agentNum} im Projekt "${this.projectTitle}".
Du arbeitest in deinem Verzeichnis: ${agentDir}

Deine Aufgabe: ${task.task}
Dein Lieferergebnis: ${task.deliverable}

Andere Agenten im Projekt (arbeiten parallel – NICHT von ihnen abhängig machen):
${otherAgentsCtx || 'Keine'}
${sharedCtx ? `\nBisheriger Kontext anderer Agenten:\n${sharedCtx}\n` : ''}
Regeln:
1. Arbeite konkret und erstelle echte Dateien in deinem Verzeichnis
2. Wenn du eine Klärung vom Koordinator brauchst: schreibe EXAKT "FRAGE: [deine genaue Frage]" und STOPPE SOFORT danach – schreibe NICHTS mehr nach der Frage
3. Maximal 2 Fragen erlaubt – nutze sie sinnvoll
4. Wenn du fertig bist: schreibe am Ende EXAKT "FERTIG" als letztes Wort
5. Schreibe NIEMALS "FRAGE:" und "FERTIG" in der gleichen Antwort`;

    for (let round = 0; round < CONFIG.maxRounds; round++) {
      this._checkAborted();
      const roundProgress = Math.min(90, Math.round(((round + 1) / CONFIG.maxRounds) * 80 + 10));
      this._patchAgent(idx, { rounds: round + 1, progress: roundProgress });

      const trimmedHistory = trimHistory(historyText);
      const fullPrompt = trimmedHistory
        ? `${agentSystemPrompt}\n\n## Bisheriger Verlauf:\n${trimmedHistory}\n\n## Nächster Schritt:\nFahre fort.`
        : `${agentSystemPrompt}\n\nStarte jetzt deine Aufgabe.`;

      this._streamingAgentIdx = idx;
      const response = await runClaude(fullPrompt, agentDir, this, this._activeProcesses, this._abortController.signal);
      this._streamingAgentIdx = undefined;

      this._checkAborted();

      const qMatch = response.match(/FRAGE:\s*(.+?)(?:\n|$)/i);
      const isDone = /FERTIG/i.test(response);

      // Bei FRAGE + FERTIG in gleicher Antwort: FRAGE hat Vorrang
      if (qMatch && questionsUsed < 2) {
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
          if (isDone) this._patchAgent(idx, { progress: 95 });
          const agentEndTime = Date.now();
          const agentDuration = Math.round((agentEndTime - (this.agents[idx].startTime || agentEndTime)) / 1000);
          this._patchAgent(idx, { status: 'done', progress: 100, endTime: agentEndTime, duration: agentDuration });
          // Transcript speichern
          try {
            await fsp.writeFile(path.join(agentDir, 'transcript.md'),
              `# Agent ${agentNum} Verlauf\n\n${historyText}`);
          } catch (e) {
            if (e.code === 'ENOSPC') {
              this._addAgentMsg(idx, { from: 'agent', text: 'Warnung: Kein Speicherplatz für Transcript', type: 'work' });
            }
          }
          // Shared Context aktualisieren für nachfolgende Agenten
          await this._writeSharedContext(idx);
          await this._saveState();
          return;
        }
      }
    }
    const agentEndTime2 = Date.now();
    const agentDuration2 = Math.round((agentEndTime2 - (this.agents[idx].startTime || agentEndTime2)) / 1000);
    this._patchAgent(idx, { status: 'done', progress: 100, endTime: agentEndTime2, duration: agentDuration2 });
    await this._writeSharedContext(idx);
    await this._saveState();
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
    const prompt =
`Du bist Projekt-Koordinator. Beantworte die Frage des Agenten kurz und präzise auf Deutsch.

Projektbeschreibung: ${this.projectDesc}

Alle Agenten-Aufgaben:
${taskSummary}

Agent ${agentIdx + 1} – Aufgabe: ${agentTask.title}
${agentTask.task}

${previousQuestions ? `Bisherige Fragen dieses Agents:\n${previousQuestions}\n` : ''}Agent ${agentIdx + 1} fragt: ${question}

Antworte direkt und konkret.`;

    const answer = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);

    this.coordLog.push({ agentIndex: agentIdx, question, answer });
    this.coordStatus = 'ready';
    this.coordActiveQ = null;
    this.emit('coordinator', this._coordState());
    await this._saveState();
    return answer;
  }

  // ── Koordinator: Abschluss-Zusammenfassung ──────────────────
  async _coordinatorSummary() {
    try {
      this.coordStatus = 'summarizing';
      this.emit('coordinator', this._coordState());

      const agentResults = this.agents.map((a, i) => {
        const task = this.tasks[i];
        return `- Agent ${i + 1} "${a.title}": Status=${a.status}, Lieferergebnis: ${task ? task.deliverable : 'n/a'}`;
      }).join('\n');

      const prompt =
`Du bist Projekt-Koordinator. Alle Agenten sind fertig. Erstelle eine kurze, prägnante Zusammenfassung auf Deutsch.

Projektbeschreibung: ${this.projectDesc}

Ergebnisse der Agenten:
${agentResults}

Fasse zusammen:
1. Was wurde insgesamt erreicht?
2. Welche Agenten waren erfolgreich, welche nicht?
3. Gibt es offene Punkte oder Empfehlungen?

Antworte in 3-6 Sätzen, klar und konkret.`;

      const summary = await runClaude(prompt, this.projectDir, this, this._activeProcesses, this._abortController.signal);
      this.projectSummary = summary;
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

  // ── Agenten-Outputs zusammenführen ──────────────────────────
  async _mergeOutputs(onlyAgentIds = null) {
    try {
      const mergedDir = path.join(this.projectDir, 'merged');
      await fsp.mkdir(mergedDir, { recursive: true });

      const SKIP_FILES = new Set(['conversation.jsonl', 'task.md', 'transcript.md']);
      const mergedFiles = [];
      const fileTracker = new Map(); // Dateiname → Agent-Index (für Konflikterkennung)

      for (let i = 0; i < this.agents.length; i++) {
        // Bei partiellem Erfolg nur erfolgreiche Agenten mergen
        if (onlyAgentIds !== null && !onlyAgentIds.includes(i)) continue;
        const agent = this.agents[i];
        if (!agent.workDir) continue;

        let entries;
        try {
          entries = fs.readdirSync(agent.workDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (entry.isDirectory() || SKIP_FILES.has(entry.name)) continue;

          const srcPath = path.join(agent.workDir, entry.name);
          let destName = entry.name;

          // Konflikt: gleicher Dateiname von anderem Agent
          if (fileTracker.has(entry.name)) {
            // Vorherige Datei umbenennen falls noch nicht geschehen
            const prevIdx = fileTracker.get(entry.name);
            if (prevIdx !== -1) {
              const prevDest = path.join(mergedDir, entry.name);
              const renamedPrev = `agent-${prevIdx + 1}_${entry.name}`;
              try {
                await fsp.rename(prevDest, path.join(mergedDir, renamedPrev));
                // In mergedFiles aktualisieren
                const fi = mergedFiles.findIndex(f => f === entry.name);
                if (fi !== -1) mergedFiles[fi] = renamedPrev;
              } catch {}
              fileTracker.set(entry.name, -1); // markiert als bereits umbenannt
            }
            destName = `agent-${i + 1}_${entry.name}`;
          } else {
            fileTracker.set(entry.name, i);
          }

          try {
            await fsp.copyFile(srcPath, path.join(mergedDir, destName));
            mergedFiles.push(destName);
          } catch {}
        }
      }

      // README.md erstellen
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
        readme += `- ${f}\n`;
      }

      await fsp.writeFile(path.join(mergedDir, 'README.md'), readme);
      mergedFiles.push('README.md');

      logger.info('Merge abgeschlossen', { files: mergedFiles.length, dir: mergedDir });
      this.emit('merge_complete', { files: mergedFiles, dir: mergedDir });
    } catch (e) {
      logger.warn('Merge fehlgeschlagen', { error: e.message });
    }
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
    } catch {}

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
  }

  // ── Hilfsfunktionen ─────────────────────────────────────────
  _coordState() {
    return {
      status: this.coordStatus,
      summary: this.projectSummary,
      activeQuestion: this.coordActiveQ,
      log: this.coordLog
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
    } catch {}

    // Im RAM: nur letzte 20 Messages behalten
    this.agents[i].conversation.push(msg);
    if (this.agents[i].conversation.length > 20) {
      this.agents[i].conversation = this.agents[i].conversation.slice(-20);
    }

    this.emit('agent_msg', { index: i, msg });
  }
}

// ── Konfiguration lesen und aktualisieren ─────────────────────
Orchestrator.prototype.getConfig = function() {
  return {
    agentTimeout: CONFIG.timeout,
    maxRetries: CONFIG.maxRetries,
    retryBaseDelay: CONFIG.baseDelay,
    maxAgents: CONFIG.maxAgents,
    concurrency: CONFIG.concurrency,
    maxRounds: CONFIG.maxRounds,
    webhookUrl: process.env.WEBHOOK_URL
      ? process.env.WEBHOOK_URL.replace(/^(https?:\/\/[^/]{4})[^/]*/, '$1***')
      : ''
  };
};

Orchestrator.prototype.updateConfig = function(patch) {
  const RULES = {
    agentTimeout:   { key: 'timeout',    min: 30000,  max: 1800000 },
    maxRetries:     { key: 'maxRetries',  min: 0,      max: 20 },
    retryBaseDelay: { key: 'baseDelay',   min: 1000,   max: 60000 },
    maxAgents:      { key: 'maxAgents',   min: 1,      max: 50 },
    concurrency:    { key: 'concurrency', min: 1,      max: 20 },
    maxRounds:      { key: 'maxRounds',   min: 1,      max: 20 },
  };

  const errors = [];
  for (const [field, val] of Object.entries(patch)) {
    if (field === 'webhookUrl') {
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
    CONFIG[rule.key] = Math.round(num);
  }
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
};

module.exports = Orchestrator;
