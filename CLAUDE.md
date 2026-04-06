# Claude Multi-Agent Orchestrator v2

## Was ist das?
Ein Multi-Agent System das grosse Projekte automatisch in Teilaufgaben aufteilt.
Ein Koordinator-Agent plant, Sub-Agenten arbeiten die Aufgaben parallel ab und koennen
Rueckfragen an den Koordinator stellen. Alles laeuft ueber Claude Code CLI.

## Architektur

```
Browser (public/index.html)
    | SSE + REST (port 3131)
    v
Express Server (server.js)
    - Input-Validierung, CORS, XSS-Schutz, Path Traversal Schutz
    - SSE Broadcast an alle Clients
    - REST API (Start, Reset, Retry, Projects, Files, Health)
    |
    v
Orchestrator (orchestrator.js) -- exportiert Klasse
    - Parallele Agent-Ausfuehrung (Semaphore, Concurrency=3)
    - AbortController fuer sauberen Reset
    - State Persistence (state.json pro Projekt)
    - Rate-Limit Erkennung + Exponential Backoff
    |
    v
Claude Code CLI (`claude --dangerously-skip-permissions -p "..."`)
    |
    v
Dateisystem (projects/{id}/agent-{n}/)
```

## Projektstruktur

```
Multiagents/
├── server.js            Express Server, SSE-Streaming, REST API, Security
├── orchestrator.js      Multi-Agent Logik (Klasse), parallele Ausfuehrung
├── public/
│   └── index.html       GUI v2 (Vanilla JS, Incremental Rendering, Dark/Light Mode)
├── projects/            Agent-Outputs + state.json pro Projekt (auto-erstellt)
├── __tests__/           Jest Tests
├── .env.example         Konfigurationsvorlage
├── package.json         Dependencies + Scripts (jest, dev, coverage)
├── start.bat            Windows-Starter (mit Checks + Auto-Install)
├── ROADMAP.md           Feature-Roadmap mit Wettbewerbsvergleich
└── CLAUDE.md            Diese Datei
```

## Stack
- Node.js >= 18 + Express (Server)
- Claude Code CLI (`claude -p "..."`) fuer alle KI-Aufrufe
- SSE (Server-Sent Events) fuer Live-Updates im Browser (mit Auto-Reconnect)
- Vanilla JS Frontend (kein Framework, kein Build-Step noetig)
- Jest fuer Tests
- Konfiguration ueber Environment-Variablen (siehe `.env.example`)

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

## Wie der Agent-Dialog funktioniert

1. Koordinator plant N Aufgaben (JSON via claude CLI)
2. Agenten starten parallel (max 3 gleichzeitig, konfigurierbar via `AGENT_CONCURRENCY`)
3. Jeder Agent arbeitet in `projects/{id}/agent-{n}/`
4. Wenn Agent "FRAGE: ..." schreibt -> Koordinator wird gefragt (neuer claude-Aufruf)
5. Antwort wird in den Agent-Prompt der naechsten Runde injiziert
6. Agent schreibt "FERTIG" -> naechster wartender Agent bekommt Slot frei
7. State wird nach jedem Schritt in `projects/{id}/state.json` persistiert

## API-Endpoints

### Server
| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check (Status, Uptime) |
| GET | `/api/stream` | SSE Endpoint fuer Live-Updates |
| GET | `/api/projects` | Liste aller bisherigen Projekte |
| GET | `/api/projects/:id` | Einzelnes Projekt mit State laden |
| GET | `/api/files/:id` | Dateibaum eines Projekts (rekursiv) |
| POST | `/api/start` | Neues Projekt starten |
| POST | `/api/reset` | Laufendes Projekt abbrechen (AbortController) |
| POST | `/api/retry/:agentIndex` | Einzelnen fehlgeschlagenen Agent neu starten |

### SSE Events
| Event | Beschreibung |
|---|---|
| `project_start` | Neues Projekt gestartet |
| `planning` | Koordinator plant Aufgaben |
| `agent_start` | Agent N gestartet |
| `agent_stream` | Live-Output-Chunk von Agent |
| `agent_done` | Agent N fertig |
| `agent_error` | Agent N fehlgeschlagen |
| `question` | Agent stellt Rueckfrage |
| `answer` | Koordinator beantwortet Frage |
| `rate_limit` | Rate-Limit erkannt, Retry laeuft |
| `done` | Projekt abgeschlossen |
| `error` | Projekt-Fehler |

## Security

- **CORS**: Nur `localhost` und `127.0.0.1` erlaubt
- **Input-Validierung**: Projektbeschreibung wird sanitized (Laenge, Zeichensatz)
- **XSS-Schutz**: HTML-Escaping in allen dynamischen Inhalten
- **Path Traversal**: Agent-Indizes und Projekt-IDs werden validiert
- **SSE Client Limit**: Max 50 gleichzeitige Verbindungen

## Offene Aufgaben / Status

### Prioritaet 1 -- Stabilitaet (ERLEDIGT)
- [x] Rate-Limit Erkennung (HTTP 529 / "overloaded")
      -> Exponential Backoff (5s, 10s, 20s, 40s, 80s), max 5 Retries, SSE-Event `rate_limit`
- [x] Timeout pro Agent konfigurierbar (default 300s, via `AGENT_TIMEOUT`)
- [x] Fehlerbehandlung wenn claude CLI nicht installiert -> `checkClaudeCli()` vor Projektstart

### Prioritaet 2 -- Features (TEILWEISE ERLEDIGT)
- [x] Agenten parallel ausfuehren (Semaphore mit Concurrency-Limit)
- [x] Live-Dateibaum im GUI (GET /api/files/:id)
- [x] Projekt-Historie im GUI (GET /api/projects)
- [x] State Persistence (state.json)
- [x] Error Recovery pro Agent (POST /api/retry/:agentIndex)
- [ ] Meilenstein-Modus: vordefinierte Templates laden statt freie Eingabe
- [ ] Agent-Output als ZIP exportieren (Button im GUI)

### Prioritaet 3 -- UX (TEILWEISE ERLEDIGT)
- [x] Dark/Light Mode Toggle
- [x] Mobile Responsive Layout
- [x] SSE Auto-Reconnect
- [ ] Agent-Output Vollansicht: Klick auf Agent-Karte oeffnet kompletten Transcript

### Phase 2 -- Differenzierung (aus ROADMAP.md)
- [ ] Claude Native Subagent-Integration (`claude --subagent`)
- [ ] Inter-Agent Communication (Shared Context File)
- [ ] Agent-Rollen mit Personas (Role/Expertise im Prompt)
- [ ] Human-in-the-Loop (Approval-Gates, manuell eingreifen)
- [ ] Token/Cost-Tracking pro Agent

### Phase 3 -- Production-Ready (aus ROADMAP.md)
- [ ] Sandbox/Isolation (Docker-Container pro Agent)
- [ ] Authentifizierung + Multi-User
- [ ] Webhook/CI-Integration (GitHub Actions, Callback-URLs)
- [ ] Plugin-System (Hooks: beforePlan, afterAgent, onComplete)
- [ ] Observability + Structured Logging (Winston/Pino, OpenTelemetry)
- [ ] Projekt-Templates / Meilenstein-Modus

## Wichtige Stellen im Code

### orchestrator.js (exportiert Klasse `Orchestrator`)
- `runClaude(prompt, workDir, emitter)` -- startet claude CLI mit Rate-Limit Retry + konfigurierbarem Timeout
- `checkClaudeCli()` -- prueft ob claude CLI verfuegbar ist
- `start(description)` -- Haupteinstieg: plant + startet Agenten parallel
- `_coordinatorPlan()` -- Koordinator erstellt Aufgaben-JSON
- `_runAgent(idx)` -- Haupt-Loop pro Agent: Arbeit -> Frage? -> Koordinator -> weiter
- `_coordinatorAnswer()` -- Koordinator beantwortet Agenten-Frage
- `retryAgent(idx)` -- Einzelnen Agent erneut starten
- `abort()` -- Sauberer Abbruch via AbortController
- `getState()` -- Aktuellen Zustand serialisieren (fuer Persistence + SSE)
- `_saveState()` -- State in `projects/{id}/state.json` schreiben (async)
- Semaphore-Logik fuer parallele Ausfuehrung (max `AGENT_CONCURRENCY` gleichzeitig)

### server.js
- GET `/health` -- Health-Check Endpoint
- GET `/api/stream` -- SSE Endpoint mit Client-Limit
- GET `/api/projects` -- Projekt-Liste aus projects/ Verzeichnis
- GET `/api/projects/:id` -- Einzelnes Projekt laden (state.json)
- GET `/api/files/:id` -- Rekursiver Dateibaum (mit Path Traversal Schutz)
- POST `/api/start` -- Neues Projekt starten (Input-Validierung)
- POST `/api/reset` -- Projekt abbrechen (AbortController)
- POST `/api/retry/:agentIndex` -- Agent neu starten

### public/index.html
- `connect()` -- SSE-Verbindung mit Auto-Reconnect (exponential backoff)
- `render()` / `updateAgent()` -- Incremental Rendering (kein volles innerHTML-Ersetzen)
- `startProject()` -- POST an /api/start
- `loadProjects()` -- Projekt-Historie laden und anzeigen
- `loadFiles()` -- Dateibaum eines Projekts laden
- `toggleTheme()` -- Dark/Light Mode umschalten (localStorage)

## Konventionen
- Deutsch als Sprache fuer alle Prompts und UI-Texte
- Alle claude-Aufrufe gehen durch `runClaude()` in orchestrator.js
- SSE-Events immer ueber `orchestrator.emit('update', { event, data })` senden
- Agent-Dateien immer in `projects/{projectId}/agent-{n}/` schreiben
- Orchestrator exportiert eine Klasse, Server instanziiert mit `new Orchestrator()`
- Konfiguration ueber Environment-Variablen (siehe `.env.example`)
- Async File I/O bevorzugen (`fs.promises` / `fs/promises`)
- Tests in `__tests__/` Verzeichnis, ausfuehrbar mit `npm test`
