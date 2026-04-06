# Claude Multi-Agent Orchestrator v2

## Was ist das?
Ein Multi-Agent System das grosse Projekte automatisch in Teilaufgaben aufteilt.
Koordinator-Agent plant, Sub-Agenten arbeiten parallel ab, koennen Rueckfragen
stellen, und nach Abschluss erstellt der Koordinator eine Gesamtzusammenfassung.
Agenten-Outputs werden automatisch zusammengefuehrt.

## Architektur

```
Browser (public/index.html)
    | SSE + REST (port 3131)
    v
Express Server (server.js)
    - CORS, Rate-Limiting, Input-Validierung, Path-Traversal-Schutz
    - SSE Broadcast mit Event-Batching (100ms)
    - REST API (22 Endpoints)
    v
Orchestrator (orchestrator.js) -- EventEmitter-Klasse
    - Parallele Agent-Ausfuehrung (Semaphore, AGENT_CONCURRENCY)
    - Dependency Graph (depends_on, Zyklen-Erkennung)
    - Auto-Retry bei Agent-Fehler (1x automatisch, 10s Wartezeit)
    - Rate-Limit/Netzwerkfehler-Erkennung + Exponential Backoff
    - Webhook-Benachrichtigungen (HTTP/HTTPS POST)
    - Hook-System (hooks.js), Plan-Approval, State Persistence
    - Merged Output (projects/{id}/merged/)
    v
Claude Code CLI (`claude --dangerously-skip-permissions -p "..."`)
    v
Dateisystem (projects/{id}/agent-{n}/)
    - task.md, transcript.md, conversation.jsonl pro Agent
    - shared-context.md, state.json, project.md, merged/
```

## Projektstruktur

```
Multiagents/
├── server.js            Express Server, SSE, REST API, Security
├── orchestrator.js      Orchestrator-Klasse, parallele Ausfuehrung
├── src/
│   └── logger.js        Winston Logger
├── public/
│   └── index.html       GUI (Vanilla JS, Dark/Light, Responsive)
├── projects/            Agent-Outputs + state.json (auto-erstellt)
├── __tests__/
│   ├── unit/            Semaphore, Rate-Limit, JSON-Parsing, Hooks
│   ├── integration/     Orchestrator-Tests
│   └── api/             Server/API-Tests
├── .env.example         Konfigurationsvorlage
├── hooks.example.js     Hook-System Beispiel
├── templates.json       Vordefinierte Projekt-Templates
├── webhook-test.js      Webhook-Test-Script
├── jest.config.js       Jest-Konfiguration
├── package.json         Dependencies + Scripts
├── start.bat            Windows-Starter
├── ROADMAP.md           Feature-Roadmap
└── CLAUDE.md            Diese Datei
```

## Starten

```bash
npm install && node server.js   # http://localhost:3131
npm run dev                     # mit Auto-Reload
npm test                        # Tests
```

## Umgebungsvariablen

| Variable | Default | Beschreibung |
|---|---|---|
| `PORT` | `3131` | Server-Port |
| `NODE_ENV` | `development` | Umgebung |
| `AGENT_TIMEOUT` | `300000` | Timeout pro Agent in ms (5 Min) |
| `MAX_RETRIES` | `5` | Max Retries bei Rate-Limit/Netzwerkfehler |
| `RETRY_BASE_DELAY` | `5000` | Basis-Wartezeit fuer Exponential Backoff (ms) |
| `MAX_AGENTS` | `10` | Max Agenten pro Projekt |
| `AGENT_CONCURRENCY` | `3` | Gleichzeitig laufende Agenten |
| `AUTO_RETRY` | `true` | Automatischer Retry bei Agent-Fehler (`false` deaktiviert) |
| `WEBHOOK_URL` | – | URL fuer Webhook-Benachrichtigungen (HTTP POST) |
| `LOG_LEVEL` | `info` | Winston Log-Level |

## API-Endpoints

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check (Status, Uptime, Memory) |
| GET | `/api/stream` | SSE Endpoint (Live-Updates) |
| GET | `/api/status` | Aktueller Projekt-Status |
| GET | `/api/projects` | Alle bisherigen Projekte |
| GET | `/api/projects/:id` | Einzelnes Projekt (state.json) |
| GET | `/api/files/:id` | Dateibaum eines Projekts (rekursiv) |
| GET | `/api/file-content/:id/:filePath` | Datei-Inhalt lesen (max 1MB, kein Binaer) |
| GET | `/api/templates` | Vordefinierte Projekt-Templates |
| GET | `/api/export/:id` | Projekt als ZIP herunterladen |
| GET | `/api/merged/:id` | Zusammengefuehrte Dateien auflisten |
| GET | `/api/config` | Aktuelle Laufzeit-Konfiguration |
| GET | `/api/disk-usage` | Speicherplatz-Info (Groesse, Anzahl) |
| POST | `/api/start` | Neues Projekt starten |
| POST | `/api/reset` | Laufendes Projekt abbrechen |
| POST | `/api/retry/:agentIndex` | Fehlgeschlagenen Agent neu starten |
| POST | `/api/approve` | Plan genehmigen |
| POST | `/api/modify-plan` | Plan modifizieren und genehmigen |
| POST | `/api/config` | Laufzeit-Konfiguration aendern |
| POST | `/api/clone/:id` | Projekt-Einstellungen klonen |
| POST | `/api/cleanup` | Projekte aelter als 7 Tage loeschen |
| DELETE | `/api/projects/:id` | Einzelnes Projekt loeschen |

## SSE Events

| Event | Beschreibung |
|---|---|
| `state` | Vollstaendiger Zustand (bei Verbindungsaufbau) |
| `phase` | Phase geaendert (running, awaiting_approval, complete, partial, error) |
| `project_meta` | Projekt-Titel und Zusammenfassung |
| `coordinator` | Koordinator-Status (planning, ready, thinking, summarizing, done) |
| `agent` | Agent-Status Update |
| `agent_stream` | Live-Output-Chunk von Agent (Streaming) |
| `agent_msg` | Agent-Nachricht (Arbeit, Frage, Antwort) |
| `agents_updated` | Agenten-Array neu (nach Plan-Modifikation) |
| `rate_limit` | Rate-Limit erkannt, Retry laeuft |
| `auto_retry` | Agent wird automatisch neu gestartet |
| `merge_complete` | Zusammengefuehrte Dateien bereit |
| `error` | Fehlermeldung |

## Webhook-Events

Bei gesetzter `WEBHOOK_URL` werden HTTP POST Requests gesendet fuer:
`project_started`, `project_completed`, `project_partial`, `project_error`, `agent_error`

Payload: `{ event, data, projectId, timestamp }`

## Tastenkuerzel

| Taste | Aktion |
|---|---|
| `?` / `F1` | Tastenkuerzel-Hilfe anzeigen |
| `Esc` | Modal schliessen |
| `d` | Dark/Light Mode umschalten |
| `s` | Benachrichtigungston ein/aus |
| `r` | Projekt zuruecksetzen (nur wenn fertig) |
| `1-9` | Agent-Details oeffnen |
| `f` | Suchfeld fokussieren |
| `e` | ZIP exportieren (nur wenn fertig) |
| `Strg+Enter` | Projekt starten (im Setup) |

## Wichtige Stellen im Code

### orchestrator.js (Klasse `Orchestrator extends EventEmitter`)
- `runClaude()` / `_runClaudeWithRetry()` – Claude CLI mit Rate-Limit/Netzwerk Retry + Timeout
- `checkClaudeCli()` – Prueft ob Claude CLI im PATH verfuegbar ist
- `start(desc, agentCount, requireApproval)` – Haupteinstieg: Plan → Approval → Agenten → Summary → Merge
- `_coordinatorPlan()` – Koordinator erstellt Aufgaben-JSON mit Rollen und Abhaengigkeiten
- `_coordinatorSummary()` – Abschluss-Zusammenfassung (nicht-kritisch)
- `_coordinatorAnswer()` – Koordinator beantwortet Agenten-Frage (mit Kontext)
- `_runAgent()` – Agent-Loop: Arbeit → Frage? → Koordinator → weiter (max 5 Runden)
- `_mergeOutputs()` – Agenten-Dateien in `merged/` zusammenfuehren (mit Konflikt-Handling)
- `retryAgent()` – Einzelnen Agent erneut starten
- `approvePlan()` / `modifyPlan()` – Plan-Approval Workflow
- `_sendWebhook()` – HTTP POST an WEBHOOK_URL (fehlertolerant)
- `_readSharedContext()` / `_writeSharedContext()` – Inter-Agent Kontext
- `getConfig()` / `updateConfig()` – Laufzeit-Konfiguration lesen/aendern
- `detectCircularDeps()` – Zirkulaere Abhaengigkeiten erkennen und bereinigen
- `Semaphore` – Parallele Ausfuehrung begrenzen
- `sanitizeInput()`, `sanitizeError()`, `validateWorkDir()`, `validatePlan()` – Sicherheit
- `trimHistory()` – Agent-Verlauf auf 2000 Woerter begrenzen

### server.js
- Rate-Limiting: API 10/min, Start 3/min (`express-rate-limit`)
- SSE Event-Batching (`queueBroadcast`, 100ms Intervall)
- Race-Condition Schutz (`isStarting` Flag)
- Graceful Shutdown (SIGTERM/SIGINT)
- Path-Traversal-Schutz auf allen Datei-Endpoints

### public/index.html
- `connect()` – SSE mit Auto-Reconnect (exponential backoff, max 10 Versuche)
- `render()` / `updateAgent()` / `appendMessage()` – Incremental Rendering
- `filterAgents()` – Status-Filter + Textsuche ueber Agenten
- `openModal()` / `openFileModal()` / `openSettings()` – Modale Dialoge
- Sound-Benachrichtigungen (Web Audio API) + Browser Notifications
- Projekt-Vergleich (Compare Modal, max 2 Projekte)
- Druckansicht (`@media print`)

## Konventionen
- Deutsch fuer alle Prompts, UI-Texte und Kommentare
- Alle Claude-Aufrufe gehen durch `runClaude()` in orchestrator.js
- SSE-Events ueber `orchestrator.emit('update', { event, data })` senden
- Agent-Dateien in `projects/{projectId}/agent-{n}/`
- Konfiguration ueber Environment-Variablen (siehe `.env.example`)
- Async File I/O bevorzugen (`fs/promises`)
- Tests in `__tests__/`, ausfuehrbar mit `npm test`
- Hooks in optionaler `hooks.js` (siehe `hooks.example.js`)
- Fehler in Hooks, Webhooks und nicht-kritischen Schritten duerfen nie crashen
