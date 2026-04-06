# Claude Multi-Agent Orchestrator

Ein Multi-Agent System das grosse Projekte automatisch in Teilaufgaben aufteilt.
Ein Koordinator-Agent plant, Sub-Agenten arbeiten die Aufgaben ab und koennen
Rueckfragen an den Koordinator stellen. Alles laeuft ueber Claude Code CLI.

## Schnellstart

```bash
npm install
node server.js
# Dann http://localhost:3131 oeffnen
```

Oder unter Windows: `start.bat` doppelklicken.

## Docker

### Image bauen und starten

```bash
# Image bauen
npm run docker:build

# Container starten (im Hintergrund)
npm run docker:run

# Oder direkt mit docker compose
docker compose up -d
```

### Umgebungsvariablen

Der Container liest Umgebungsvariablen aus einer `.env`-Datei. Beispiel:

```env
PORT=3131
```

### Projekt-Daten

Das `projects/`-Verzeichnis wird als Volume gemountet, sodass Agent-Outputs
auch nach einem Container-Neustart erhalten bleiben.

### Health Check

Der Container prueft automatisch alle 30 Sekunden den `/health`-Endpoint.
Status abfragen:

```bash
docker compose ps
```

### Container stoppen

```bash
docker compose down
```
