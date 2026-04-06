# Claude Multi-Agent Orchestrator

## Was ist das?
Ein Multi-Agent System das große Projekte automatisch in Teilaufgaben aufteilt.
Ein Koordinator-Agent plant, Sub-Agenten arbeiten die Aufgaben ab und können
Rückfragen an den Koordinator stellen. Alles läuft über Claude Code CLI.

## Architektur

```
Browser (public/index.html)
    ↕ SSE + REST (port 3131)
Express Server (server.js)
    ↕ child_process spawn
Orchestrator (orchestrator.js)
    ↕ claude --dangerously-skip-permissions -p "..."
Claude Code CLI
    ↕
Dateisystem (projects/)
```

## Projektstruktur

```
Multiagents/
├── server.js          Express Server, SSE-Streaming, REST API
├── orchestrator.js    Multi-Agent Logik, ruft claude CLI auf
├── public/
│   └── index.html     GUI (Vanilla JS + SSE, kein Build-Step)
├── projects/          Agent-Outputs landen hier (auto-erstellt)
├── package.json
├── start.bat          Windows-Starter
└── CLAUDE.md          Diese Datei
```

## Stack
- Node.js + Express (Server)
- Claude Code CLI (`claude -p "..."`) für alle KI-Aufrufe
- SSE (Server-Sent Events) für Live-Updates im Browser
- Vanilla JS Frontend (kein Framework, kein Build-Step nötig)

## Starten
```bash
npm install        # einmalig
node server.js     # dann http://localhost:3131 öffnen
```
Oder: `start.bat` doppelklicken (Windows)

## Wie der Agent-Dialog funktioniert

1. Koordinator plant N Aufgaben (JSON via claude CLI)
2. Jeder Agent bekommt seine Aufgabe + arbeitet in `projects/{id}/agent-{n}/`
3. Wenn Agent "FRAGE: ..." schreibt → Koordinator wird gefragt (neuer claude-Aufruf)
4. Antwort wird in den Agent-Prompt der nächsten Runde injiziert
5. Agent schreibt "FERTIG" → nächster Agent startet

## Offene Aufgaben / Was als nächstes verbessert werden soll

### Priorität 1 – Stabilität ✓
- [x] Rate-Limit Erkennung in orchestrator.js (HTTP 529 / "overloaded")
      → exponential backoff (5s, 10s, 20s, 40s, 80s), max 5 Retries, SSE-Event `rate_limit`
- [x] Timeout pro Agent konfigurierbar (default 300s, via `AGENT_TIMEOUT` Env-Variable)
- [x] Fehlerbehandlung wenn claude CLI nicht installiert → `checkClaudeCli()` vor Projektstart

### Priorität 2 – Features
- [ ] Agenten parallel ausführen statt sequenziell
      (Promise.allSettled, aber Rate-Limit beachten)
- [ ] Live-Dateibaum im GUI: zeige welche Dateien jeder Agent erstellt hat
      (GET /api/files/:projectId → fs.readdirSync rekursiv)
- [ ] Meilenstein-Modus: vordefinierte milestones.json laden statt freie Eingabe
- [ ] Agent-Output als ZIP exportieren (Button im GUI)

### Priorität 3 – UX
- [ ] Projekt-Historie: alle bisherigen projects/ im GUI auflisten
- [ ] Agent-Output Vollansicht: Klick auf Agent-Karte öffnet kompletten Transcript
- [ ] Dark/Light Mode Toggle

## Wichtige Stellen im Code

### orchestrator.js
- `runClaude(prompt, workDir, emitter)` – startet claude CLI mit Rate-Limit Retry + konfigurierbarem Timeout
- `_coordinatorPlan()` – Koordinator erstellt Aufgaben-JSON
- `_runAgent(idx)` – Haupt-Loop: Arbeit → Frage? → Koordinator → weiter
- `_coordinatorAnswer()` – Koordinator beantwortet Agenten-Frage

### server.js
- GET `/api/stream` – SSE endpoint, Browser hört hier live zu
- POST `/api/start` – startet neues Projekt
- POST `/api/reset` – setzt alles zurück

### public/index.html
- `connect()` – baut SSE-Verbindung auf, verarbeitet Events
- `render()` – rendert komplettes UI (kein Virtual DOM, einfaches innerHTML)
- `startProject()` – POST an /api/start

## Konventionen
- Deutsch als Sprache für alle Prompts und UI-Texte
- Alle claude-Aufrufe gehen durch `runClaude()` in orchestrator.js
- SSE-Events immer über `orchestrator.emit(eventName, data)` senden
- Agent-Dateien immer in `projects/{projectId}/agent-{n}/` schreiben
