'use strict';
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const MAX_ROUNDS = 5;
const PROJECTS_DIR = path.join(__dirname, 'projects');

// ── Konfiguration ─────────────────────────────────────────────
const CONFIG = {
  timeout: parseInt(process.env.AGENT_TIMEOUT) || 300000,       // 5 Min default (vorher 120s)
  maxRetries: parseInt(process.env.MAX_RETRIES) || 5,           // Max Retries bei Rate-Limit
  baseDelay: parseInt(process.env.RETRY_BASE_DELAY) || 5000,    // Start-Wartezeit 5s
};

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

// ── Claude CLI Verfügbarkeit prüfen ───────────────────────────
function checkClaudeCli() {
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe', shell: true, timeout: 10000 });
    return { ok: true };
  } catch (e) {
    if (e.message.includes('ENOENT') || e.message.includes('not found') || e.message.includes('not recognized') || e.status === 127) {
      return {
        ok: false,
        error: `Claude CLI nicht gefunden. Bitte installiere Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code\n\nStelle sicher, dass "claude" im PATH verfügbar ist.`
      };
    }
    // CLI existiert, anderer Fehler – wir lassen es durchgehen
    return { ok: true };
  }
}

// ── Run claude CLI (mit Rate-Limit Retry + konfigurierbarem Timeout) ──
function runClaude(prompt, workDir, emitter) {
  return _runClaudeWithRetry(prompt, workDir, emitter, 0);
}

function _runClaudeWithRetry(prompt, workDir, emitter, attempt) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const args = ['--dangerously-skip-permissions', '-p', prompt];
    const opts = {
      cwd: workDir || __dirname,
      shell: true,
      env: { ...process.env }
    };

    const proc = isWin
      ? spawn('claude.cmd', args, opts)
      : spawn('claude', args, opts);

    let out = '';
    let err = '';
    let killed = false;

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });

    proc.on('error', e => {
      if (e.code === 'ENOENT') {
        reject(new Error('Claude CLI nicht gefunden. Bitte installiere Claude Code CLI und stelle sicher, dass "claude" im PATH liegt.'));
      } else {
        reject(e);
      }
    });

    proc.on('close', code => {
      if (killed) return; // Timeout hat bereits rejected

      const combined = (out + ' ' + err).trim();

      // Rate-Limit Erkennung
      if (isRateLimited(combined) && attempt < CONFIG.maxRetries) {
        const delay = CONFIG.baseDelay * Math.pow(2, attempt); // Exponential backoff
        if (emitter) {
          emitter.emit('rate_limit', {
            attempt: attempt + 1,
            maxRetries: CONFIG.maxRetries,
            waitMs: delay,
            message: `Rate-Limit erkannt, warte ${Math.round(delay / 1000)}s (Versuch ${attempt + 1}/${CONFIG.maxRetries})…`
          });
        }
        setTimeout(() => {
          _runClaudeWithRetry(prompt, workDir, emitter, attempt + 1)
            .then(resolve)
            .catch(reject);
        }, delay);
        return;
      }

      if (isRateLimited(combined) && attempt >= CONFIG.maxRetries) {
        reject(new Error(`Rate-Limit nach ${CONFIG.maxRetries} Versuchen nicht aufgelöst. Bitte warte einige Minuten und versuche es erneut.`));
        return;
      }

      if (out.trim()) resolve(out.trim());
      else if (err.trim()) resolve(err.trim());
      else reject(new Error(`claude exited with code ${code}`));
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
      reject(new Error(`Timeout nach ${Math.round(CONFIG.timeout / 1000)}s – der Agent hat zu lange gebraucht. Timeout konfigurierbar via AGENT_TIMEOUT Umgebungsvariable.`));
    }, CONFIG.timeout);

    // Timer aufräumen wenn Prozess normal endet
    proc.on('close', () => clearTimeout(timer));
  });
}

// ── Orchestrator ─────────────────────────────────────────────
class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
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
      agents: this.agents
    };
  }

  // ── Start project ─────────────────────────────────────────
  async start(desc, agentCount) {
    this.reset();

    // CLI-Check bevor wir starten
    const cliCheck = checkClaudeCli();
    if (!cliCheck.ok) {
      this.phase = 'error';
      this.emit('phase', { phase: 'error', error: cliCheck.error });
      this.emit('error', { message: cliCheck.error });
      return;
    }

    this.projectDesc = desc;
    this.projectId = `proj_${Date.now()}`;
    this.projectDir = path.join(PROJECTS_DIR, this.projectId);
    fs.mkdirSync(this.projectDir, { recursive: true });
    this.phase = 'running';
    this.coordStatus = 'planning';
    this.agents = Array.from({ length: agentCount }, (_, i) => ({
      id: i, title: 'Wird geplant…', task: '', deliverable: '',
      status: 'waiting', conversation: [], rounds: 0, questions: 0,
      workDir: path.join(this.projectDir, `agent-${i + 1}`)
    }));
    this.emit('phase', { phase: 'running' });
    this.emit('coordinator', this._coordState());

    // Step 1: Coordinator plans
    try {
      await this._coordinatorPlan(agentCount);
    } catch (e) {
      this.coordStatus = 'error';
      this.emit('coordinator', { ...this._coordState(), error: e.message });
      this.phase = 'error';
      this.emit('phase', { phase: 'error' });
      return;
    }

    // Step 2: Run agents sequentially
    for (let i = 0; i < this.tasks.length; i++) {
      try {
        await this._runAgent(i);
      } catch (e) {
        this._patchAgent(i, { status: 'error' });
        this._addAgentMsg(i, { from: 'agent', text: `Fehler: ${e.message}`, type: 'work' });
      }
    }

    this.phase = 'complete';
    this.emit('phase', { phase: 'complete' });
  }

  // ── Coordinator: plan tasks ───────────────────────────────
  async _coordinatorPlan(agentCount) {
    const prompt =
`Du bist Projekt-Koordinator. Analysiere das Projekt und erstelle genau ${agentCount} parallele, unabhängige Teilaufgaben.

Antworte NUR mit validem JSON (kein Markdown, kein Text davor/danach):
{"project_title":"string","summary":"1-2 Sätze auf Deutsch","tasks":[{"title":"Kurztitel","task":"Detaillierte Aufgabe","deliverable":"Was der Agent liefern soll"}]}

Projekt: ${this.projectDesc}`;

    const raw = await runClaude(prompt, this.projectDir, this);
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
    } catch {
      // Try to extract JSON from output
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error(`Koordinator-Ausgabe kein JSON: ${raw.slice(0, 200)}`);
    }

    this.projectTitle = parsed.project_title || 'Projekt';
    this.projectSummary = parsed.summary || '';
    this.tasks = (parsed.tasks || []).slice(0, agentCount);
    this.coordStatus = 'ready';

    // Create agent work dirs and save task files
    this.tasks.forEach((task, i) => {
      const agentDir = path.join(this.projectDir, `agent-${i + 1}`);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'task.md'),
        `# Agent ${i + 1}: ${task.title}\n\n## Aufgabe\n${task.task}\n\n## Lieferergebnis\n${task.deliverable}\n`);
      this._patchAgent(i, { title: task.title, task: task.task, deliverable: task.deliverable, workDir: agentDir });
    });

    // Save project overview
    fs.writeFileSync(path.join(this.projectDir, 'project.md'),
      `# ${this.projectTitle}\n\n${this.projectSummary}\n\n## Agenten\n${this.tasks.map((t, i) => `- Agent ${i + 1}: ${t.title}`).join('\n')}\n`);

    this.emit('coordinator', this._coordState());
    this.emit('project_meta', { title: this.projectTitle, summary: this.projectSummary, dir: this.projectDir });
  }

  // ── Run one agent (with Q&A loop) ─────────────────────────
  async _runAgent(idx) {
    const task = this.tasks[idx];
    const agentDir = this.agents[idx].workDir;
    const agentNum = idx + 1;

    this._patchAgent(idx, { status: 'working' });

    // Build history for multi-turn (injected into prompt)
    let historyText = '';

    const agentSystemPrompt =
`Du bist Agent ${agentNum} im Projekt "${this.projectTitle}".
Du arbeitest in deinem Verzeichnis: ${agentDir}

Deine Aufgabe: ${task.task}
Dein Lieferergebnis: ${task.deliverable}

Regeln:
1. Arbeite konkret und erstelle echte Dateien in deinem Verzeichnis
2. Wenn du eine Klärung vom Koordinator brauchst: schreibe "FRAGE: [deine genaue Frage]" und höre danach auf
3. Maximal 2 Fragen erlaubt – nutze sie sinnvoll
4. Wenn du fertig bist: schreibe am Ende "FERTIG"`;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      this._patchAgent(idx, { rounds: round + 1 });

      const fullPrompt = historyText
        ? `${agentSystemPrompt}\n\n## Bisheriger Verlauf:\n${historyText}\n\n## Nächster Schritt:\nFahre fort.`
        : `${agentSystemPrompt}\n\nStarte jetzt deine Aufgabe.`;

      const response = await runClaude(fullPrompt, agentDir, this);

      const qMatch = response.match(/FRAGE:\s*(.+?)(?:\n|$)/i);
      const isDone = /FERTIG/i.test(response);

      if (qMatch && !isDone) {
        const question = qMatch[1].trim();
        const beforeQ = response.split(/FRAGE:/i)[0].trim();

        if (beforeQ) {
          this._addAgentMsg(idx, { from: 'agent', text: beforeQ, type: 'work' });
          historyText += `\nAgent (Runde ${round + 1}):\n${beforeQ}\n`;
        }
        this._addAgentMsg(idx, { from: 'agent', text: question, type: 'question' });
        this._patchAgent(idx, { status: 'asking', questions: this.agents[idx].questions + 1 });

        // Coordinator answers
        const answer = await this._coordinatorAnswer(question, idx);
        this._addAgentMsg(idx, { from: 'coordinator', text: answer, type: 'answer' });
        this._patchAgent(idx, { status: 'working' });

        historyText += `\nAgent fragt: ${question}\nKoordinator antwortet: ${answer}\n`;

      } else {
        this._addAgentMsg(idx, { from: 'agent', text: response, type: isDone ? 'final' : 'work' });
        historyText += `\nAgent (Runde ${round + 1}):\n${response}\n`;

        if (isDone || round >= MAX_ROUNDS - 1) {
          this._patchAgent(idx, { status: 'done' });
          // Save transcript
          fs.writeFileSync(path.join(agentDir, 'transcript.md'),
            `# Agent ${agentNum} Verlauf\n\n${historyText}`);
          return;
        }
      }
    }
    this._patchAgent(idx, { status: 'done' });
  }

  // ── Coordinator answers agent question ───────────────────
  async _coordinatorAnswer(question, agentIdx) {
    this.coordStatus = 'thinking';
    this.coordActiveQ = { agentIndex: agentIdx, question };
    this.emit('coordinator', this._coordState());

    const taskSummary = this.tasks.map((t, i) => `Agent ${i + 1}: ${t.title} – ${t.task}`).join('\n');
    const prompt =
`Du bist Projekt-Koordinator. Beantworte die Frage des Agenten kurz und präzise auf Deutsch.

Projektbeschreibung: ${this.projectDesc}

Alle Agenten-Aufgaben:
${taskSummary}

Agent ${agentIdx + 1} fragt: ${question}

Antworte direkt und konkret.`;

    const answer = await runClaude(prompt, this.projectDir, this);

    this.coordLog.push({ agentIndex: agentIdx, question, answer });
    this.coordStatus = 'ready';
    this.coordActiveQ = null;
    this.emit('coordinator', this._coordState());
    return answer;
  }

  // ── Helpers ───────────────────────────────────────────────
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

  _addAgentMsg(i, msg) {
    this.agents[i].conversation.push(msg);
    this.emit('agent_msg', { index: i, msg });
  }
}

module.exports = new Orchestrator();
