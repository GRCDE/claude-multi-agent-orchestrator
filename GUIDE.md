# Claude Multi-Agent Orchestrator -- User Guide

## 1. Quick Start

```bash
# 1. Abhaengigkeiten installieren
npm install

# 2. Server starten
node server.js

# 3. Browser oeffnen
# http://localhost:3131
```

Voraussetzungen: Node.js 18+, Claude Code CLI installiert und authentifiziert.

Alternative Startoptionen:
- `npm run dev` -- mit Auto-Reload
- `start.bat` -- Windows-Doppelklick
- `docker compose up -d` -- Docker

## 2. Erstes Projekt starten

1. Im Browser die Projektbeschreibung eingeben, z.B.: "Erstelle eine REST API mit Express.js fuer ein Todo-System mit CRUD, Auth und Tests."
2. Agenten-Anzahl waehlen (2-10). Faustregel: 1 Agent pro unabhaengige Teilaufgabe. Fuer eine REST API reichen 3-4 Agenten.
3. Optional: Template aus der Vorlagenliste waehlen (fuellt Beschreibung und Agenten-Anzahl vor).
4. "Projekt starten" klicken (oder Strg+Enter).

Der Koordinator-Agent analysiert die Beschreibung und erstellt automatisch einen Ausfuehrungsplan mit Aufgaben, Rollen und Abhaengigkeiten.

## 3. Plan-Approval

Nach der Planung wechselt das Projekt in den Status "Warte auf Genehmigung". Der Plan zeigt:

- **Aufgaben** mit Titel, Beschreibung und Rolle pro Agent
- **Abhaengigkeiten** (welcher Agent auf welchen wartet)
- **Geschaetzte Komplexitaet**

Optionen:
- **Genehmigen**: Plan so ausfuehren wie vorgeschlagen.
- **Bearbeiten**: Aufgaben aendern, hinzufuegen oder entfernen, dann genehmigen.
- **Ablehnen**: Projekt zuruecksetzen und neu planen.

Tipp: Plan-Approval kann in den Einstellungen deaktiviert werden (`requireApproval: false`), dann startet die Ausfuehrung sofort.

## 4. Agenten beobachten

Das Dashboard bietet drei Ansichten (umschaltbar oben rechts):

### Karten-Ansicht (Standard)
Jeder Agent als Karte mit Status-Badge, Fortschrittsbalken, Live-Output und Token-Verbrauch. Klick auf eine Karte oeffnet den Conversation Inspector mit Tabs fuer Verlauf, Prompts und Dateien.

### Timeline-Ansicht
Gantt-Diagramm mit zeitlichem Ablauf aller Agenten. Zeigt parallele Ausfuehrung, Wartezeiten und Abhaengigkeiten auf einen Blick.

### Graph-Ansicht
DAG (Directed Acyclic Graph) als SVG. Visualisiert Abhaengigkeiten zwischen Agenten als Knoten und Kanten. Nuetzlich bei komplexen Projekten mit vielen Abhaengigkeiten.

Status-Farben: Blau = arbeitet, Gelb = wartet/fragt, Gruen = fertig, Rot = Fehler, Grau = uebersprungen.

## 5. Intervention

Waehrend ein Agent arbeitet, kann man eingreifen. Klick auf "Intervenieren" bei einem Agenten oeffnet die Intervention mit 5 Typen:

| Typ | Wirkung | Beispiel |
|---|---|---|
| `redirect` | Agent bekommt neue Anweisung, arbeitet damit weiter | "Verwende PostgreSQL statt SQLite" |
| `skip` | Agent wird sofort uebersprungen | Agent braucht zu lange oder ist unnoetig |
| `restart` | Agent startet komplett neu | Agent hat sich verrannt |
| `inject` | Zusaetzlicher Kontext wird eingefuegt | "Die API laeuft auf Port 8080, nicht 3000" |
| `complete` | Agent wird als fertig markiert | Teilarbeit reicht aus |

Interventionen koennen jederzeit gesendet werden. Ist der Agent gerade in einer Runde, wird die Intervention in die Warteschlange eingereiht und bei der naechsten Gelegenheit angewendet.

## 6. Templates nutzen

Templates sind vorgefertigte Projekttypen, die beim Start angezeigt werden:

- **REST API** (4 Agenten) -- Express.js mit CRUD, Auth, Validierung, Tests
- **CLI Tool** (3 Agenten) -- Kommandozeilen-Tool mit Argument-Parsing
- **React App** (5 Agenten) -- TypeScript, Routing, State Management
- **Python ML Pipeline** (4 Agenten) -- Datenverarbeitung bis Deployment
- **Fullstack Web App** (5 Agenten) -- Frontend + Backend + DB + Docker

Templates verwalten:
- **Neue Vorlage**: Im Template-Bereich auf "+ Neue Vorlage" klicken.
- **Bearbeiten/Loeschen**: Buttons unter jeder Template-Karte.
- **Import/Export**: Templates als JSON exportieren und auf anderen Instanzen importieren.

## 7. Tastenkuerzel

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
| `Strg+Enter` | Projekt starten (im Setup) |

## 8. Einstellungen

### Laufzeit-Konfiguration
Ueber das Zahnrad-Icon oder `GET/POST /api/config`. Aenderbare Werte:
- `maxParallelAgents` -- Gleichzeitige Agenten (Standard: 3)
- `maxRounds` -- Max Runden pro Agent (Standard: 5)
- `mergeStrategy` -- latest, largest oder manual
- `verifyAgents` -- Agent-Outputs per Claude verifizieren
- `autoIntervention` -- Automatische Warnung nach N Runden

Aenderungen unterstuetzen Undo/Redo (`POST /api/config/undo`, `/api/config/redo`).

### Config-Profile
Konfigurationen als benannte Profile speichern und wechseln:
- `POST /api/profiles` -- Neues Profil erstellen
- `POST /api/profiles/:name/apply` -- Profil anwenden
- `POST /api/profiles/save-current` -- Aktuelle Config als Profil speichern
- Import/Export ueber `/api/profiles/import` und `/api/profiles/:name/export`

### Webhooks
Benachrichtigungen bei Projekt-Events an externe URLs senden:
- `POST /api/webhooks` mit `{ url, events, secret }` -- Webhook registrieren
- Events: `project-started`, `project-done`, `project-error`, `agent-done`, `agent-error`, `plan-created`, `budget-warning`, u.a.
- Signiert mit HMAC-SHA256, automatischer Retry bei Fehler.

### Snapshots
Projekt-Zustaende sichern und wiederherstellen:
- `POST /api/snapshots` -- Manuellen Snapshot erstellen
- `POST /api/snapshots/:id/restore` -- Snapshot wiederherstellen
- `GET /api/snapshots/:id1/compare/:id2` -- Zwei Snapshots vergleichen

## 9. Troubleshooting

### Claude CLI nicht gefunden
```
Error: Claude CLI not found
```
Loesung: Claude Code CLI installieren (`npm install -g @anthropic-ai/claude-code`) und sicherstellen, dass `claude` im PATH liegt. Test: `claude --version` in der Kommandozeile.

### Port 3131 belegt
```
Error: EADDRINUSE :::3131
```
Loesung: Anderen Port setzen mit `PORT=3132 node server.js` oder den blockierenden Prozess beenden.

### Agent haengt / zu viele Runden
- **Auto-Intervention aktivieren**: `AUTO_INTERVENTION=true` in `.env`. Warnt automatisch nach 10 Runden.
- **Manuell eingreifen**: Intervention vom Typ `redirect` mit klarer Anweisung senden.
- **Agent ueberspringen**: Intervention vom Typ `skip` senden.
- **Timeout**: `AGENT_TIMEOUT` (Standard: 300000ms = 5 Min) in `.env` anpassen.

### Rate-Limit Fehler
Der Orchestrator erkennt Rate-Limits automatisch und nutzt Exponential Backoff (bis zu 5 Retries). Bei haeufigen Rate-Limits: `AGENT_CONCURRENCY` reduzieren (z.B. auf 1-2).

### Projekt nach Absturz wiederherstellen
```bash
curl http://localhost:3131/api/recovery          # Pruefen ob Recovery moeglich
curl -X POST http://localhost:3131/api/recovery/restore  # Wiederherstellen
```

## 10. API-Nutzung

### Projekt starten
```bash
curl -X POST http://localhost:3131/api/start \
  -H "Content-Type: application/json" \
  -d '{"description": "Erstelle eine CLI fuer CSV-Konvertierung", "agentCount": 3}'
```

### Status abfragen
```bash
curl http://localhost:3131/api/status
```

### Plan genehmigen
```bash
curl -X POST http://localhost:3131/api/approve
```

### Agent intervenieren (Typ: redirect)
```bash
curl -X POST http://localhost:3131/api/intervene/0 \
  -H "Content-Type: application/json" \
  -d '{"type": "redirect", "message": "Verwende TypeScript statt JavaScript"}'
```

### Projekt als ZIP exportieren
```bash
curl -o projekt.zip http://localhost:3131/api/export/PROJEKT_ID
```

### Token-Budget abfragen
```bash
curl http://localhost:3131/api/budget
```

### Webhook registrieren
```bash
curl -X POST http://localhost:3131/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/hook", "events": ["project-done", "agent-error"], "secret": "mein-geheimes-token"}'
```

### Projektuebergreifende Suche
```bash
curl "http://localhost:3131/api/search?q=authentication&scope=all"
```

### Snapshot erstellen
```bash
curl -X POST http://localhost:3131/api/snapshots \
  -H "Content-Type: application/json" \
  -d '{"projectId": "PROJEKT_ID", "label": "Vor dem Refactoring"}'
```

### Config-Profil speichern und anwenden
```bash
# Aktuelle Config als Profil speichern
curl -X POST http://localhost:3131/api/profiles/save-current \
  -H "Content-Type: application/json" \
  -d '{"name": "schnell", "description": "Hohe Parallelitaet"}'

# Profil anwenden
curl -X POST http://localhost:3131/api/profiles/schnell/apply
```

Hinweis: Falls `API_TOKEN` gesetzt ist, muss bei allen Mutations-Requests der Header `-H "Authorization: Bearer DEIN_TOKEN"` mitgesendet werden.
