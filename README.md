# Claude Multi-Agent Orchestrator

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![Lizenz](https://img.shields.io/badge/lizenz-MIT-yellow)

Ein Multi-Agent-System, das grosse Projekte automatisch in Teilaufgaben aufteilt und parallel bearbeitet. Ein Koordinator-Agent plant die Aufgaben, Sub-Agenten arbeiten sie gleichzeitig ab und koennen Rueckfragen an den Koordinator stellen. Nach Abschluss erstellt der Koordinator eine Gesamtzusammenfassung. Alles laeuft ueber die Claude Code CLI.

![Screenshot](screenshot.png)

---

## Features

### Kern-Funktionen

- Parallele Agent-Ausfuehrung mit konfigurierbarem Concurrency-Limit (Standard: 3 gleichzeitig)
- Koordinator plant Aufgaben als JSON mit Rollen und Personas pro Agent
- Shared Context zwischen Agenten (`shared-context.md`)
- Agenten koennen Rueckfragen an den Koordinator stellen
- Koordinator-Zusammenfassung nach Abschluss aller Agenten
- Plan-Approval-Workflow: Plan pruefen, modifizieren oder genehmigen bevor Agenten starten
- State Persistence (`state.json` pro Projekt) mit automatischer Wiederherstellung
- Semaphore-basierte Parallelitaetssteuerung

### Frontend

- Dark/Light Mode Toggle (wird in localStorage gespeichert)
- Live-Streaming der Agent-Outputs via SSE
- Fortschrittsbalken pro Agent und Gesamtfortschritt
- Incremental Rendering (kein volles innerHTML-Ersetzen)
- Projekt-Historie: alle bisherigen Projekte auflisten und laden
- Live-Dateibaum pro Projekt
- Datei-Inhalt Viewer (mit Syntax-Erkennung, max 1 MB)
- Agent-Detail-Ansicht per Klick
- Projekt-Vergleich (Compare-Modal)
- Benachrichtigungston ein/aus
- Mobile Responsive Layout
- Tastenkuerzel-Unterstuetzung
- Druckansicht
- ZIP-Export Button

### API

- Vollstaendige REST API mit 18+ Endpoints
- SSE (Server-Sent Events) fuer Live-Updates mit Auto-Reconnect
- SSE Event-Batching (100ms Intervall) fuer Performance
- Health-Check Endpoint mit Uptime und Memory-Info
- Projekt-Templates API
- Dateibaum- und Datei-Inhalt API
- ZIP-Export API
- Projekt klonen und loeschen
- Speicherplatz-Info API
- Alte Projekte automatisch aufraeumen (7+ Tage)
- Konfiguration zur Laufzeit aendern

### DevOps

- Webhook-Benachrichtigungen bei wichtigen Events (`project_started`, `project_completed`, `agent_error`)
- Hook-System (`hooks.js`) mit 6 Hook-Punkten
- Strukturiertes Logging mit Winston (konfigurierbar via `LOG_LEVEL`)
- Graceful Shutdown (SIGTERM/SIGINT)

### Qualitaet

- Unit-Tests (Semaphore, Rate-Limit, JSON-Parsing, Hooks, Shared Context, Timing)
- Integration-Tests (Orchestrator)
- API-Tests (Server, Export, Templates)
- Rate-Limit + Netzwerkfehler Erkennung mit Exponential Backoff (bis zu 5 Retries)
- Input-Validierung und Sanitierung
- CORS-Beschraenkung auf localhost
- API Rate-Limiting (10/min allgemein, 3/min fuer Projekt-Start)
- XSS-Schutz, Path-Traversal-Schutz, Prompt-Injection-Schutz
- SSE Client-Limit (max 50 gleichzeitige Verbindungen)
- Race-Condition-Schutz beim Projekt-Start

---

## Schnellstart

### Voraussetzungen

- **Node.js >= 18** -- https://nodejs.org
- **Claude Code CLI** -- `npm install -g @anthropic-ai/claude-code` + `claude login`

### Installation

```bash
npm install
```

### Starten

```bash
node server.js
```

Dann im Browser oeffnen: **http://localhost:3131**

### Alternativen

```bash
# Windows: Doppelklick auf start.bat (mit Auto-Install und Checks)
start.bat

# Development-Modus mit Auto-Reload:
npm run dev
```

---

## Konfiguration

Kopiere `.env.example` nach `.env` und passe die Werte an:

| Variable | Default | Beschreibung |
|---|---|---|
| `PORT` | `3131` | Server-Port |
| `NODE_ENV` | `development` | Umgebung (`development` / `production`) |
| `AGENT_TIMEOUT` | `300000` | Timeout pro Agent in ms (5 Minuten) |
| `MAX_RETRIES` | `5` | Maximale Retries bei Rate-Limit oder Netzwerkfehler |
| `RETRY_BASE_DELAY` | `5000` | Basis-Wartezeit fuer Exponential Backoff in ms |
| `MAX_AGENTS` | `10` | Maximale Anzahl Agenten pro Projekt |
| `AGENT_CONCURRENCY` | `3` | Gleichzeitig laufende Agenten |
| `WEBHOOK_URL` | *(leer)* | URL fuer Webhook-Benachrichtigungen (optional) |
| `LOG_LEVEL` | `info` | Winston Log-Level (`error`, `warn`, `info`, `debug`) |

---

## API-Referenz

### REST Endpoints

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/health` | Health-Check (Status, Uptime, Memory) |
| `GET` | `/api/stream` | SSE Endpoint fuer Live-Updates |
| `GET` | `/api/status` | Aktueller Projekt-Status |
| `GET` | `/api/projects` | Liste aller bisherigen Projekte |
| `GET` | `/api/projects/:id` | Einzelnes Projekt mit State laden |
| `GET` | `/api/files/:id` | Dateibaum eines Projekts (rekursiv) |
| `GET` | `/api/file-content/:id/:filePath` | Datei-Inhalt lesen (max 1 MB) |
| `GET` | `/api/templates` | Vordefinierte Projekt-Templates |
| `GET` | `/api/export/:id` | Projekt als ZIP herunterladen |
| `GET` | `/api/merged/:id` | Zusammengefuehrte Dateien eines Projekts |
| `GET` | `/api/config` | Aktuelle Konfiguration abrufen |
| `GET` | `/api/disk-usage` | Speicherplatz-Info aller Projekte |
| `POST` | `/api/start` | Neues Projekt starten |
| `POST` | `/api/reset` | Laufendes Projekt abbrechen |
| `POST` | `/api/retry/:agentIndex` | Einzelnen fehlgeschlagenen Agent neu starten |
| `POST` | `/api/approve` | Geplanten Plan genehmigen |
| `POST` | `/api/modify-plan` | Plan modifizieren und genehmigen |
| `POST` | `/api/config` | Konfiguration zur Laufzeit aendern |
| `POST` | `/api/clone/:id` | Projekt-Einstellungen klonen |
| `POST` | `/api/cleanup` | Projekte aelter als 7 Tage loeschen |
| `DELETE` | `/api/projects/:id` | Einzelnes Projekt loeschen |

### SSE Events

| Event | Beschreibung |
|---|---|
| `state` | Vollstaendiger Zustand (bei Verbindungsaufbau) |
| `phase` | Phase geaendert (`running`, `awaiting_approval`, `complete`, `error`) |
| `project_meta` | Projekt-Titel und Zusammenfassung |
| `coordinator` | Koordinator-Status (`planning`, `ready`, `thinking`, `summarizing`, `done`) |
| `agent` | Agent-Status Update |
| `agent_stream` | Live-Output-Chunk von Agent |
| `agent_msg` | Agent-Nachricht (Arbeit, Frage, Antwort) |
| `agents_updated` | Agenten-Array aktualisiert (nach Plan-Modifikation) |
| `rate_limit` | Rate-Limit erkannt, Retry laeuft |
| `network_error` | Netzwerkfehler erkannt, Retry laeuft |

---

## Architektur

```
Browser (public/index.html)
    |  SSE + REST (port 3131)
    v
Express Server (server.js)
    - Input-Validierung, CORS, XSS-Schutz, Path-Traversal-Schutz
    - Rate-Limiting (express-rate-limit)
    - SSE Broadcast mit Event-Batching
    - REST API (Start, Reset, Retry, Approve, Export, Templates, ...)
    |
    v
Orchestrator (orchestrator.js) -- Klasse mit EventEmitter
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

---

## Projekt-Templates

Vordefinierte Templates in `templates.json`:

| Template | Agenten | Beschreibung |
|---|---|---|
| REST API | 4 | Vollstaendige REST API mit Express.js, CRUD, Auth, Validierung, Tests |
| CLI Tool | 3 | Kommandozeilen-Tool mit Argument-Parsing, Help-Output, Farben, Tests |
| React App | 5 | React-Anwendung mit TypeScript, Routing, State Management, API-Anbindung |
| Python ML Pipeline | 4 | ML-Pipeline: Datenvorverarbeitung, Feature Engineering, Training, Deployment |
| Fullstack Web App | 5 | Frontend + Backend + Datenbank-Schema + Docker-Konfiguration |

---

## Hooks / Plugins

Kopiere `hooks.example.js` nach `hooks.js` und passe die Funktionen an:

```bash
cp hooks.example.js hooks.js
```

Verfuegbare Hooks:

| Hook | Zeitpunkt | Daten |
|---|---|---|
| `beforePlan` | Vor der Koordinator-Planung | `{ description, agentCount }` |
| `afterPlan` | Nach der Planung | `{ tasks, projectTitle }` |
| `beforeAgent` | Bevor ein Agent startet | `{ index, task, role }` |
| `afterAgent` | Nachdem ein Agent fertig ist | `{ index, status, duration, files }` |
| `onComplete` | Alle Agenten abgeschlossen | `{ projectId, totalDuration, agents }` |
| `onError` | Bei einem Fehler | `{ phase, error }` |

Jede Funktion ist optional. Hook-Fehler crashen niemals den Hauptprozess.

---

## Tastenkuerzel

| Taste | Aktion |
|---|---|
| `?` / `F1` | Tastenkuerzel-Hilfe anzeigen |
| `Esc` | Modal schliessen |
| `d` | Dark/Light Mode umschalten |
| `s` | Benachrichtigungston ein/aus |
| `r` | Projekt zuruecksetzen (nur wenn fertig) |
| `1`-`9` | Agent-Details oeffnen |
| `f` | Suchfeld fokussieren |
| `e` | ZIP exportieren (nur wenn fertig) |

---

## Tests

```bash
# Alle Tests ausfuehren
npm test

# Tests im Watch-Modus
npm run test:watch

# Tests mit Coverage-Report
npm run test:coverage
```

Test-Struktur:

```
__tests__/
  unit/
    semaphore.test.js         Semaphore fuer parallele Ausfuehrung
    rate-limit.test.js        Rate-Limit Erkennung
    json-parsing.test.js      JSON-Parsing aus Claude-Output
    hooks.test.js             Hook-System
    shared-context.test.js    Inter-Agent Shared Context
    timing.test.js            Timing und Dauer-Berechnung
    format-detection.test.js  Format-Erkennung
  integration/
    orchestrator.test.js      Orchestrator End-to-End
  api/
    server.test.js            Server und API-Endpoints
    export.test.js            ZIP-Export
    templates.test.js         Templates API
```

---

## Technologie-Stack

| Komponente | Technologie |
|---|---|
| Runtime | Node.js >= 18 |
| Server | Express 4 |
| KI-Aufrufe | Claude Code CLI |
| Live-Updates | Server-Sent Events (SSE) |
| Frontend | Vanilla JS (kein Framework, kein Build-Step) |
| Logging | Winston |
| Tests | Jest |
| ZIP-Export | Archiver |
| Rate-Limiting | express-rate-limit |
| CORS | cors |

---

## Projektstruktur

```
multiagents/
  server.js              Express Server, SSE-Streaming, REST API, Security
  orchestrator.js        Multi-Agent Logik (Klasse), parallele Ausfuehrung
  src/
    logger.js            Winston Logger Konfiguration
  public/
    index.html           GUI v2 (Vanilla JS, Dark/Light Mode, Responsive)
  projects/              Agent-Outputs + state.json pro Projekt (auto-erstellt)
  __tests__/
    unit/                Unit-Tests
    integration/         Orchestrator-Integration-Tests
    api/                 Server/API-Tests
  .env.example           Konfigurationsvorlage
  hooks.example.js       Hook-System Beispieldatei
  templates.json         Vordefinierte Projekt-Templates
  jest.config.js         Jest Test-Konfiguration
  package.json           Dependencies + Scripts
  start.bat              Windows-Starter (mit Checks + Auto-Install)
```

---

## Lizenz

MIT
