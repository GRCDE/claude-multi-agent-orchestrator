# Claude Multi-Agent Orchestrator v4.2

## Ueberblick

Ein Multi-Agent System das grosse Projekte automatisch in Teilaufgaben aufteilt.
Koordinator-Agent plant, Sub-Agenten arbeiten parallel ab (Semaphore + Dependency Graph),
koennen Rueckfragen stellen und sich gegenseitig Nachrichten senden.
Nach Abschluss erstellt der Koordinator eine Gesamtzusammenfassung und
Agenten-Outputs werden automatisch zusammengefuehrt.

### Architektur

```
Browser (public/index.html)
    | WebSocket (/ws) + SSE (/api/stream) + REST (port 3131)
    v
Express Server (server.js) ~2455 Zeilen + src/routes/ ~3640 Zeilen
    - CORS, Rate-Limiting (differenziert: Read/Mutation/Start/Export)
    - Auth-Middleware (Bearer Token, timing-safe Vergleich)
    - Security Headers (CSP, HSTS, X-Frame-Options, etc.)
    - Compression (gzip), Input-Sanitierung
    - SSE Broadcast mit Event-Batching (100ms)
    - WebSocket Server (Dual-Mode: WS + SSE Fallback)
    - REST API (134 Endpoints) + SSE + WebSocket
    - Performance-Metriken (CPU, Memory, Endpoint-Statistiken)
    - Project Queue mit Auto-Dequeue + Prioritaeten
    - Webhook-Dispatching (Event-basiert, HMAC-SHA256 Signatur)
    - Crash-Recovery (Checkpoint-basiert)
    - Projektuebergreifende Volltextsuche
    - Async File I/O (komplett, 0 sync fs-Aufrufe)
    - Modulare Route-Handler in src/routes/ (12 Module)
    v
src/routes/ (12 Module)
    - agents.js      Projekt-Steuerung (Start, Abort, Approve, Retry, Intervene, Resume)
    - analytics.js   Metriken, Stats, Analytics, Suche
    - config.js      Config, Prompts, Budget, Undo/Redo
    - exports.js     ZIP, JSON, Markdown, PDF Export, Merge
    - files.js       Dateibaum, Docs, I18n, Rollen, Retry-Strategien, Batch
    - health.js      Health-Checks, Logs, Recovery
    - projects.js    Projekte, Tags, Archive, Cleanup, Changelog, Diff
    - queue.js       Queue, Meilensteine
    - snapshots.js   Snapshots, Config-Profile
    - templates.js   Templates, Managed Templates
    - webhooks.js    Webhooks CRUD + Test
    v
src/ (10 Service-Module)
    - api-docs.js, batch-processor.js, config-profiles.js, health-monitor.js
    - i18n.js, log-search.js, logger.js, retry-strategies.js
    - snapshot-manager.js, template-manager.js
    v
Orchestrator (orchestrator.js) ~4250 Zeilen -- EventEmitter-Klasse
    - Parallele Agent-Ausfuehrung (Semaphore, maxParallelAgents)
    - Dependency Graph (depends_on, Zyklen-Erkennung)
    - Auto-Retry bei Agent-Fehler (1x automatisch, 10s Wartezeit)
    - Rate-Limit/Netzwerkfehler-Erkennung + Exponential Backoff
    - Token-Tracking + Budget-Limits + Kosten-Warnschwellen
    - Agent-Verifizierung (optional) + Deliverable-Verifikation
    - Live-Intervention (5 Typen: redirect, skip, restart, inject, complete)
    - Auto-Intervention (nach N Runden automatisch warnen)
    - Prompt-Templates (CRUD + Reset)
    - Webhook-Benachrichtigungen, Hook-System
    - Plan-Approval, Plan-Adaption (Interim Reports)
    - State Persistence (Delta-Write via djb2 Hash), Checkpoint-Rotation
    - Resume, Abort, Crash-Recovery
    - Merged Output mit Konflikterkennung (3 Strategien: latest/largest/manual)
    - Inter-Agent Messaging (max 3 pro Agent)
    - Projekt-Scoring (5 Kategorien, 0-100)
    v
Claude Code CLI (`claude --dangerously-skip-permissions -p "..."`)
    v
Dateisystem (projects/{id}/agent-{n}/)
    - task.md, transcript.md, conversation.jsonl, prompts.jsonl pro Agent
    - shared-context.md, state.json, project.md, merged/
    - state.checkpoint.{1,2,3}.json (Crash-Recovery)
```

## Neue Features seit v4.0

- **Claude Code SDK Integration**: Dual-Modus (CLI/SDK/Auto) fuer Claude-Ausfuehrung. SDK-Modus nutzt @anthropic-ai/claude-code direkt statt CLI-Spawning. Bessere Performance, strukturierte Token-Usage, automatischer Fallback. Konfigurierbar per CLAUDE_MODE ENV oder Config-API.
- **Git-Integration**: Auto-Commit von Projekt-Ergebnissen in Git-Repository. Branch pro Projekt, Auto-Push, konfigurierbares Commit-Prefix. 11 neue Git-API-Endpoints. Konfigurierbar per ENV oder Config-API/UI.
- **Performance-Metriken API**: CPU-Auslastung, Memory, Endpoint-Statistiken mit Timing (GET /api/metrics).
- **Differenziertes Rate-Limiting**: Separate Limits fuer Reads (120/min), Mutations (30/min), Starts (3/min), Exports (10/min). Custom Key-Generator mit IP + Token.
- **SSE-Verbindungslimit pro IP**: Max 5 SSE-Verbindungen pro IP-Adresse, zusaetzlich zum globalen Limit (50).
- **Erweiterte Intervention-Typen**: 5 Typen statt nur Redirect: `redirect`, `skip`, `restart`, `inject`, `complete`. Validierung pro Typ.
- **Auto-Intervention**: Automatische Warnung nach konfigurierbarer Rundenzahl (`AUTO_INTERVENTION_ROUNDS`). Erkennung repetitiver Outputs.
- **Crash-Recovery**: Checkpoint-Rotation (max 3), automatische Erkennung beim Start, Restore/Discard API. Shutdown-Checkpoint bei SIGTERM/SIGINT.
- **Projektuebergreifende Suche**: Volltextsuche ueber Titel, Conversations und Datei-Inhalte (GET /api/search). Timeout 5s, max 50 Ergebnisse, Kontext-Extraktion.
- **Webhook-Management (CRUD)**: Registrierung, Auflistung, Loeschen, Toggle, Test-Ping. HMAC-SHA256 Signatur, Delivery-Log, 1x Retry. Max 10 Webhooks. Persistiert in webhooks.json.
- **Webhook-Events**: project-started, project-done, project-error, agent-done, agent-error, plan-created, plan-adapted, budget-warning, budget-exceeded.
- **Templates CRUD + Import/Export**: Erstellen, Aktualisieren, Loeschen, JSON-Import/Export von Projekt-Templates. Tags und Icons.
- **Budget-API**: Separater Endpoint fuer Token-Budget mit Prozent-Anzeige und Kosten-Tracking.
- **Changelog-API**: Chronologische Agent-Aktionen pro Projekt mit Datei-Erkennung.
- **Projekt-Diff**: Zwei Projekte strukturiert vergleichen (Agents added/removed/changed, Score-Delta).
- **Meilenstein-API**: CRUD fuer Meilensteine + Projekt direkt aus Meilenstein starten.
- **Manuelles Re-Merge**: Merge nachtraeglich mit anderer Strategie erneut ausfuehren (POST /api/merge/:id).
- **Log-Viewer**: Strukturierte, paginierte, filterbare Log-API mit JSONL-Export und Dateien-Auflistung.
- **Health-Check**: Dual-Pfad (/health und /api/health).
- **Merge-Strategien**: `latest`, `largest`, `manual` -- konfigurierbar per ENV oder zur Laufzeit.
- **Interim Reports**: Koordinator erstellt Zwischenberichte alle N abgeschlossene Agenten.
- **Konfigurierbares Pricing**: Input/Output Token-Kosten per ENV oder API einstellbar.
- **Graceful Shutdown**: Checkpoint-Erstellung, Prozess-Cleanup, SSE/WS-Client-Schliessung.
- **Rollen-Management (CRUD)**: Agenten-Rollen definieren, bearbeiten, loeschen. Persistiert in roles.json.
- **Config-Profile**: Konfigurationsprofile speichern, laden, importieren/exportieren (profiles/).
- **Undo/Redo**: Config- und Plan-Aenderungen rueckgaengig machen / wiederherstellen.
- **Retry-Strategien**: Konfigurierbare Strategien (fixed, exponential, linear, etc.) per API waehlbar.
- **Snapshot-Manager**: Projekt-Snapshots erstellen, vergleichen, wiederherstellen, loeschen (snapshots/).
- **Batch-API**: Mehrere API-Requests in einem Batch ausfuehren (POST /api/batch). Statistiken + Blocked-Liste.
- **I18n-API**: Mehrsprachige Uebersetzungen (GET /api/i18n, GET /api/i18n/:lang).
- **API-Dokumentation**: Auto-generierte Docs (JSON, OpenAPI 3.0, Markdown, Swagger UI) unter /api/docs.
- **Erweiterte Suche**: Volltext-Suche mit Suggestions, Log-Suche, Re-Indexing, Statistiken.
- **Erweiterte Health-API**: Detaillierte Diagnostik, Alert-System, Schwellenwerte, Historie.
- **Erweiterte Performance-API**: Agent-Performance, Verlauf, Realtime-Metriken.
- **Managed Templates**: Erweiterte Template-Verwaltung mit Rating, Duplikation, Import/Export.
- **Syntax-Highlighting**: Prism.js fuer Code-Anzeige im File-Viewer (JS, TS, Python, JSON, CSS, Bash, Markdown).
- **Desktop-Notifications**: Native Browser-Notifications bei Projekt-Abschluss, Agent-Fehler, Agent-Fragen.
- **Server-Log-Viewer**: Integrierter Log-Viewer im Frontend mit Filterung, Paginierung und JSONL-Export (Taste 'l').
- **Projekt-Archivierung**: Projekte archivieren/entarchivieren (POST /api/projects/:id/archive, /unarchive). Archivierte Projekte visuell abgedimmt.
- **Projekt-Tags**: Tags pro Projekt zuweisen, filtern, entfernen. Tag-basierte Filterung in Historie. GET /api/tags fuer alle verwendeten Tags.
- **Projekt-Favoriten**: Projekte als Favorit markieren (Frontend, localStorage). Stern-Icon + Sortierung.
- **Projekt-Notizen**: Freitext-Notizen pro Projekt (Frontend, localStorage). Inline-Editor in Historie.
- **Draft-Modus**: Projekt-Beschreibung und Einstellungen als Entwurf speichern/wiederherstellen (localStorage).
- **PDF-Export**: Projekt als PDF exportieren (GET /api/export-pdf/:id).
- **Toast-Benachrichtigungen**: Nicht-blockierende Toast-Meldungen im Frontend fuer Aktionen und Tastenkuerzel.
- **Nicht-Stoeren-Modus**: Temporaerer DnD-Modus -- unterdrueckt Sound- und Desktop-Notifications.
- **Clipboard-Kopieren**: Projekt-ID, Texte und Code-Bloecke per Klick kopieren (Clipboard API).
- **Modulare Route-Architektur**: Server-Routen aufgeteilt in 12 Module unter src/routes/ (agents, analytics, config, exports, files, git, health, projects, queue, snapshots, templates, webhooks).

## API-Referenz

### Projekt-Steuerung

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/start` | Neues Projekt starten (Auth, Rate-Limit 3/min, Queue bei laufendem Projekt) |
| GET | `/api/status` | Aktueller Projekt-Status (getState) |
| POST | `/api/reset` | Projekt zuruecksetzen |
| POST | `/api/abort` | Laufendes Projekt abbrechen (Teilergebnisse behalten) |
| POST | `/api/approve` | Plan genehmigen |
| POST | `/api/modify-plan` | Plan modifizieren und genehmigen (Tasks-Array) |
| POST | `/api/retry/:agentIndex` | Fehlgeschlagenen Agent neu starten |
| POST | `/api/intervene/:agentIndex` | Intervention an Agent senden (5 Typen) |
| POST | `/api/load/:id` | Projekt in Orchestrator laden (Historie anzeigen) |
| POST | `/api/resume/:id` | Fehlgeschlagenes Projekt fortsetzen |
| POST | `/api/clone/:id` | Projekt-Einstellungen klonen |
| POST | `/api/cleanup` | Projekte aelter als 7 Tage loeschen |

### Projekt-Historie

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/projects` | Alle Projekte auflisten (mit Score, Tokens, Phase) |
| GET | `/api/tags` | Alle verwendeten Projekt-Tags |
| GET | `/api/projects/:id` | Einzelnes Projekt laden (state.json) |
| DELETE | `/api/projects/:id` | Einzelnes Projekt loeschen |
| POST | `/api/projects/:id/archive` | Projekt archivieren |
| POST | `/api/projects/:id/unarchive` | Projekt entarchivieren |
| GET | `/api/projects/:id/changelog` | Chronologische Agent-Aktionen |
| GET | `/api/projects/:id1/diff/:id2` | Zwei Projekte vergleichen (added/removed/changed) |

### Queue

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/queue` | Warteschlange anzeigen (mit Wartezeit-Schaetzung) |
| POST | `/api/queue/reorder` | Queue-Reihenfolge aendern (from, to) |
| POST | `/api/queue/clear` | Warteschlange leeren |
| DELETE | `/api/queue/:index` | Element aus Warteschlange entfernen |

### Export

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/export/:id` | Projekt als ZIP herunterladen (zlib level 9) |
| GET | `/api/export-json/:id` | Projekt als JSON mit Conversations |
| GET | `/api/export-markdown/:id` | Projekt als Markdown-Bericht |
| GET | `/api/export-pdf/:id` | Projekt als PDF-Bericht |
| GET | `/api/merged/:id` | Zusammengefuehrte Dateien + Merge-Report + Konflikte |
| POST | `/api/merge/:id` | Manuelles Re-Merge triggern (Strategie waehlbar) |

### Dateien

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/files/:id` | Dateibaum eines Projekts (rekursiv, mit Groesse) |
| GET | `/api/file-content/:id/:filePath` | Datei-Inhalt lesen (max 1MB, Binaer-Erkennung) |
| GET | `/api/agent-prompts/:id/:agentIndex` | Agent-Prompt-Log (JSONL, mit Token-Schaetzung) |

### Templates

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/templates` | Alle Projekt-Templates + Task-Presets laden |
| POST | `/api/templates` | Neues Template erstellen (title, description, agentCount, icon, tags) |
| PUT | `/api/templates/:id` | Template aktualisieren |
| DELETE | `/api/templates/:id` | Template loeschen |
| POST | `/api/templates/import` | Templates aus JSON importieren |
| GET | `/api/templates/export` | Alle Templates als JSON exportieren |

### Meilensteine

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/milestones` | Meilensteine laden |
| POST | `/api/milestones` | Meilensteine speichern (Array mit id, title, tasks) |
| POST | `/api/start-milestone` | Projekt aus Meilenstein starten (milestoneId) |

### Config + Prompts

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/config` | Laufzeit-Konfiguration lesen |
| POST | `/api/config` | Laufzeit-Konfiguration aendern |
| POST | `/api/config/undo` | Letzte Config-Aenderung rueckgaengig machen |
| POST | `/api/config/redo` | Config-Aenderung wiederherstellen |
| GET | `/api/prompts` | Prompt-Templates + Variablen |
| POST | `/api/prompts` | Prompt-Templates aktualisieren |
| POST | `/api/prompts/reset` | Prompt-Templates auf Standard zuruecksetzen |
| POST | `/api/plan/undo` | Letzte Plan-Aenderung rueckgaengig machen |
| POST | `/api/plan/redo` | Plan-Aenderung wiederherstellen |
| GET | `/api/undo-redo` | Undo/Redo-Status abfragen |

### Rollen

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/roles` | Alle Rollen auflisten |
| POST | `/api/roles` | Neue Rolle erstellen |
| PUT | `/api/roles/:id` | Rolle aktualisieren |
| DELETE | `/api/roles/:id` | Rolle loeschen |

### Config-Profile

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/profiles` | Alle Profile auflisten |
| GET | `/api/profiles/:name` | Einzelnes Profil laden |
| POST | `/api/profiles` | Neues Profil erstellen |
| DELETE | `/api/profiles/:name` | Profil loeschen |
| POST | `/api/profiles/:name/apply` | Profil anwenden |
| POST | `/api/profiles/save-current` | Aktuelle Config als Profil speichern |
| POST | `/api/profiles/import` | Profil importieren |
| GET | `/api/profiles/:name/export` | Profil exportieren |

### Retry-Strategien

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/retry-strategies` | Verfuegbare Strategien auflisten |
| GET | `/api/retry-strategy` | Aktive Strategie abfragen |
| PUT | `/api/retry-strategy` | Aktive Strategie aendern |

### Snapshots

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/snapshots` | Alle Snapshots auflisten (optional ?projectId=X) |
| GET | `/api/snapshots/:id` | Einzelner Snapshot mit State |
| POST | `/api/snapshots` | Manuellen Snapshot erstellen |
| DELETE | `/api/snapshots/:id` | Snapshot loeschen |
| POST | `/api/snapshots/:id/restore` | Snapshot wiederherstellen |
| GET | `/api/snapshots/:id1/compare/:id2` | Zwei Snapshots vergleichen |
| GET | `/api/snapshots/:id/size` | Snapshot-Groesse abfragen |

### Batch

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/batch` | Batch-Request verarbeiten |
| GET | `/api/batch/stats` | Batch-Statistiken |
| GET | `/api/batch/blocked` | Liste der blockierten Endpoints |

### I18n

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/i18n` | Verfuegbare Sprachen |
| GET | `/api/i18n/:lang` | Uebersetzungen fuer eine Sprache |

### API-Dokumentation

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/docs` | Docs-Uebersicht (HTML) |
| GET | `/api/docs/json` | API-Docs als JSON |
| GET | `/api/docs/openapi` | OpenAPI 3.0 Spezifikation |
| GET | `/api/docs/markdown` | API-Docs als Markdown |
| GET | `/api/docs/ui/` | Swagger UI |

### Managed Templates

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/templates/managed` | Alle Managed Templates |
| POST | `/api/templates/managed` | Neues Managed Template erstellen |
| GET | `/api/templates/managed/:id` | Einzelnes Managed Template |
| PUT | `/api/templates/managed/:id` | Managed Template aktualisieren |
| DELETE | `/api/templates/managed/:id` | Managed Template loeschen |
| POST | `/api/templates/managed/:id/apply` | Managed Template anwenden |
| POST | `/api/templates/managed/:id/duplicate` | Managed Template duplizieren |
| GET | `/api/templates/managed/:id/export` | Managed Template exportieren |
| POST | `/api/templates/managed/:id/rate` | Managed Template bewerten |
| POST | `/api/templates/managed/import` | Managed Template importieren |

### Token-Budget

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/token-usage` | Token-Verbrauch (gesamt, Koordinator, pro Agent, Budget-Status) |
| GET | `/api/budget` | Budget-Status mit Prozent-Anzeige und Kosten |
| POST | `/api/budget` | Budget-Einstellungen aendern (maxTokenBudget, warnTokenBudget, Pricing) |

### Analytics + Statistiken

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/analytics` | Aggregierte Analytics (60s Cache): Timeline, Rollen, Kosten, Top-Projekte, Verteilung |
| GET | `/api/stats` | Projekt-Statistiken (Anzahl, Score-Durchschnitt, Dateien, Zeilen) |
| GET | `/api/disk-usage` | Speicherplatz-Info (Groesse, aeltestes/neuestes Projekt) |
| GET | `/api/performance` | Performance-Uebersicht |
| GET | `/api/performance/agents` | Agent-Performance-Statistiken |
| GET | `/api/performance/history` | Performance-Verlauf |
| GET | `/api/performance/realtime` | Realtime-Performance-Metriken |

### Metriken + Logs

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/metrics` | Performance-Metriken (CPU, Memory, Endpoint-Timings, Connections) |
| DELETE | `/api/metrics` | Metriken zuruecksetzen |
| GET | `/api/logs` | Server-Logs (paginiert, filterbar nach Level/Kategorie/Suchtext) |
| GET | `/api/logs/export` | Alle Logs als JSONL-Download |
| GET | `/api/logs/files` | Rotierte Log-Dateien auflisten |

### Health

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check (Status, Uptime, Phase, Memory) |
| GET | `/api/health` | Health-Check (identisch, alternativer Pfad) |
| GET | `/api/health/detailed` | Detaillierter Health-Check (System-Diagnostik) |
| GET | `/api/health/diagnostics` | Erweiterte Diagnostik-Informationen |
| GET | `/api/health/history` | Health-Verlauf |
| GET | `/api/health/alerts` | Aktive Health-Alerts |
| POST | `/api/health/alerts/:id/clear` | Alert loeschen |
| GET | `/api/health/thresholds` | Schwellenwerte abfragen |
| PUT | `/api/health/thresholds` | Schwellenwerte aendern |

### Webhooks

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/webhooks` | Webhook registrieren (url, events[], secret) |
| GET | `/api/webhooks` | Alle Webhooks auflisten (mit Delivery-Log) |
| DELETE | `/api/webhooks/:id` | Webhook loeschen |
| POST | `/api/webhooks/:id/test` | Test-Ping an Webhook senden |
| POST | `/api/webhooks/:id/toggle` | Webhook aktivieren/deaktivieren |
| POST | `/api/test-webhook` | Legacy: Webhook-URL testen (einfacher POST) |

### Crash-Recovery

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/recovery` | Pruefen ob Crash-Recovery moeglich ist |
| POST | `/api/recovery/restore` | Aus Checkpoint wiederherstellen |
| POST | `/api/recovery/discard` | Checkpoint verwerfen |

### Suche

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/search` | Projektuebergreifende Suche (q, scope: all/files/conversations/titles) |
| GET | `/api/search/full` | Erweiterte Volltextsuche |
| GET | `/api/search/suggest` | Suchvorschlaege |
| GET | `/api/search/stats` | Such-Statistiken |
| GET | `/api/search/logs` | Log-Suche |
| POST | `/api/search/reindex` | Such-Index neu aufbauen |

### Git-Integration

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/git/status` | Git-Status und Konfiguration |
| GET | `/api/git/log` | Git-Log (letzte Commits, ?count=N) |
| GET | `/api/git/branches` | Branches auflisten |
| GET | `/api/git/diff/:hash` | Diff fuer einen Commit |
| GET | `/api/git/config` | Git-Konfiguration lesen |
| POST | `/api/git/config` | Git-Konfiguration aendern |
| POST | `/api/git/commit` | Manueller Commit |
| POST | `/api/git/push` | Push zum Remote |
| POST | `/api/git/checkout` | Branch wechseln |
| POST | `/api/git/init` | Repository initialisieren |
| POST | `/api/git/commit-project/:id` | Projekt-Ergebnisse committen |

### SSE + WebSocket

| Pfad | Beschreibung |
|---|---|
| GET `/api/stream` | SSE-Endpoint (Auto-Reconnect via Last-Event-ID, max 50 Clients, 5 pro IP) |
| `/ws` | WebSocket-Endpoint (Upgrade-Handler, Heartbeat, Event-Subscription) |

**Gesamt: 136 Endpoints** (134 REST + SSE + WebSocket)

## SSE-Events

Alle Events werden sowohl ueber SSE (`/api/stream`) als auch WebSocket (`/ws`) gesendet (Dual-Broadcast).

| Event | Beschreibung |
|---|---|
| `state` | Vollstaendiger Zustand (bei Verbindungsaufbau) |
| `phase` | Phase geaendert (running, awaiting_approval, complete, partial, error) |
| `project_meta` | Projekt-Titel und Zusammenfassung |
| `coordinator` | Koordinator-Status (planning, ready, thinking, summarizing, done, error) |
| `coordinator-interim` | Koordinator Zwischenbericht |
| `agent` | Agent-Status Update (inkl. Score, TokenUsage, FileChanges) |
| `agent-start` | Agent hat gestartet (Index, Titel, Aufgabe) |
| `agent-score` | Agent-Bewertung berechnet (5 Kategorien) |
| `agent_stream` | Live-Output-Chunk von Agent (100ms gedrosselt) |
| `agent_msg` | Agent-Nachricht (Arbeit, Frage, Antwort, Final) |
| `agent_message` | Inter-Agent Nachricht (from, to, text) |
| `agent_verified` | Agent-Verifikationsergebnis |
| `agent_skipped_budget` | Agent uebersprungen wegen Budget |
| `agent_intervention_applied` | Intervention wurde angewendet (Typ + Nachricht) |
| `agent_intervention_queued` | Intervention in Warteschlange eingereiht |
| `agents_updated` | Agenten-Array aktualisiert (nach Plan-Modifikation) |
| `auto_retry` | Agent wird automatisch neu gestartet |
| `auto_intervention_warning` | Auto-Intervention Warnung (Runden-Limit, repetitiver Output) |
| `rate_limit` | Rate-Limit erkannt, Retry laeuft (mit Delay, Versuch, maxRetries) |
| `activity` | Activity-Feed Eintrag |
| `queue_updated` | Warteschlange geaendert (mit Wartezeit-Schaetzung) |
| `parallel_start` | Parallele Ausfuehrung gestartet (maxParallelAgents, agentCount) |
| `merge-start` | Merge-Vorgang gestartet (Strategie, Timestamp) |
| `merge-complete` | Merge abgeschlossen (Dateien, Konflikte, Dauer) |
| `merge_complete` | Zusammengefuehrte Dateien bereit (Dateien, Verzeichnis) |
| `plan-adapted` | Plan wurde adaptiert (Interim Report) |
| `checkpoint_created` | Checkpoint erstellt (Grund, Projekt-ID) |
| `project-score` | Projekt-Gesamtbewertung berechnet |
| `budget_warning` | Token-Warnschwelle erreicht |
| `budget_exceeded` | Token-Budget ueberschritten |
| `reconnect_recovery` | SSE Reconnect: verpasste Events nachgeliefert |
| `subscribed` | WebSocket: Event-Subscription bestaetigt |
| `git_commit` | Git-Commit erstellt (Hash, Branch, Projekt-ID) |
| `error` | Fehlermeldung |

## WebSocket-Protokoll

### Verbindung

```
ws://localhost:3131/ws
```

Upgrade-Handler auf Pfad `/ws`. Bei Verbindung wird sofort der aktuelle State gesendet.

### Client-Nachrichten (Client -> Server)

```json
{ "action": "ping" }
```
Server antwortet mit: `{ "event": "pong", "data": { "timestamp": ... } }`

```json
{ "action": "subscribe", "events": ["agent", "phase", "coordinator"] }
```
Selektives Event-Subscribing. Server antwortet mit: `{ "event": "subscribed", "data": { "events": [...] } }`
Wenn `_subscribedEvents` gesetzt ist, werden nur abonnierte Events gesendet.

### Server-Nachrichten (Server -> Client)

```json
{ "event": "<eventName>", "data": { ... } }
```

### Heartbeat

- Server sendet alle 30s einen Ping (`WS_PING_INTERVAL`)
- Client muss mit Pong antworten (WebSocket-Protokoll)
- Timeout nach 60s ohne Pong (`WS_PONG_TIMEOUT`) -> Client wird entfernt

## Konfiguration

### Umgebungsvariablen

| Variable | Default | Beschreibung |
|---|---|---|
| `PORT` | `3131` | Server-Port |
| `NODE_ENV` | `development` | Umgebung |
| `API_TOKEN` | – | Optionaler Auth-Token (Bearer) |
| `ALLOWED_ORIGINS` | – | Zusaetzliche CORS-Origins (kommasepariert) |
| `AGENT_TIMEOUT` | `300000` | Timeout pro Agent in ms (5 Min) |
| `MAX_RETRIES` | `5` | Max Retries bei Rate-Limit/Netzwerkfehler |
| `RETRY_BASE_DELAY` | `5000` | Basis-Wartezeit fuer Exponential Backoff (ms) |
| `MAX_AGENTS` | `10` | Max Agenten pro Projekt |
| `AGENT_CONCURRENCY` | `3` | Gleichzeitig laufende Agenten |
| `MAX_PARALLEL_AGENTS` | `3` | Max parallele Agenten (Alias fuer AGENT_CONCURRENCY) |
| `MAX_ROUNDS` | `5` | Max Runden pro Agent |
| `INTERIM_REPORT_INTERVAL` | `3` | Zwischenbericht alle N fertige Agenten |
| `AUTO_RETRY` | `true` | Automatischer Retry bei Agent-Fehler |
| `AGENT_ISOLATION` | `shared` | Isolation-Modus (shared/strict) |
| `WEBHOOK_URL` | – | Legacy: URL fuer einfache Webhook-Benachrichtigungen |
| `TOKEN_BUDGET` | `0` | Max Token-Budget (0 = unbegrenzt) |
| `WARN_TOKEN_BUDGET` | `0` | Token-Warnschwelle (0 = deaktiviert) |
| `INPUT_COST_PER_MTOK` | `3` | Input-Kosten pro Million Tokens in USD |
| `OUTPUT_COST_PER_MTOK` | `15` | Output-Kosten pro Million Tokens in USD |
| `VERIFY_AGENTS` | `false` | Agent-Outputs per Claude-Aufruf verifizieren |
| `AUTO_INTERVENTION` | `false` | Auto-Intervention aktivieren |
| `AUTO_INTERVENTION_ROUNDS` | `10` | Rundenzahl ab der Auto-Intervention warnt |
| `MERGE_STRATEGY` | `latest` | Merge-Strategie (latest/largest/manual) |
| `CLAUDE_MODE` | `cli` | Ausfuehrungsmodus: cli (CLI-Spawning), sdk (Native SDK), auto (SDK bevorzugt, CLI Fallback) |
| `GIT_ENABLED` | `false` | Git-Integration aktivieren |
| `GIT_WORK_DIR` | – | Absoluter Pfad zum Ziel-Git-Repository |
| `GIT_AUTO_COMMIT` | `true` | Auto-Commit nach Merge |
| `GIT_BRANCH_PER_PROJECT` | `true` | Eigener Branch pro Projekt |
| `GIT_AUTO_PUSH` | `false` | Auto-Push nach Commit |
| `GIT_COMMIT_PREFIX` | `[orchestrator]` | Prefix fuer Commit-Messages |
| `LOG_LEVEL` | `info` | Winston Log-Level |

### Orchestrator-Konstanten

| Konstante | Wert | Beschreibung |
|---|---|---|
| `MAX_CONVERSATION_RAM` | `20` | Max Messages pro Agent im RAM |
| `MAX_MESSAGES_PER_AGENT` | `3` | Max Inter-Agent Nachrichten |
| `MAX_QUESTIONS_PER_AGENT` | `2` | Max Fragen an Koordinator |
| `HISTORY_WORD_LIMIT` | `2000` | Max Woerter in trimHistory |
| `STATE_SAVE_INTERVAL` | `2000` | ms zwischen State-Saves |
| `AUTO_RETRY_DELAY` | `10000` | ms vor Auto-Retry |
| `MAX_BACKOFF_MS` | `60000` | Maximale Backoff-Wartezeit |
| `MAX_CHECKPOINTS` | `3` | Max rotierte Checkpoints fuer Crash-Recovery |
| `MIN_CLI_VERSION` | `1.0.0` | Mindestversion der Claude CLI |

### Server-Konstanten

| Konstante | Wert | Beschreibung |
|---|---|---|
| `MAX_CLIENTS` | `50` | Max gleichzeitige SSE-Verbindungen |
| `MAX_SSE_PER_IP` | `5` | Max SSE-Verbindungen pro IP |
| `MAX_EVENT_HISTORY` | `200` | Gespeicherte Events fuer Reconnect-Recovery |
| `BATCH_INTERVAL` | `100` | ms zwischen Event-Batch-Flushes |
| `MAX_QUEUE_SIZE` | `10` | Max Projekte in Warteschlange |
| `WS_PING_INTERVAL` | `30000` | WebSocket Heartbeat-Intervall |
| `WS_PONG_TIMEOUT` | `60000` | WebSocket Timeout ohne Pong |
| `MAX_WEBHOOKS` | `10` | Max registrierte Webhooks |
| `WEBHOOK_TIMEOUT` | `5000` | Timeout fuer Webhook-Requests (ms) |
| `WEBHOOK_RETRY_DELAY` | `10000` | Wartezeit vor Webhook-Retry (ms) |
| `MAX_DELIVERY_LOG` | `50` | Max Delivery-Log Eintraege pro Webhook |
| `ANALYTICS_CACHE_TTL` | `60000` | Analytics-Cache Gueltigkeitsdauer (ms) |
| `MAX_FILE_SIZE` | `1048576` | Max Dategroesse fuer Lesen/Suche (1 MB) |
| `MAX_TRACKED_DURATIONS` | `20` | Projekt-Dauern fuer Wartezeit-Schaetzung |

### Rate-Limiting

| Limiter | Requests/Minute | Anwendung |
|---|---|---|
| `apiReadLimiter` | 120 | GET-Endpoints (Stats, Analytics, Disk-Usage, Search, Webhooks) |
| `apiLimiter` | 30 | POST/PUT/DELETE Mutations |
| `startLimiter` | 3 | Projekt-Start und Resume |
| `exportLimiter` | 10 | ZIP/JSON/Markdown Export, Templates-Export, Log-Export |

## Projektstruktur

```
Multiagents/
├── server.js              Express Server, SSE, WebSocket, Middleware, Metriken (~2455 Zeilen)
├── orchestrator.js        Orchestrator-Klasse, parallele Ausfuehrung, Merge, Recovery (~4250 Zeilen)
├── src/
│   ├── routes/            Modulare API-Route-Handler (~3640 Zeilen gesamt)
│   │   ├── agents.js      Projekt-Steuerung (Start, Abort, Approve, Retry, Intervene, Resume)
│   │   ├── analytics.js   Metriken, Stats, Analytics, Suche
│   │   ├── config.js      Config, Prompts, Budget, Undo/Redo
│   │   ├── exports.js     ZIP, JSON, Markdown, PDF Export, Merge
│   │   ├── files.js       Dateibaum, Docs, I18n, Rollen, Retry-Strategien, Batch
│   │   ├── health.js      Health-Checks, Logs, Recovery
│   │   ├── projects.js    Projekte, Tags, Archive, Cleanup, Changelog, Diff
│   │   ├── queue.js       Queue, Meilensteine
│   │   ├── snapshots.js   Snapshots, Config-Profile
│   │   ├── templates.js   Templates, Managed Templates
│   │   ├── webhooks.js    Webhooks CRUD + Test
│   │   └── git.js         Git-Integration (Status, Log, Commit, Push, Branches)
│   ├── logger.js          Winston Logger + BufferTransport + Log-Rotation
│   ├── claude-sdk.js      Claude Code SDK Wrapper (Detection, Fallback, Streaming)
│   ├── git-integration.js Git-Integration (Commit, Branch, Push, Diff)
│   ├── api-docs.js        Auto-generierte API-Dokumentation (JSON, OpenAPI, Markdown, Swagger UI)
│   ├── batch-processor.js Batch-Request-Verarbeitung
│   ├── config-profiles.js Config-Profil-Management (CRUD, Import/Export)
│   ├── health-monitor.js  Erweitertes Health-Monitoring (Alerts, Diagnostik, Historie)
│   ├── i18n.js            Internationalisierung (Mehrsprachigkeit)
│   ├── log-search.js      Erweiterte Log-Suche
│   ├── retry-strategies.js Konfigurierbare Retry-Strategien
│   ├── snapshot-manager.js Snapshot-Verwaltung (CRUD, Vergleich, Restore)
│   └── template-manager.js Erweiterte Template-Verwaltung (Rating, Duplikation)
├── public/
│   └── index.html         GUI (Vanilla JS, Dark/Light, WebSocket/SSE, 3 Ansichten, ~13600 Zeilen)
├── projects/              Agent-Outputs + state.json + Checkpoints (auto-erstellt)
├── profiles/              Config-Profile (JSON, auto-erstellt)
├── snapshots/             Projekt-Snapshots (JSON, auto-erstellt)
├── templates/             Managed Templates (JSON, auto-erstellt)
├── logs/                  Rotierte Log-Dateien (auto-erstellt)
├── screenshots/           Screenshots (auto-erstellt)
├── __tests__/
│   ├── unit/              31 Test-Dateien
│   ├── api/               58 API-Test-Dateien
│   ├── e2e/               24 E2E-Test-Dateien
│   └── integration/       1 Orchestrator E2E Test
├── .env.example           Konfigurationsvorlage
├── hooks.example.js       Hook-System Beispiel
├── templates.json         Projekt-Templates + Task-Presets
├── roles.json             Agenten-Rollen-Definitionen
├── milestones.json        Meilenstein-Modus Definitionen
├── prompts.default.json   Standard-Prompt-Templates
├── webhooks.json          Registrierte Webhooks (auto-erstellt)
├── webhook-test.js        Webhook-Test-Script
├── pw-debug.js            Playwright Debug-Helfer
├── jest.config.js         Jest-Konfiguration (maxWorkers:1)
├── Dockerfile             Docker-Container
├── docker-compose.yml     Docker Compose
├── package.json           v4.2.0
├── start.bat              Windows-Starter
├── README.md              Projekt-README
├── GUIDE.md               Benutzerhandbuch
├── ROADMAP.md             Feature-Roadmap
└── CLAUDE.md              Diese Datei
```

## Tests

114 Test-Suites (`npm test`):

- **Unit** (31): API-Docs, Backoff, Batch-Processor, Config, Config-Profiles, Config-Validation, Delta-Writes, Dependency, Dependency-Graph, Format-Detection, Health-Monitor, Hooks, I18n, Intervention, Intervention-Types, JSON-Parsing, Load-Project, Log-Search, Progress, Rate-Limit, Resume, Retry-Strategies, Scoring, Semaphore, Shared-Context, Snapshot-Manager, State-Persistence, Template-Manager, Timing, Token-Tracking, Webhook
- **API** (58): Abort-Resume, Agent-Prompts, Analytics, Archive, Auth, Batch, Batch-Ops, Benchmark, Budget, Changelog, Config, Config-CRUD, Disk-Cleanup, Docs, Export, Export-Formats, Export-PDF, File-Browser, File-Content, Health, Health-Alerts, Health-Detailed, I18n-Strategies, Intervention, Logs, Merge, Metrics, Milestones, Milestones-CRUD, Performance, Profiles, Profiles-CRUD, Project-Lifecycle, Projects, Prompts, Queue, Queue-Priority, Rate-Limiting, Recovery, Reorder, Roles, Search, Search-Advanced, Search-Full, Security, Server, Snapshots, Snapshots-CRUD, SSE-Stream, Start-Reset, Stats, Tags, Templates, Templates-CRUD, Templates-Managed, Undo-Redo, Webhooks, Webhooks-CRUD
- **E2E** (24): Accessibility, Analytics, Clipboard, Connection, Cost-Banner, Draft, Favorites, File-Viewer, History, Integration, Keyboard, Mobile, Notes, Onboarding, Project-Flow, Queue, Search-Highlight, Settings, Smoke, Theme, Toasts, Token-Panel, Webhooks-UI, Workspace
- **Integration** (1): Orchestrator E2E

Jeder API-Test nutzt einen eigenen Port (3196+) um Konflikte zu vermeiden.

```bash
npm test               # Alle Tests
npm run test:watch     # Watch-Modus
npm run test:coverage  # Coverage-Report
```

## Tastenkuerzel

| Taste | Aktion |
|---|---|
| `?` / `F1` | Tastenkuerzel-Hilfe anzeigen |
| `Esc` | Modal schliessen |
| `d` | Dark/Light Mode umschalten |
| `s` | Benachrichtigungston ein/aus |
| `r` | Projekt zuruecksetzen (nur wenn fertig) |
| `n` | Analytics Dashboard oeffnen |
| `1-9` | Agent-Details oeffnen |
| `f` | Suchfeld fokussieren |
| `e` | ZIP exportieren (nur wenn fertig) |
| `l` | Server-Logs anzeigen/schliessen |
| `Strg+Enter` | Projekt starten (im Setup) |

## Webhooks

### Verfuegbare Events

| Event | Ausgeloest wenn |
|---|---|
| `project-started` | Projekt-Phase wechselt zu `running` (kein Resume/Restore) |
| `project-done` | Projekt-Phase wechselt zu `complete` |
| `project-error` | Projekt-Phase wechselt zu `error` |
| `agent-done` | Agent-Status wechselt zu `done` |
| `agent-error` | Agent-Status wechselt zu `error` |
| `plan-created` | Koordinator hat Plan erstellt (Tasks vorhanden) |
| `plan-adapted` | Plan wurde im laufenden Betrieb angepasst |
| `budget-warning` | Token-Warnschwelle erreicht |
| `budget-exceeded` | Token-Budget ueberschritten |

### Signatur-Format

Jeder Webhook-Request enthaelt einen `X-Webhook-Signature` Header mit HMAC-SHA256 Signatur:

```
X-Webhook-Signature: <hex-encoded HMAC-SHA256 des JSON-Payloads mit dem Secret>
```

Payload-Format:
```json
{
  "event": "project-done",
  "timestamp": "2026-04-06T12:00:00.000Z",
  "data": { ... },
  "signature": ""
}
```

Bei fehlgeschlagener Zustellung wird 1x nach 10 Sekunden automatisch erneut versucht (mit `retry: true` im Payload).

User-Agent: `Claude-MultiAgent-Orchestrator/1.0`

## Docker

```bash
# Image bauen
npm run docker:build
# oder direkt:
docker build -t claude-multiagents .

# Container starten (mit Docker Compose)
npm run docker:run
# oder direkt:
docker compose up -d
```

Die Konfiguration erfolgt ueber Umgebungsvariablen in `docker-compose.yml` oder per `.env`-Datei.

## Starten

```bash
npm install            # einmalig
node server.js         # dann http://localhost:3131 oeffnen
npm run dev            # mit Auto-Reload (--watch)
npm test               # 114 Test-Suites
```

Oder: `start.bat` doppelklicken (Windows)

## Wichtige Stellen im Code

### orchestrator.js (Klasse `Orchestrator extends EventEmitter`)

- `Semaphore` -- Klasse fuer parallele Ausfuehrung mit konfigurierbarem Maximum
- `runClaude()` / `_runClaudeWithRetry()` -- Claude CLI mit Rate-Limit/Netzwerk Retry + Timeout + AbortController
- `start(desc, agentCount, requireApproval)` -- Haupteinstieg: Plan -> Approval -> Agenten -> Summary -> Merge
- `abort()` -- Laufendes Projekt abbrechen, Teilergebnisse behalten
- `resume(projectId)` -- Fehlgeschlagenes Projekt fortsetzen
- `restoreFromCheckpoint(checkpoint, projectDir)` -- Crash-Recovery aus Checkpoint
- `loadProject(projectId)` -- State von Disk laden
- `reset()` -- Orchestrator zuruecksetzen, aktive Prozesse beenden
- `remerge(strategy)` -- Merge erneut ausfuehren mit optionaler Strategie
- `_coordinatorPlan()` -- Koordinator erstellt Aufgaben-JSON mit Rollen und Abhaengigkeiten
- `_coordinatorSummary()` -- Abschluss-Zusammenfassung
- `_coordinatorAnswer()` -- Koordinator beantwortet Agenten-Frage (mit Kontext)
- `_coordinatorInterimReport()` -- Zwischenbericht nach N Agenten
- `_runAgent()` -- Agent-Loop: Arbeit -> Frage? -> Koordinator -> weiter (max N Runden)
- `_verifyAgent()` -- Optionale Qualitaetspruefung per Claude-Aufruf
- `_scoreAgent()` -- Qualitaets-Score berechnen (0-100, 5 Kategorien)
- `_mergeOutputs()` -- Dateien in `merged/` zusammenfuehren (mit Konflikt-Handling)
- `setIntervention()` -- Intervention fuer Agent einreihen (5 Typen)
- `retryAgent()` -- Fehlgeschlagenen Agent erneut ausfuehren
- `getPrompts()` / `updatePrompts()` / `resetPrompts()` -- Prompt-Template CRUD
- `getConfig()` / `updateConfig()` -- Laufzeit-Konfiguration
- `getState()` -- Aktuellen Zustand mit Token-Aggregation zurueckgeben
- `getLastMergeResult()` -- Letztes Merge-Ergebnis abfragen
- `_saveState()` / `_saveStateImmediate()` -- State auf Disk speichern (gedrosselt, Delta-Write via djb2 Hash)
- `_createCheckpoint()` -- Checkpoint fuer Crash-Recovery erstellen
- `_detectCrashRecovery()` -- Statisch: Pruefen ob Recovery moeglich (Checkpoint vorhanden)
- `_discardCheckpoints()` -- Statisch: Checkpoints verwerfen
- `_logActivity()` -- Activity-Feed Eintrag erstellen
- `_runHook()` -- Optionale Hook-Funktionen ausfuehren
- `_sendWebhook()` -- Legacy Webhook-Benachrichtigungen senden
- `estimateTokens()` / `estimateCost()` / `accumulateTokenUsage()` -- Token-Tracking
- `sanitizeInput()` / `sanitizeError()` / `validateWorkDir()` -- Eingabe-Validierung
- `trimHistory()` -- Konversations-Historie auf Token-Limit kuerzen
- `djb2Hash()` -- Schneller String-Hash fuer Delta-Write Erkennung
- `checkClaudeCli()` -- CLI-Verfuegbarkeit + Versions-Check
- `_runClaudeSDKWrapper()` -- SDK-basierte Ausfuehrung mit Streaming, Abort, Token-Tracking, CLI-Fallback bei Fehler
- `checkClaudeSDK()` -- SDK-Verfuegbarkeit async pruefen

### src/claude-sdk.js
- `detectSDK()` -- Prueft ob @anthropic-ai/claude-code SDK installiert ist (dynamischer Import, gecached)
- `runClaudeSDK()` -- Fuehrt Prompt via SDK aus (AbortController, Timeout, Streaming-Callback)
- `isSDKAvailable()` -- Synchroner Check ob SDK verfuegbar (cached, null wenn noch nicht geprueft)
- `getSDKInfo()` -- SDK-Versionsinformationen abrufen

### src/git-integration.js (Klasse `GitIntegration`)
- `checkGit()` -- Git-Verfuegbarkeit pruefen
- `initRepo()` -- Git-Repository initialisieren
- `createProjectBranch()` -- Projekt-Branch erstellen und wechseln
- `copyMergedFiles()` -- Merged-Dateien ins Git-Verzeichnis kopieren
- `commit()` -- Stage + Commit erstellen
- `push()` -- Zum Remote pushen
- `getStatus()` -- Git-Status abfragen
- `getLog()` -- Commit-Historie abfragen
- `getCommitDiff()` -- Diff fuer einen Commit
- `commitProjectResults()` -- Vollstaendiger Git-Workflow (Branch -> Copy -> Commit -> Push)

### server.js

- Differenziertes Rate-Limiting: 4 Limiter-Stufen (`apiReadLimiter`, `apiLimiter`, `startLimiter`, `exportLimiter`)
- Auth-Middleware mit timing-safe Vergleich (`crypto.timingSafeEqual`)
- Security Headers: CSP, X-Content-Type-Options, X-Frame-Options, HSTS, Permissions-Policy
- Input-Sanitierung Middleware (Content-Type Validierung, String-Trimming)
- WebSocket Server (`ws` Modul, noServer-Modus, Upgrade-Handler auf `/ws`)
- SSE Event-Batching (`queueBroadcast`, 100ms Intervall)
- SSE Reconnect-Recovery ueber `Last-Event-ID` Header (max 200 Events, max 50 nachgeliefert)
- SSE Idle-Timeout: Clients nach 5 Minuten ohne Aktivitaet entfernen
- Dual-Broadcast: Events gehen an SSE + WebSocket Clients
- Performance-Metriken: Request-Counting, Response-Timing pro Endpoint, CPU-Usage
- Race-Condition Schutz (`isStarting`, `isResuming` Flags)
- Graceful Shutdown (SIGTERM/SIGINT) mit Checkpoint-Erstellung
- Path-Traversal-Schutz auf allen Datei-Endpoints
- Analytics-Cache (60s TTL)
- Webhook-Dispatching mit HMAC-SHA256 Signatur und Retry
- Project Queue mit Auto-Dequeue, Prioritaeten und exponential Backoff bei Fehlern
- Durchschnittliche Projektdauer-Tracking fuer geschaetzte Wartezeiten
- Modulare Route-Handler in `src/routes/` (12 Module): agents, analytics, config, exports, files, git, health, projects, queue, snapshots, templates, webhooks
- Modulare Service-Layer in `src/`: API-Docs, Batch-Processor, Config-Profiles, Health-Monitor, I18n, Log-Search, Retry-Strategies, Snapshot-Manager, Template-Manager
- Rollen-Management (CRUD) mit Persistierung in roles.json
- Projekt-Archivierung und Tags
- Undo/Redo fuer Config- und Plan-Aenderungen
- Swagger UI Integration unter /api/docs/ui/

### public/index.html

- `connect()` -- SSE mit Auto-Reconnect (exponential backoff, max 10 Versuche)
- `render()` / `updateAgent()` / `appendMessage()` -- Incremental Rendering
- `filterAgents()` -- Status-Filter + Textsuche ueber Agenten
- `setViewMode()` -- Karten/Timeline/Graph umschalten
- `updateTimelineView()` / `updateGraphView()` -- Gantt + DAG Rendering
- `openModal()` / `openFileModal()` / `openSettings()` -- Modale Dialoge
- `abortProject()` / `resumeProject()` / `resetProject()` -- Projekt-Steuerung
- `renderTokenPanel()` -- Token-Verbrauch Visualisierung
- `renderActivityFeed()` -- Activity-Feed Panel
- `escapeHtml()` / `esc()` -- XSS-Schutz fuer HTML-Ausgabe
- `openLogViewer()` -- Server-Log-Viewer mit Filterung und Paginierung
- `getPrismLanguage()` -- Syntax-Highlighting Sprach-Erkennung fuer File-Viewer
- `showNotification()` -- Desktop-Notifications (Browser Notification API)
- `showToast()` -- Toast-Benachrichtigungen (nicht-blockierend, mit Typen)
- `updateRetryStrategyHint()` -- Retry-Strategie-Beschreibung in Einstellungen
- `saveDraft()` / `restoreDraft()` / `clearDraft()` -- Entwurf-Speicherung (localStorage)
- `archiveProject()` / `unarchiveProject()` -- Projekt-Archivierung
- `toggleFavorite()` / `isFavorite()` -- Projekt-Favoriten (localStorage)
- `addProjectTag()` / `removeProjectTag()` -- Projekt-Tags (localStorage)
- `getProjectNote()` / `saveProjectNote()` / `toggleNoteEditor()` -- Projekt-Notizen
- `copyToClipboard()` -- Clipboard-Kopieren mit Toast-Feedback
- `undoConfig()` / `redoConfig()` / `undoPlan()` / `redoPlan()` -- Undo/Redo
- `toggleDoNotDisturb()` -- Nicht-Stoeren-Modus
- Sound-Benachrichtigungen (Web Audio API) + Desktop Notifications

## Frontend-Features

- **3 Ansichten**: Karten, Timeline/Gantt, DAG-Graph (SVG)
- **Dark/Light Mode** mit System-Praeferenz-Erkennung (`prefers-color-scheme`)
- **Prompt Engineering Studio** in Einstellungen
- **Analytics Dashboard** (Taste 'n')
- **Token-Nutzung** mit Balkendiagramm pro Agent
- **Activity Feed** (chronologisches Event-Log)
- **Server-Log-Viewer** (Taste 'l'): Filterung nach Level/Kategorie, Paginierung, JSONL-Export
- **Projekt-Warteschlange** (bis 10 Projekte, Prioritaeten, Drag&Drop)
- **Agent-Intervention** (5 Typen: redirect, skip, restart, inject, complete)
- **Conversation Inspector** (Tabs: Verlauf, Prompts, Dateien)
- **Projekt-Vergleich** (2 Projekte nebeneinander)
- **Bulk-Operationen** (Mehrfach-Auswahl, Loeschen, Export)
- **Export**: ZIP, JSON, Markdown, PDF
- **Syntax-Highlighting** (Prism.js): JS, TS, Python, JSON, CSS, Bash, Markdown, HTML im File-Viewer
- **Retry-Strategy UI**: Strategie-Auswahl in Einstellungen mit Beschreibung
- **Sound-Benachrichtigungen** (Web Audio API)
- **Desktop-Notifications**: Native Browser-Notifications (Projekt fertig, Agent-Fehler, Agent-Fragen)
- **Toast-Benachrichtigungen**: Nicht-blockierende Meldungen fuer Aktionen, Tastenkuerzel, Fehler
- **Nicht-Stoeren-Modus**: Temporaerer DnD-Modus unterdrueckt Sound und Desktop-Notifications
- **Projekt-Archivierung**: Archivieren/Entarchivieren mit visueller Abdimmung und Filter
- **Projekt-Tags**: Farbige Tags pro Projekt, Tag-basierte Filterung in Historie
- **Projekt-Favoriten**: Stern-Markierung mit Sortierung (localStorage)
- **Projekt-Notizen**: Inline-Editor fuer Freitext-Notizen pro Projekt (localStorage)
- **Draft-Modus**: Entwurf speichern/wiederherstellen fuer Projekt-Setup (localStorage)
- **Clipboard-Kopieren**: Projekt-ID und Code-Bloecke per Klick kopieren
- **Druckansicht** (`@media print`)
- **Mobile Responsive + Accessibility** (ARIA-Attribute, Media Queries)

## Konventionen

- Deutsch fuer alle Prompts, UI-Texte und Kommentare
- Alle Claude-Aufrufe gehen durch `runClaude()` in orchestrator.js
- SSE-Events ueber `orchestrator.emit(eventName, data)` senden
- Agent-Dateien in `projects/{projectId}/agent-{n}/`
- Konfiguration ueber Environment-Variablen (siehe `.env.example`)
- Async File I/O bevorzugen (`fs/promises`), keine sync fs-Aufrufe in server.js
- Tests in `__tests__/`, ausfuehrbar mit `npm test`
- Hooks in optionaler `hooks.js` (siehe `hooks.example.js`)
- Fehler in Hooks, Webhooks und nicht-kritischen Schritten duerfen nie crashen
- XSS-Schutz: Alle dynamischen Inhalte im Frontend durch `escapeHtml()` / `esc()` escapen
- Path-Traversal-Schutz auf allen Datei-Endpoints im Server
- Input-Sanitierung gegen Prompt Injection (`sanitizeInput()`)
- Intervention-Typen muessen aus `VALID_INTERVENTION_TYPES` stammen
- Webhook-Secrets mindestens 8 Zeichen, Signatur per HMAC-SHA256
- Neue Service-Module in `src/` ablegen, nicht in server.js direkt
- Neue API-Tests erhalten eigene Ports (3196+) um Konflikte zu vermeiden
- Snapshots, Profile und Templates in eigenen Verzeichnissen persistieren (JSON)
- Retry-Strategien als benannte Konfigurationen, nicht hardcoded
