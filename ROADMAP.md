# Feature-Roadmap: Claude Multi-Agent Orchestrator

> Letzte Aktualisierung: 2026-04-07
> Version: 4.2.1
> Basierend auf Vergleich mit CrewAI, AutoGen, MetaGPT, OpenHands, LangGraph und Claude-Code-spezifischen Orchestratoren

---

## Ist-Zustand: Implementierte Features

### Phase 1: MVP (✅ Vollstaendig abgeschlossen)

| Feature | Status | Implementierung |
|---|---|---|
| Parallele Agent-Ausfuehrung | ✅ | Semaphore-basiert, konfigurierbar (1-10) |
| Live-Streaming von Agent-Output | ✅ | SSE + WebSocket, 100ms Event-Batching |
| Error Recovery pro Agent | ✅ | Auto-Retry (1x, 10s Delay), manueller Retry, 5 Intervention-Typen |
| State Persistence | ✅ | Delta-Write (djb2 Hash), Checkpoint-Rotation (max 3) |
| Projekt-Historie | ✅ | Vollstaendige Historie mit Score, Tokens, Archivierung, Tags |

### Phase 2: Differenzierung (✅ Vollstaendig abgeschlossen)

| Feature | Status | Implementierung |
|---|---|---|
| Claude Native Subagent-Integration (SDK) | ✅ | Dual-Modus: CLI/SDK/Auto, @anthropic-ai/claude-code |
| Inter-Agent Communication | ✅ | Shared Context Board, Nachrichten (max 3/Agent), Shared Files |
| Agent-Rollen mit Personas | ✅ | Rollen-CRUD (roles.json), Koordinator vergibt Rollen |
| Live-Dateibaum + Datei-Preview | ✅ | Rekursiver Dateibaum, Syntax-Highlighting (Prism.js, 7 Sprachen) |
| Human-in-the-Loop | ✅ | Plan-Approval, 5 Intervention-Typen (redirect/skip/restart/inject/complete), Auto-Intervention |
| Token/Cost-Tracking | ✅ | Pro Agent + Gesamt, Budget-Limits, Kosten-Warnschwellen, Pricing-API |

### Phase 3: Production-Ready (✅ Groesstenteils abgeschlossen)

| Feature | Status | Implementierung |
|---|---|---|
| Authentifizierung | ✅ | Bearer Token (timing-safe crypto.timingSafeEqual), Security Headers (CSP, HSTS, etc.) |
| Webhook/CI-Integration | ✅ | CRUD, HMAC-SHA256, 9 Event-Typen, Retry, Delivery-Log |
| Plugin/Hook-System | ✅ | Hook-Funktionen (beforePlan, afterAgent, etc.), hooks.js optional |
| Observability + Logging | ✅ | Winston, strukturierte Logs, Log-Rotation, Log-Viewer (UI + API), JSONL-Export |
| Projekt-Templates + Meilensteine | ✅ | Templates CRUD, Managed Templates (Rating, Duplikation), Meilenstein-Modus |
| Sandbox/Isolation | ⚠️ Teilweise | Verzeichnis-basiert (shared/strict Modi), kein Docker pro Agent |
| Multi-User | ❌ Offen | Nur Single-Token Auth, keine User-Trennung |

### Phase 4: Enterprise + UX (✅ Vollstaendig abgeschlossen)

| Feature | Status | Implementierung |
|---|---|---|
| Modulare Server-Architektur | ✅ | 11 Route-Module in src/routes/, 10 Service-Module in src/ |
| Erweiterte Analytics | ✅ | Timeline, Rollen, Kosten, Top-Projekte, Verteilung (60s Cache) |
| Crash-Recovery | ✅ | Checkpoint-Rotation (max 3), Auto-Erkennung, Restore/Discard API |
| Projektuebergreifende Suche | ✅ | Volltextsuche (Titel, Conversations, Dateien), Suggestions, Re-Indexing |
| API-Dokumentation | ✅ | Auto-generiert (JSON, OpenAPI 3.0, Markdown, Swagger UI) |
| Batch-API | ✅ | Mehrere Requests in einem Batch, Statistiken, Blocked-Liste |
| Config-Profile | ✅ | CRUD, Import/Export, Apply, Save-Current |
| Snapshot-Manager | ✅ | Erstellen, Vergleichen, Wiederherstellen, Loeschen |
| Undo/Redo | ✅ | Fuer Config- und Plan-Aenderungen |
| Retry-Strategien | ✅ | fixed, exponential, linear u.a. -- per API waehlbar |
| I18n | ✅ | Mehrsprachige Uebersetzungen, GET /api/i18n/:lang |
| Desktop-Notifications | ✅ | Native Browser Notifications (Abschluss, Fehler, Fragen) |
| Toast-Benachrichtigungen | ✅ | Nicht-blockierend, mit Typen und Icons |
| Projekt-Archivierung | ✅ | Archivieren/Entarchivieren, visuelle Abdimmung, Filter |
| Projekt-Tags + Favoriten + Notizen | ✅ | Tag-CRUD, Stern-Markierung, Inline-Editor (localStorage) |
| Draft-Modus | ✅ | Entwurf speichern/wiederherstellen (localStorage) |
| PDF-Export | ✅ | GET /api/export-pdf/:id |
| Nicht-Stoeren-Modus | ✅ | Unterdrueckt Sound + Desktop-Notifications |
| Clipboard-Kopieren | ✅ | Projekt-ID, Texte, Code-Bloecke per Klick |
| Differenziertes Rate-Limiting | ✅ | 4 Limiter-Stufen (Read/Mutation/Start/Export) |
| Performance-Metriken-API | ✅ | CPU, Memory, Endpoint-Timings, Realtime |
| Project Queue | ✅ | Bis 10 Projekte, Prioritaeten, Auto-Dequeue, Wartezeit-Schaetzung |
| 3 Ansichten im Frontend | ✅ | Karten, Timeline/Gantt, DAG-Graph (SVG) |
| Projekt-Scoring | ✅ | 5 Kategorien, 0-100, pro Agent + Gesamt |

---

## Wettbewerber-Vergleich (Aktualisiert April 2026)

### Wo dieses Projekt FUEHRT

1. **Claude-Code-Native**: Einziger Orchestrator mit CLI + SDK Dual-Modus fuer Claude Code -- direkte Integration statt Wrapper
2. **Zero-Build Web-UI**: 13.600 Zeilen Vanilla JS, kein Build-Step, kein Framework, 3 Ansichten (Karten/Timeline/DAG-Graph)
3. **Vollstaendige REST API**: 125 Endpoints, OpenAPI 3.0, Swagger UI, automatisch generierte Docs
4. **Windows-First**: Vollstaendig getestet auf Windows, start.bat, Windows-Pfade korrekt behandelt
5. **Extreme Testabdeckung**: 115+ Test-Suites (Unit, API, E2E, Integration) -- mehr als die meisten Open-Source-Alternativen
6. **Vollstaendiges Ecosystem**: Webhooks, Templates, Meilensteine, Snapshots, Profile, Rollen, Budget, Undo/Redo -- alles inklusive

### Wo Wettbewerber fuehren

1. **Docker-Sandbox pro Agent** (OpenHands): Echte Container-Isolation -- Agenten laufen mit `--dangerously-skip-permissions`, kein Containment
2. **Multi-User + Rollen** (CrewAI Enterprise): Team-basierte Zugriffskontrolle, getrennte Projekt-Spaces, SSO
3. **RAG/Semantische Code-Indexierung** (claude-mpm, ruflo): Automatische Kontext-Anreicherung aus Codebasen, Embeddings
4. **Git-Integration** (OpenHands, ComposioHQ): Automatisches Committing, Branch pro Projekt, PR-Erstellung, Merge-Conflict-Handling
5. **Cross-Language + Plugin-Marketplace** (AutoGen, LangGraph): Groessere Ecosystem-Integration, Community-Plugins

---

## Noch offene Features

### Prioritaet HOCH

| Feature | Impact | Aufwand | Beschreibung |
|---|---|---|---|
| Docker-Sandbox pro Agent | HOCH | Gross (~12h) | Container-basierte Isolation statt nur Verzeichnis-Trennung. Optional (`SANDBOX_MODE=docker\|directory\|none`), Fallback auf bestehenden Modus |
| Multi-User + Rollen-Auth | HOCH | Gross (~16h) | Session-basiert, User-getrennte Projekte, Admin/User Rollen, Login-Screen |
| **Git-Integration** | ✅ | Mittel | Auto-Commit, Branch pro Projekt, Push, 11 API-Endpoints |

### Prioritaet MITTEL

| Feature | Impact | Aufwand | Beschreibung |
|---|---|---|---|
| RAG/Kontext-Anreicherung | MITTEL | Gross (~16h) | Automatische Code-Indexierung mit Embeddings, semantische Suche, Kontext-Injektion in Agent-Prompts |
| Agent-Memory (persistent) | MITTEL | Mittel (~6h) | Langzeit-Gedaechtnis ueber Projekte hinweg -- Agenten lernen aus frueheren Ausfuehrungen |
| MCP-Server Integration | MITTEL | Mittel (~6h) | Agenten koennen MCP-Tools nutzen (Web-Suche, Datenbanken, externe APIs) |
| OpenTelemetry Traces | MITTEL | Mittel (~5h) | Distributed Tracing exportieren (Jaeger, Tempo), Span pro Agent-Runde |
| CI/CD Pipeline Integration | MITTEL | Klein (~3h) | GitHub Actions / GitLab CI Trigger -- Projekt starten bei PR/Issue-Event via Webhook |

### Prioritaet NIEDRIG (Nice-to-Have)

| Feature | Impact | Aufwand | Beschreibung |
|---|---|---|---|
| VS Code Extension | NIEDRIG | Mittel (~10h) | IDE-Integration: Projekt starten, Status sehen, Dateien direkt oeffnen ohne Web-Browser |
| Kubernetes-Support | NIEDRIG | Gross (~20h) | Skalierung ueber mehrere Nodes, Agent-Pods pro Projekt |
| Agent-Training/Feedback | NIEDRIG | Gross (~20h) | Scoring-Daten nutzen um Prompt-Templates automatisch zu verbessern |
| Mobile App | NIEDRIG | Gross (~30h) | Native Mobile-Steuerung (React Native oder PWA) |
| LangSmith/Phoenix Observability | NIEDRIG | Mittel (~4h) | Traces an externe Observability-Plattformen exportieren |

---

## Naechste 3 empfohlene Schritte

1. **Docker-Sandbox** (~12h) -- Optionale Container-Isolation pro Agent via `SANDBOX_MODE=docker`. Wichtig fuer Sicherheit bei unkontrolliertem Code-Ausfuehren. Fallback auf bestehenden Verzeichnis-Modus wenn Docker nicht verfuegbar.

2. **MCP-Server Integration** (~6h) -- Agenten koennen externe Tools (Web-Suche, Datenbanken, APIs) ueber das Model Context Protocol nutzen. Hebt die Qualitaet der Ergebnisse deutlich an, da Agenten nicht auf ihr Training-Wissen beschraenkt sind.

3. **Multi-User + Rollen-Auth** (~16h) -- Session-basierte Authentifizierung, User-getrennte Projekt-Spaces, Admin/User Rollen mit differenzierten Zugriffskontrolle. Essentiell fuer Team-Nutzung in Enterprise-Umgebungen.

---

## Projektstatistiken

| Metrik | Wert |
|---|---|
| Gesamtcode | ~24.000 Zeilen |
| orchestrator.js | ~4.300 Zeilen |
| server.js | ~2.455 Zeilen |
| src/routes/ | ~3.640 Zeilen (11 Module) |
| src/ Services | ~10 Module |
| public/index.html | ~13.600 Zeilen |
| API Endpoints | 125 (REST + SSE + WebSocket) |
| SSE + WebSocket Events | 30+ Event-Typen |
| Test-Suites | 115+ (31 Unit, 58 API, 24 E2E, 1 Integration) |
| Tastenkuerzel | 12 |
| Umgebungsvariablen | 25+ |
| Rate-Limiter Stufen | 4 (Read 120/min, Mutation 30/min, Start 3/min, Export 10/min) |
| Max SSE Clients | 50 gesamt, 5 pro IP |
| Max Queue-Groesse | 10 Projekte |
| Checkpoint-Rotation | 3 (Crash-Recovery) |
| Version | 4.2.1 |

---

## Quellen

- [CrewAI](https://crewai.com/) -- Multi-Agent Platform
- [Microsoft AutoGen / Agent Framework](https://github.com/microsoft/autogen)
- [MetaGPT](https://github.com/FoundationAgents/MetaGPT)
- [OpenHands](https://github.com/OpenHands/OpenHands)
- [LangGraph](https://www.langchain.com/langgraph)
- [Claude Code SDK](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
- [claude-mpm](https://github.com/bobmatnyc/claude-mpm)
- [ruflo](https://github.com/ruvnet/ruflo)
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
