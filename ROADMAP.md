# Feature-Roadmap: Claude Multi-Agent Orchestrator

> Analyse-Datum: 2026-04-06
> Basierend auf Vergleich mit CrewAI, AutoGen/Microsoft Agent Framework, MetaGPT, OpenHands, LangGraph und Claude-Code-spezifischen Orchestratoren

---

## Ist-Zustand: Was das Projekt kann

| Feature | Status |
|---|---|
| Koordinator plant N Aufgaben via Claude CLI | Vorhanden |
| Sub-Agenten arbeiten sequenziell | Vorhanden |
| Rückfrage-Mechanismus (Agent fragt Koordinator) | Vorhanden |
| Rate-Limit Erkennung + Exponential Backoff | Vorhanden |
| Konfigurierbarer Timeout (AGENT_TIMEOUT) | Vorhanden |
| CLI-Verfuegbarkeitspruefung | Vorhanden |
| Web-UI mit SSE Live-Updates | Vorhanden |
| Kein Build-Step, Vanilla JS | Vorhanden |
| Projekt-Dateien auf Festplatte | Vorhanden |

**Gesamtumfang: ~400 Zeilen Code (orchestrator + server + frontend)**

---

## Wettbewerber-Vergleich

### 1. CrewAI (Python, 45.9k Stars)
- **Staerken**: Rollen-basierte Agenten (Role/Goal/Backstory), 100+ eingebaute Tools, Memory-System (Short-term/Long-term/Entity), Observability-Dashboard, Sequential + Hierarchical Prozesse, Agent-Training
- **Was fehlt hier**: Kein Memory-System, keine Tool-Integration, kein Observability, keine Rollen-Definition

### 2. Microsoft AutoGen / Agent Framework (.NET + Python, 40k+ Stars)
- **Staerken**: Async Event-Driven Architektur, Cross-Language Support, AutoGen Studio (No-Code GUI), Benchmarking-Suite, Pluggable Components
- **Was fehlt hier**: Keine async/parallele Ausfuehrung, kein Plugin-System, kein Benchmarking

### 3. MetaGPT (Python, 48k Stars)
- **Staerken**: Software-Company-Simulation (PM, Architect, Engineer), SOPs als Prompt-Ketten, generiert PRD + Design + Code + Tests aus einem Satz, strukturierte Agenten-Kommunikation
- **Was fehlt hier**: Keine strukturierten Rollen, kein SOP-System, keine Artefakt-Kette

### 4. OpenHands/OpenDevin (Python, 70k Stars)
- **Staerken**: Sandboxed Docker-Umgebung, Browser-Automation, Terminal-Zugriff, Git/PR-Integration, Kubernetes-Support, Planning Mode
- **Was fehlt hier**: Keine Sandbox/Isolation, keine Git-Integration, kein Planning Mode

### 5. LangGraph (Python/JS, LangChain)
- **Staerken**: Graph-basierte Orchestrierung, State Checkpointing, Time-Travel Debugging, Human-in-the-Loop, Per-Node Token Streaming, LangSmith Observability
- **Was fehlt hier**: Kein State Management, kein Checkpointing, kein Streaming pro Agent

### 6. Claude-Code-spezifische Konkurrenz (direkte Wettbewerber!)
- **oh-my-claudecode**: Team-first Orchestrierung, nutzt Claude Codes eingebaute Subagent-API
- **claude-mpm**: Multi-Channel Orchestrierung, MCP-Integration, Semantic Code Search
- **ruflo**: Enterprise-Grade Swarm-Intelligence, RAG-Integration
- **ComposioHQ/agent-orchestrator**: Parallele Agents, CI-Fix-Automatisierung, Merge-Conflict-Handling

---

## Was dieses Projekt einzigartig macht

1. **Extreme Einfachheit**: ~400 Zeilen, kein Build-Step, kein Python, kein Docker -- `npm install && node server.js` und fertig
2. **Claude CLI als einzige Dependency**: Kein API-Key-Management, keine SDK-Versionen, nutzt was der User eh installiert hat
3. **Live-Web-UI out of the box**: Sofort visuelles Feedback, SSE-basiert, keine WebSocket-Komplexitaet
4. **Rückfrage-Mechanismus**: Agenten koennen den Koordinator fragen -- das haben die wenigsten Frameworks so direkt implementiert
5. **Windows-First**: start.bat, Windows-Pfade getestet -- die meisten Konkurrenten sind Linux/Mac-fokussiert

---

## Was FEHLT (nach Wettbewerbsvergleich)

### Kritische Luecken (alle Konkurrenten haben das)
- Parallele Agent-Ausfuehrung
- Agent Memory / Kontext-Sharing zwischen Agenten
- State Persistence (Projekt fortsetzen nach Absturz)
- Error Recovery (Agent neu starten statt Projekt abbrechen)
- Streaming (Agent-Output live sehen, nicht erst am Ende)

### Wichtige Luecken (die meisten Konkurrenten haben das)
- Tool-System fuer Agenten (Web-Suche, Datei-Lesen, API-Aufrufe)
- Human-in-the-Loop (manuell eingreifen waehrend Agenten arbeiten)
- Observability / Logging / Token-Tracking
- Git-Integration (Ergebnisse committen)
- Export-Funktion (ZIP, Git-Repo)

### Nice-to-Have (differenzierend)
- Projekt-Templates / Meilenstein-Modus
- Agent-Rollen mit Personas
- Dependency-Graph zwischen Agenten
- Cost-Tracking (Token-Verbrauch pro Agent)

---

## Feature-Roadmap

### Phase 1: MVP-Verbesserungen (MUSS REIN)

> Ziel: Stabiles, nutzbares Tool das man vorzeigen kann

#### 1.1 Parallele Agent-Ausfuehrung
**Warum**: Jeder Konkurrent kann das. Sequenziell ist 3-5x langsamer.
**Umsetzung**:
```
// orchestrator.js - start() Methode aendern
// Statt for-loop: Promise.allSettled mit Concurrency-Limit

const pLimit = require('p-limit');
const limit = pLimit(3); // max 3 parallel, Rate-Limit-safe

await Promise.allSettled(
  this.tasks.map((_, i) => limit(() => this._runAgent(i)))
);
```
**Aufwand**: ~2h, eine Dependency (p-limit), Aenderung in orchestrator.js
**Hinweis**: Claude Code erlaubt nativ max 7 parallele Subagenten

#### 1.2 Live-Streaming von Agent-Output
**Warum**: User sieht minutenlang nichts, dann alles auf einmal. Frustrierend.
**Umsetzung**:
- `runClaude()` schickt stdout-Chunks per Callback statt alles am Ende
- Neues SSE-Event `agent_stream` mit `{ index, chunk }`
- Frontend: Bubble wird live gefuellt statt erst bei Completion
```
// Aenderung in runClaude():
proc.stdout.on('data', d => {
  out += d.toString();
  if (emitter) emitter.emit('agent_stream', { chunk: d.toString() });
});
```
**Aufwand**: ~3h, keine neue Dependency

#### 1.3 Error Recovery pro Agent
**Warum**: Ein fehlgeschlagener Agent killt aktuell das Gefuehl dass das Tool funktioniert.
**Umsetzung**:
- Agent-Fehler loggen aber weitermachen (ist teilweise schon so)
- Neuer Button im UI: "Agent X neu starten"
- POST `/api/retry/:agentIndex` Endpoint
- Orchestrator: `retryAgent(idx)` Methode die `_runAgent(idx)` erneut aufruft
**Aufwand**: ~2h

#### 1.4 State Persistence
**Warum**: Browser-Refresh = alles weg. Server-Neustart = alles weg.
**Umsetzung**:
- `state.json` in `projects/{id}/` schreiben nach jedem Status-Update
- Beim Server-Start: letztes Projekt aus `projects/` laden
- GET `/api/projects` listet alle bisherigen Projekte
```
// Nach jedem emit() in orchestrator.js:
fs.writeFileSync(
  path.join(this.projectDir, 'state.json'),
  JSON.stringify(this.getState(), null, 2)
);
```
**Aufwand**: ~3h

#### 1.5 Projekt-Historie im GUI
**Warum**: Man will alte Projekte wiedersehen.
**Umsetzung**:
- GET `/api/projects` → `fs.readdirSync('projects/')` + `state.json` pro Projekt lesen
- Sidebar oder Dropdown im Setup-Screen
- Klick laedt alten State
**Aufwand**: ~2h

**Phase 1 Gesamt: ~12h Arbeit, minimale Dependencies**

---

### Phase 2: Differenzierung (WAS MACHT DAS PROJEKT BESONDERS)

> Ziel: Features die kein anderer Claude-Code-Orchestrator so hat

#### 2.1 Claude Native Subagent-Integration
**Warum**: Claude Code hat seit 2025 eingebaute Subagenten (`claude --subagent`). Statt CLI-Spawning koennte man das nutzen fuer bessere Performance und Kontext-Sharing.
**Umsetzung**:
- Claude Code SDK / Subagent-API evaluieren
- Fallback auf CLI-Spawning wenn SDK nicht verfuegbar
- Vorteil: Subagenten teilen Kontext, brauchen weniger Tokens
**Aufwand**: ~6h Recherche + Implementation

#### 2.2 Inter-Agent Communication
**Warum**: Agenten arbeiten aktuell komplett isoliert. CrewAI/MetaGPT haben Agent-zu-Agent Kommunikation.
**Umsetzung**:
- Shared Context File: `projects/{id}/shared-context.md` -- jeder Agent liest/schreibt
- Agent kann "NACHRICHT AN AGENT X: ..." schreiben
- Koordinator routet Nachrichten oder Agent liest direkt aus shared-context
- UI zeigt Inter-Agent-Kommunikation als eigene Lane
**Aufwand**: ~4h

#### 2.3 Agent-Rollen mit Personas
**Warum**: MetaGPT zeigt dass spezialisierte Rollen bessere Ergebnisse liefern.
**Umsetzung**:
- Koordinator vergibt nicht nur Aufgaben sondern auch Rollen:
  ```json
  {
    "title": "API Design",
    "role": "Senior Backend Architect",
    "expertise": "REST API Design, OpenAPI, Security",
    "task": "...",
    "deliverable": "..."
  }
  ```
- Agent-Prompt wird um Rolle/Expertise erweitert
- Optional: User kann Rollen im UI vordefinieren
**Aufwand**: ~2h (hauptsaechlich Prompt-Engineering)

#### 2.4 Live-Dateibaum + Datei-Preview
**Warum**: Man will sehen was Agenten produzieren, ohne Terminal zu oeffnen.
**Umsetzung**:
- GET `/api/files/:projectId` → rekursives `fs.readdirSync`
- GET `/api/file/:projectId/*` → Datei-Inhalt lesen
- UI: Collapsible Tree pro Agent, Klick zeigt Datei-Inhalt
- Bonus: Syntax-Highlighting mit Prism.js (CDN, kein Build noetig)
**Aufwand**: ~4h

#### 2.5 Human-in-the-Loop
**Warum**: LangGraph, CrewAI und AutoGen haben das alle. Kein ernsthaftes Tool ohne.
**Umsetzung**:
- Neuer Agent-Status: `awaiting_approval`
- Konfigurierbar: "Vor jedem Agenten-Start User fragen" oder "Nur bei Fragen"
- UI: Modal mit Agent-Plan, "Weiter" / "Aendern" / "Abbrechen" Buttons
- POST `/api/approve/:agentIndex` und POST `/api/intervene/:agentIndex`
- Orchestrator wartet auf Promise-Resolution
**Aufwand**: ~5h

#### 2.6 Token/Cost-Tracking
**Warum**: Niemand will 50 Dollar verbrauchen ohne es zu merken.
**Umsetzung**:
- Claude CLI Output parsen (Token-Usage wenn verfuegbar)
- Alternativ: Prompt-Laenge zaehlen als Schaetzung
- Pro Agent + Gesamt anzeigen
- Optional: Budget-Limit konfigurierbar, stoppt wenn erreicht
**Aufwand**: ~3h

**Phase 2 Gesamt: ~24h Arbeit**

---

### Phase 3: Production-Ready (FUER ECHTEN PRODUKTIV-EINSATZ)

> Ziel: Enterprise-tauglich, sicher, skalierbar

#### 3.1 Sandbox / Isolation
**Warum**: Agenten laufen aktuell mit `--dangerously-skip-permissions` und vollen Rechten.
**Umsetzung**:
- Docker-Container pro Agent (optional, wenn Docker installiert)
- Ohne Docker: Eigenes temp-Verzeichnis pro Agent, keine Schreibrechte ausserhalb
- Konfigurierbar: `SANDBOX_MODE=docker|directory|none`
- Permission-Whitelist pro Agent
**Aufwand**: ~8h

#### 3.2 Authentifizierung + Multi-User
**Warum**: Aktuell kann jeder der Port 3131 erreicht Projekte starten.
**Umsetzung**:
- Einfach: Basic Auth oder Token-basiert (`AUTH_TOKEN` Env-Variable)
- Fortgeschritten: Session-basiert mit Login-Screen
- Multi-User: Projekte pro User, getrennte Verzeichnisse
**Aufwand**: ~4h (Basic), ~12h (Multi-User)

#### 3.3 Webhook / CI-Integration
**Warum**: Automatisierte Workflows, nicht nur manuell im Browser.
**Umsetzung**:
- POST `/api/start` ist schon da -- dokumentieren als API
- Webhook-Callback wenn Projekt fertig: POST an konfigurierbare URL
- GitHub Actions Integration: Projekt starten bei PR/Issue
- Output als Git-Commit (optional)
**Aufwand**: ~4h

#### 3.4 Plugin-System
**Warum**: Erweiterbarkeit ohne Core-Code zu aendern.
**Umsetzung**:
- `plugins/` Verzeichnis, jedes Plugin ist ein JS-Modul
- Hooks: `beforePlan`, `afterPlan`, `beforeAgent`, `afterAgent`, `onQuestion`, `onComplete`
- Beispiel-Plugins: Git-Commit, Slack-Notification, Cost-Report
```js
// plugins/git-commit.js
module.exports = {
  name: 'git-commit',
  afterComplete: async (projectDir) => {
    execSync('git init && git add . && git commit -m "Agent output"', { cwd: projectDir });
  }
};
```
**Aufwand**: ~6h

#### 3.5 Observability + Structured Logging
**Warum**: Debugging in Production ist unmoeglich ohne Logs.
**Umsetzung**:
- Structured JSON Logs (Winston oder Pino)
- Log-Levels: debug/info/warn/error
- Pro-Agent Log-Files in `projects/{id}/agent-{n}/logs/`
- Optional: OpenTelemetry Traces exportieren
- UI: Log-Viewer mit Filter pro Agent/Level
**Aufwand**: ~5h

#### 3.6 Projekt-Templates / Meilenstein-Modus
**Warum**: Wiederholbare Workflows fuer Teams.
**Umsetzung**:
- `templates/` Verzeichnis mit JSON-Dateien
- Template definiert: Agenten-Anzahl, Rollen, Aufgaben, Reihenfolge
- UI: Template-Auswahl statt Freitext
- Meilensteine: Zwischenschritte mit Approval-Gates
```json
{
  "name": "REST API Projekt",
  "agents": [
    { "role": "API Designer", "task": "OpenAPI Spec erstellen", "deliverable": "openapi.yaml" },
    { "role": "Backend Dev", "task": "Express Server implementieren", "dependsOn": [0] },
    { "role": "Tester", "task": "Jest Tests schreiben", "dependsOn": [1] }
  ]
}
```
**Aufwand**: ~6h

**Phase 3 Gesamt: ~45h Arbeit**

---

## Prioritaets-Matrix

| Feature | Impact | Aufwand | Prioritaet |
|---|---|---|---|
| Parallele Agents | HOCH | Klein | Phase 1 - SOFORT |
| Live-Streaming | HOCH | Klein | Phase 1 - SOFORT |
| Error Recovery | HOCH | Klein | Phase 1 - SOFORT |
| State Persistence | HOCH | Klein | Phase 1 - SOFORT |
| Projekt-Historie | MITTEL | Klein | Phase 1 |
| Agent-Rollen/Personas | HOCH | Klein | Phase 2 |
| Human-in-the-Loop | HOCH | Mittel | Phase 2 |
| Live-Dateibaum | MITTEL | Klein | Phase 2 |
| Inter-Agent Comm. | MITTEL | Mittel | Phase 2 |
| Token-Tracking | MITTEL | Klein | Phase 2 |
| Native Subagents | HOCH | Mittel | Phase 2 |
| Sandbox/Isolation | HOCH | Gross | Phase 3 |
| Auth + Multi-User | MITTEL | Mittel | Phase 3 |
| Plugin-System | MITTEL | Mittel | Phase 3 |
| Templates | MITTEL | Mittel | Phase 3 |
| Observability | MITTEL | Mittel | Phase 3 |
| CI/Webhook | NIEDRIG | Klein | Phase 3 |

---

## Empfehlung: Naechste 3 Schritte

1. **Parallele Agents einbauen** (2h) -- groesster Impact, kleinster Aufwand. Einfach `p-limit` + `Promise.allSettled`.

2. **Live-Streaming** (3h) -- verwandelt das Tool von "warten und hoffen" zu "live zusehen". Riesiger UX-Unterschied.

3. **State Persistence** (3h) -- ohne das verliert man bei jedem Browser-Refresh alles. Dealbreaker fuer echte Nutzung.

Diese drei Features zusammen (~8h) heben das Projekt von "cooles Experiment" auf "taeglich nutzbares Tool".

---

## Quellen

- [CrewAI](https://crewai.com/) -- Multi-Agent Platform, 45.9k Stars
- [Microsoft AutoGen / Agent Framework](https://github.com/microsoft/autogen) -- Async Multi-Agent, 40k+ Stars
- [MetaGPT](https://github.com/FoundationAgents/MetaGPT) -- Software Company Simulation, 48k Stars
- [OpenHands](https://github.com/OpenHands/OpenHands) -- AI-Driven Development, 70k Stars
- [LangGraph](https://www.langchain.com/langgraph) -- Graph-based Agent Orchestration
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) -- Team-first Claude Code Orchestration
- [claude-mpm](https://github.com/bobmatnyc/claude-mpm) -- Multi-Agent Project Manager fuer Claude
- [ruflo](https://github.com/ruvnet/ruflo) -- Enterprise Claude Swarm Orchestration
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) -- Parallel Coding Agents
- [Claude Code Subagent Docs](https://code.claude.com/docs/en/sub-agents) -- Native Subagent API
- [Claude Code Sub-Agent Patterns](https://claudefa.st/blog/guide/agents/sub-agent-best-practices) -- Parallel vs Sequential
- [Multi-Agent Frameworks 2026 Vergleich](https://gurusup.com/blog/best-multi-agent-frameworks-2026)
- [Top 9 AI Agent Frameworks 2026](https://www.shakudo.io/blog/top-9-ai-agent-frameworks)
- [Agentic AI Frameworks Enterprise Guide](https://akka.io/blog/agentic-ai-frameworks)
