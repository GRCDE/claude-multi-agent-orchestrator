# Claude Multi-Agent Orchestrator v2

## Was ist das?
Ein Multi-Agent System das grosse Projekte automatisch in Teilaufgaben aufteilt.
Ein Koordinator-Agent plant, Sub-Agenten arbeiten die Aufgaben parallel ab und koennen
Rueckfragen an den Koordinator stellen. Nach Abschluss erstellt der Koordinator eine
Gesamtzusammenfassung. Alles laeuft ueber Claude Code CLI.

## Architektur

```
Browser (public/index.html)
    | SSE + REST (port 3131)
    v
Express Server (server.js)
    - Input-Validierung, CORS, XSS-Schutz, Path Traversal Schutz
    - Rate-Limiting (express-rate-limit)
    - SSE Broadcast mit Event-Batching
    - REST API (Start, Reset, Retry, Approve, Export, Templates, Projects, Files, Health)
    |
    v
Orchestrator (orchestrator.js) -- exportiert Klasse
    - Parallele Agent-Ausfuehrung (Semaphore, Concurrency=3)
    - AbortController fuer sauberen Reset
    - State Persistence (state.json pro Projekt)
    - Rate-Limit + Netzwerkfehler Erkennung + Exponential Backoff
    - Hook-System (hooks.js)
    - Plan-Approval Workflow (optional)
    - Koordinator-Zusammenfassung nach Abschluss
    |
    v
Claude Code CLI (`claude --dangerously-skip-permissions -p "..."`)
    |
    v
Dateisystem (projects/{id}/agent-{n}/)
    - task.md, transcript.md, conversation.jsonl pro Agent
    - shared-context.md (Inter-Agent Kontext)
    - state.json (Projekt-State)
    |
    v
Winston Logger (src/logger.js)
```

## Projektstruktur

```
Multiagents/
├── server.js            Express Server, SSE-Streaming, REST API, Security
├── orchestrator.js      Multi-Agent Logik (Klasse), parallele Ausfuehrung
├── src/
│   └── logger.js        Winston Logger Konfiguration
├── public/
│   └── index.html       GUI v2 (Vanilla JS, Incremental Rendering, Dark/Light Mode)
├── projects/            Agent-Outputs + state.json pro Projekt (auto-erstellt)
├── __tests__/
│   ├── unit/            Unit-Tests (Semaphore, Rate-Limit, JSON-Parsing, Hooks, etc.)
│   ├── integration/     Orchestrator-Integration-Tests
│   └── api/             Server/API-Tests (Export, Templates)
├── .env.example         Konfigurationsvorlage
├── hooks.example.js     Hook-System Beispieldatei
├── templates.json       Vordefinierte Projekt-Templates
├── jest.config.js       Jest Test-Konfiguration
├── package.json         Dependencies + Scripts
├── start.bat            Windows-Starter (mit Checks + Auto-Install)
├── ROADMAP.md           Feature-Roadmap mit Wettbewerbsvergleich
└── CLAUDE.md            Diese Datei
```

## Stack
- **Node.js >= 18** + Express (Server)
- **Claude Code CLI** (`claude -p "..."`) fuer alle KI-Aufrufe
- **SSE** (Server-Sent Events) fuer Live-Updates im Browser (mit Auto-Reconnect)
- **Vanilla JS** Frontend (kein Framework, kein Build-Step noetig)
- **Winston** fuer strukturiertes Logging
- **Jest** fuer Unit-, Integration- und API-Tests
- **Archiver** fuer ZIP-Export von Projekten
- **express-rate-limit** fuer API Rate-Limiting
- Konfiguration ueber **Environment-Variablen** (siehe `.env.example`)

## Starten
```bash
npm install        # einmalig
node server.js     # dann http://localhost:3131 oeffnen
```
Oder: `start.bat` doppelklicken (Windows)

Development-Modus mit Auto-Reload:
```bash
npm run dev
```

Tests ausfuehren:
```bash
npm test
npm run test:coverage
```

## Umgebungsvariablen

| Variable | Default | Beschreibung |
|---|---|---|
| `PORT` | `3131` | Server-Port |
| `NODE_ENV` | `development` | Umgebung |
| `AGENT_TIMEOUT` | `300000` | Timeout pro Agent in ms (5 Min) |
| `MAX_RETRIES` | `5` | Max Retries bei Rate-Limit/Netzwerkfehler |
| `RETRY_BASE_DELAY` | `5000` | Basis-Wartezeit fuer Exponential Backoff in ms |
| `MAX_AGENTS` | `10` | Maximale Anzahl Agenten pro Projekt |
| `AGENT_CONCURRENCY` | `3` | Gleichzeitig laufende Agenten |
| `LOG_LEVEL` | `info` | Winston Log-Level |

## Wie der Agent-Dialog funktioniert

1. Koordinator plant N Aufgaben (JSON via claude CLI)
2. Optional: Plan-Approval – Benutzer kann Plan genehmigen oder modifizieren
3. Agenten starten parallel (max 3 gleichzeitig, konfigurierbar via `AGENT_CONCURRENCY`)
4. Jeder Agent arbeitet in `projects/{id}/agent-{n}/`
5. Wenn Agent "FRAGE: ..." schreibt -> Koordinator wird gefragt (neuer claude-Aufruf)
6. Antwort wird in den Agent-Prompt der naechsten Runde injiziert
7. Agent schreibt "FERTIG" -> naechster wartender Agent bekommt Slot frei
8. Shared Context wird nach jedem fertigen Agent aktualisiert
9. State wird nach jedem Schritt in `projects/{id}/state.json` persistiert
10. Nach Abschluss aller Agenten: Koordinator erstellt Gesamtzusammenfassung

## API-Endpoints

### REST API
| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check (Status, Uptime, Memory) |
| GET | `/api/stream` | SSE Endpoint fuer Live-Updates |
| GET | `/api/status` | Aktueller Projekt-Status |
| GET | `/api/projects` | Liste aller bisherigen Projekte |
| GET | `/api/projects/:id` | Einzelnes Projekt mit State laden |
| GET | `/api/files/:id` | Dateibaum eines Projekts (rekursiv) |
| GET | `/api/templates` | Vordefinierte Projekt-Templates |
| GET | `/api/export/:id` | Projekt als ZIP herunterladen |
| POST | `/api/start` | Neues Projekt starten (mit optionalem `requireApproval`) |
| POST | `/api/reset` | Laufendes Projekt abbrechen (AbortController) |
| POST | `/api/retry/:agentIndex` | Einzelnen fehlgeschlagenen Agent neu starten |
| POST | `/api/approve` | Geplanten Plan genehmigen |
| POST | `/api/modify-plan` | Plan modifizieren und genehmigen |

### SSE Events
| Event | Beschreibung |
|---|---|
| `state` | Vollstaendiger Zustand (bei Verbindungsaufbau) |
| `phase` | Phase geaendert (running, awaiting_approval, complete, error) |
| `project_meta` | Projekt-Titel und Zusammenfassung (auch nach Koordinator-Summary) |
| `coordinator` | Koordinator-Status (planning, ready, thinking, summarizing, done) |
| `agent` | Agent-Status Update |
| `agent_stream` | Live-Output-Chunk von Agent |
| `agent_msg` | Agent-Nachricht (Arbeit, Frage, Antwort) |
| `agents_updated` | Agenten-Array aktualisiert (nach Plan-Modifikation) |
| `rate_limit` | Rate-Limit erkannt, Retry laeuft |
| `network_error` | Netzwerkfehler erkannt, Retry laeuft |

## Security

- **CORS**: Nur `localhost` und `127.0.0.1` erlaubt
- **Rate-Limiting**: API-Endpunkte (10/min), Projekt-Start (3/min)
- **Input-Validierung**: Projektbeschreibung wird sanitized (Laenge, Zeichensatz, Steuerzeichen)
- **XSS-Schutz**: HTML-Escaping in allen dynamischen Inhalten
- **Path Traversal**: Agent-Indizes und Projekt-IDs werden validiert, Pfade gegen PROJECTS_DIR geprueft
- **SSE Client Limit**: Max 50 gleichzeitige Verbindungen
- **Prompt Injection**: Input-Sanitierung gegen Steuerzeichen

## Features

- Parallele Agent-Ausfuehrung mit konfigurierbarem Concurrency-Limit
- Rate-Limit + Netzwerkfehler Erkennung mit Exponential Backoff
- Plan-Approval Workflow (optional, Benutzer kann Plan pruefen/aendern)
- Koordinator-Zusammenfassung nach Abschluss aller Agenten
- State Persistence (state.json, automatische Wiederherstellung)
- Shared Context zwischen Agenten (shared-context.md)
- Agent-Rollen mit Personas (Role/Expertise im Prompt)
- Hook-System (beforePlan, afterPlan, beforeAgent, afterAgent, onComplete, onError)
- Projekt-Templates (templates.json)
- ZIP-Export von Projekten
- Live-Dateibaum im GUI
- Projekt-Historie mit Lade-Funktion
- Dark/Light Mode Toggle
- Mobile Responsive Layout
- SSE Auto-Reconnect mit Exponential Backoff
- SSE Event-Batching (100ms Intervall)
- Graceful Shutdown
- Strukturiertes Logging mit Winston

## Wichtige Stellen im Code

### orchestrator.js (exportiert Klasse `Orchestrator`)
- `runClaude(prompt, workDir, emitter, activeProcesses, signal)` – startet claude CLI mit Rate-Limit/Netzwerk Retry + konfigurierbarem Timeout
- `checkClaudeCli()` – prueft ob claude CLI verfuegbar ist
- `start(description, agentCount, requireApproval)` – Haupteinstieg: plant, optional Approval, startet Agenten parallel, erstellt Zusammenfassung
- `_coordinatorPlan(agentCount)` – Koordinator erstellt Aufgaben-JSON mit Rollen
- `_coordinatorSummary()` – Koordinator erstellt Abschluss-Zusammenfassung (nicht-kritisch, try/catch)
- `_runAgent(idx)` – Haupt-Loop pro Agent: Arbeit -> Frage? -> Koordinator -> weiter
- `_coordinatorAnswer(question, agentIdx)` – Koordinator beantwortet Agenten-Frage (mit Kontext bisheriger Fragen)
- `retryAgent(idx)` – Einzelnen Agent erneut starten
- `abort()` / `reset()` – Sauberer Abbruch via AbortController
- `approvePlan()` / `modifyPlan(tasks)` – Plan-Approval Workflow
- `getState()` – Aktuellen Zustand serialisieren (fuer Persistence + SSE)
- `_saveState()` – State in `projects/{id}/state.json` schreiben (async)
- `_readSharedContext()` / `_writeSharedContext(idx)` – Inter-Agent Kontext
- `_runHook(name, data)` – Hook-System Ausfuehrung (fehlertolerant)
- Semaphore-Klasse fuer parallele Ausfuehrung (max `AGENT_CONCURRENCY` gleichzeitig)
- `validatePlan()`, `sanitizeInput()`, `sanitizeError()`, `validateWorkDir()` – Sicherheits-Hilfsfunktionen

### server.js
- Rate-Limiting mit `express-rate-limit` (API: 10/min, Start: 3/min)
- SSE Event-Batching (`queueBroadcast`, `flushBatch`, 100ms Intervall)
- GET `/health` – Health-Check Endpoint (mit Memory-Info)
- GET `/api/stream` – SSE Endpoint mit Client-Limit + Heartbeat
- GET `/api/status` – Aktueller Status
- GET `/api/projects` – Projekt-Liste aus projects/ Verzeichnis
- GET `/api/projects/:id` – Einzelnes Projekt laden (state.json)
- GET `/api/files/:id` – Rekursiver Dateibaum (mit Path Traversal Schutz)
- GET `/api/templates` – Templates aus templates.json laden
- GET `/api/export/:id` – ZIP-Export via archiver
- POST `/api/start` – Neues Projekt starten (Input-Validierung, Race-Condition Schutz)
- POST `/api/reset` – Projekt abbrechen (AbortController)
- POST `/api/retry/:agentIndex` – Agent neu starten
- POST `/api/approve` – Plan genehmigen
- POST `/api/modify-plan` – Plan modifizieren und genehmigen
- Graceful Shutdown (SIGTERM/SIGINT)

### src/logger.js
- Winston Logger Konfiguration
- Konfigurierbar via `LOG_LEVEL` Umgebungsvariable

### public/index.html
- `connect()` – SSE-Verbindung mit Auto-Reconnect (exponential backoff)
- `render()` / `updateAgent()` – Incremental Rendering (kein volles innerHTML-Ersetzen)
- `startProject()` – POST an /api/start
- `loadProjects()` – Projekt-Historie laden und anzeigen
- `loadFiles()` – Dateibaum eines Projekts laden
- `toggleTheme()` – Dark/Light Mode umschalten (localStorage)

## Konventionen
- Deutsch als Sprache fuer alle Prompts und UI-Texte
- Alle claude-Aufrufe gehen durch `runClaude()` in orchestrator.js
- SSE-Events immer ueber `orchestrator.emit('update', { event, data })` senden
- Agent-Dateien immer in `projects/{projectId}/agent-{n}/` schreiben
- Orchestrator exportiert eine Klasse, Server instanziiert mit `new Orchestrator()`
- Konfiguration ueber Environment-Variablen (siehe `.env.example`)
- Async File I/O bevorzugen (`fs.promises` / `fs/promises`)
- Tests in `__tests__/` Verzeichnis, ausfuehrbar mit `npm test`
- Hooks in optionaler `hooks.js` Datei (siehe `hooks.example.js`)
- Fehler in Hooks und nicht-kritischen Schritten duerfen den Hauptprozess nie crashen
