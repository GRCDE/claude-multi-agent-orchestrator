# Claude Multi-Agent Orchestrator

Multi-Agent System mit GUI – powered by Claude Code CLI.

## Voraussetzungen

```
Node.js >= 18        https://nodejs.org
Claude Code CLI      npm install -g @anthropic-ai/claude-code
                     claude login
```

## Starten (Windows)

```
start.bat
```
→ Öffnet automatisch http://localhost:3131

## Starten (manuell)

```bash
npm install
node server.js
# Browser: http://localhost:3131
```

## Wie es funktioniert

```
Browser GUI (port 3131)
      ↕ SSE / REST
Express Server (server.js)
      ↕ child_process
Claude Code CLI  →  echte Dateien auf Festplatte
```

1. Du beschreibst dein Projekt im Browser
2. **Koordinator** (Claude Code) plant N parallele Aufgaben
3. Jeder **Agent** (Claude Code) arbeitet in `projects/{id}/agent-{n}/`
4. Agenten können **Rückfragen** stellen → Koordinator antwortet
5. Outputs: echte Dateien in `projects/`

## Outputs

Jedes Projekt erstellt:
```
projects/
└── proj_1234567890/
    ├── project.md          ← Projektübersicht
    ├── agent-1/
    │   ├── task.md         ← Aufgabenbeschreibung
    │   ├── transcript.md   ← Dialog-Verlauf
    │   └── (alle Dateien die Agent 1 erstellt)
    ├── agent-2/
    └── agent-3/
```

## Einstellungen

`.env` Datei (optional):
```
PORT=3131
```
