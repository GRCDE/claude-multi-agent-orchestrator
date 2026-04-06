'use strict';
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
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

// ── JSON-Validierung für Koordinator-Plan ─────────────────────
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

  // ── Start project ─────────────────────────────────────────
  async start(desc, agentCount) {
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
      status: 'waiting', conversation: [], rounds: 0, questions: 0,
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

    // Schritt 2: Agenten parallel ausführen (mit Semaphore)
    this._checkAborted();
    const semaphore = new Semaphore(CONFIG.concurrency);
    const agentPromises = this.tasks.map((_, i) => (async () => {
      await semaphore.acquire();
      try {
        this._checkAborted();
        await this._runHook('beforeAgent', { index: i, task: this.tasks[i], role: this.tasks[i].role || '' });
        await this._runAgent(i);
        // afterAgent: Dateien im Agent-Verzeichnis auflesen
        let agentFiles = [];
        try { agentFiles = fs.readdirSync(this.agents[i].workDir).filter(f => f !== 'conversation.jsonl'); } catch {}
        await this._runHook('afterAgent', { index: i, status: this.agents[i].status, duration: this.agents[i].duration, files: agentFiles });
      } catch (e) {
        if (!this._abortController.signal.aborted) {
          logger.error('Agent-Fehler', { agent: i + 1, error: e.message });
          this._patchAgent(i, { status: 'error' });
          this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${sanitizeError(e.message)}`, type: 'work' });
          await this._runHook('onError', { phase: `agent-${i + 1}`, error: e });
        }
      } finally {
        semaphore.release();
      }
    })());

    await Promise.allSettled(agentPromises);

    if (this._abortController.signal.aborted) return;

    this.phase = 'complete';
    this.completedAt = Date.now();
    this.totalDuration = Math.round((this.completedAt - (this.startedAt || this.completedAt)) / 1000);
    logger.info('Projekt abgeschlossen', { projectId: this.projectId, agents: this.tasks.length, totalDuration: this.totalDuration });
    this.emit('phase', { phase: 'complete', totalDuration: this.totalDuration });
    await this._runHook('onComplete', { projectId: this.projectId, totalDuration: this.totalDuration, agents: this.agents });
    await this._saveState();
  }

  // ── Koordinator: Aufgaben planen ────────────────────────────
  async _coordinatorPlan(agentCount) {
    const prompt =
`Du bist Projekt-Koordinator. Analysiere das Projekt und erstelle genau ${agentCount} parallele, unabhängige Teilaufgaben.

Constraints:
- Jede Aufgabe MUSS unabhängig von den anderen sein (keine Abhängigkeiten!)
- Jede Task-Beschreibung soll 100-500 Zeichen lang sein
- Keine Überlappung zwischen den Aufgaben
- Jede Aufgabe soll verschiedene Fähigkeiten/Bereiche abdecken

Antworte NUR mit validem JSON (kein Markdown, kein Text davor/danach):
{"project_title":"string","summary":"1-2 Sätze auf Deutsch","quality_notes":"Kurze Begründung warum die Aufgaben unabhängig sind","tasks":[{"title":"Kurztitel","task":"Detaillierte Aufgabe","deliverable":"Was der Agent liefern soll","role":"Passende Rolle, z.B. Backend-Entwickler, Frontend-Entwickler, DevOps-Ingenieur, etc."}]}

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
      this._patchAgent(i, { title: task.title, task: task.task, deliverable: task.deliverable, role: task.role || '', workDir: agentDir });
    }

    // Projekt-Übersicht speichern
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
    this._patchAgent(idx, { status: 'working', startTime: Date.now() });
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
      this._patchAgent(idx, { rounds: round + 1 });

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
          const agentEndTime = Date.now();
          const agentDuration = Math.round((agentEndTime - (this.agents[idx].startTime || agentEndTime)) / 1000);
          this._patchAgent(idx, { status: 'done', endTime: agentEndTime, duration: agentDuration });
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
    this._patchAgent(idx, { status: 'done', endTime: agentEndTime2, duration: agentDuration2 });
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

  // ── Einzelnen Agenten neu starten ───────────────────────────
  async retryAgent(idx) {
    if (idx < 0 || idx >= this.tasks.length) throw new Error('Ungültiger Agent-Index');
    this.agents[idx].conversation = [];
    this.agents[idx].rounds = 0;
    this.agents[idx].questions = 0;
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

module.exports = Orchestrator;
