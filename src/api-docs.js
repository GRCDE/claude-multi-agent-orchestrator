'use strict';

/**
 * Auto-API-Dokumentations-Generator
 * Generiert strukturierte Dokumentation aller API-Endpoints
 */

function generateApiDocs() {
  return {
    title: 'Claude Multi-Agent Orchestrator API',
    version: '4.0',
    description: 'REST API fuer den Claude Multi-Agent Orchestrator. Steuert Projekte, Agenten, Templates, Webhooks und mehr.',
    baseUrl: 'http://localhost:3131',
    categories: {
      Core: [
        {
          method: 'GET',
          path: '/api/status',
          description: 'Aktuellen Orchestrator-Status abfragen (Phase, Agenten, Koordinator)',
          parameters: {},
          responses: { 200: 'Orchestrator-State-Objekt mit phase, agents, coordinator, totalTokenUsage' },
          example: 'GET /api/status'
        },
        {
          method: 'POST',
          path: '/api/start',
          description: 'Neues Projekt starten oder in die Warteschlange einreihen',
          parameters: {
            body: {
              description: 'string (1-5000 Zeichen) - Projektbeschreibung',
              agentCount: 'number (2-10) - Anzahl der Agenten',
              requireApproval: 'boolean - Plan vor Ausfuehrung genehmigen lassen',
              priority: 'number (1-3) - Prioritaet (1=hoch, 2=mittel, 3=niedrig)'
            }
          },
          responses: {
            200: '{ ok: true, message: "Projekt gestartet" } oder { ok: true, queued: true, position: N }',
            400: 'Validierungsfehler',
            409: 'Warteschlange voll'
          },
          example: 'POST /api/start { "description": "Erstelle eine REST API", "agentCount": 3 }'
        },
        {
          method: 'POST',
          path: '/api/reset',
          description: 'Aktuelles Projekt zuruecksetzen (Phase auf idle)',
          parameters: {},
          responses: { 200: '{ ok: true }' },
          example: 'POST /api/reset'
        },
        {
          method: 'POST',
          path: '/api/abort',
          description: 'Laufendes Projekt abbrechen (behaelt Teilergebnisse)',
          parameters: {},
          responses: {
            200: '{ ok: true, message: "Projekt abgebrochen" }',
            400: 'Kein laufendes Projekt'
          },
          example: 'POST /api/abort'
        },
        {
          method: 'GET',
          path: '/api/stream',
          description: 'SSE (Server-Sent Events) Endpoint fuer Live-Updates',
          parameters: {
            headers: {
              'Last-Event-ID': 'number (optional) - Letzte bekannte Event-ID fuer Reconnect-Recovery'
            }
          },
          responses: {
            200: 'text/event-stream mit Events: state, agent, coordinator, phase, error, etc.',
            429: 'Zu viele SSE-Verbindungen von dieser IP',
            503: 'Maximale Anzahl SSE-Verbindungen erreicht'
          },
          example: 'GET /api/stream (EventSource)'
        },
        {
          method: 'GET',
          path: '/health',
          description: 'Health-Check (Kurzform)',
          parameters: {},
          responses: { 200: '{ status: "ok", uptime, phase, memory }' },
          example: 'GET /health'
        },
        {
          method: 'GET',
          path: '/api/health',
          description: 'Health-Check (API-Pfad)',
          parameters: {},
          responses: { 200: '{ status: "ok", uptime, phase, memory }' },
          example: 'GET /api/health'
        }
      ],

      Agents: [
        {
          method: 'POST',
          path: '/api/retry/:agentIndex',
          description: 'Fehlgeschlagenen Agent erneut ausfuehren',
          parameters: { params: { agentIndex: 'number - 0-basierter Index des Agents' } },
          responses: { 200: '{ ok: true }', 400: 'Ungueltiger Index' },
          example: 'POST /api/retry/0'
        },
        {
          method: 'POST',
          path: '/api/intervene/:agentIndex',
          description: 'In laufenden Agent eingreifen (redirect, skip, restart, inject, complete)',
          parameters: {
            params: { agentIndex: 'number - 0-basierter Index des Agents' },
            body: {
              message: 'string (max 2000 Zeichen) - Nachricht an den Agent',
              type: 'string - redirect|skip|restart|inject|complete'
            }
          },
          responses: { 200: '{ ok: true, type }', 400: 'Ungueltiger Index oder Typ' },
          example: 'POST /api/intervene/1 { "message": "Fokussiere dich auf Tests", "type": "redirect" }'
        },
        {
          method: 'GET',
          path: '/api/agent-prompts/:id/:agentIndex',
          description: 'Prompt-Log eines Agents abrufen (Debugging)',
          parameters: {
            params: {
              id: 'string - Projekt-ID (z.B. proj_1234)',
              agentIndex: 'number - 0-basierter Index des Agents'
            }
          },
          responses: {
            200: 'Array von { round, prompt, response, ts, promptTokens, responseTokens }',
            404: 'Prompt-Log nicht gefunden'
          },
          example: 'GET /api/agent-prompts/proj_1234/0'
        }
      ],

      Config: [
        {
          method: 'GET',
          path: '/api/config',
          description: 'Aktuelle Orchestrator-Konfiguration abrufen',
          parameters: {},
          responses: { 200: 'Konfigurations-Objekt' },
          example: 'GET /api/config'
        },
        {
          method: 'POST',
          path: '/api/config',
          description: 'Orchestrator-Konfiguration aktualisieren',
          parameters: { body: { '...': 'Konfigurationsfelder die aktualisiert werden sollen' } },
          responses: { 200: '{ ok: true, config }', 400: 'Validierungsfehler' },
          example: 'POST /api/config { "agentTimeout": 180 }'
        },
        {
          method: 'GET',
          path: '/api/prompts',
          description: 'Prompt-Templates abrufen',
          parameters: {},
          responses: { 200: '{ prompts: { ... } }' },
          example: 'GET /api/prompts'
        },
        {
          method: 'POST',
          path: '/api/prompts',
          description: 'Prompt-Templates aktualisieren',
          parameters: { body: { '...': 'Prompt-Template-Felder' } },
          responses: { 200: '{ ok: true, prompts }', 400: 'Validierungsfehler' },
          example: 'POST /api/prompts { "system": "Du bist..." }'
        },
        {
          method: 'POST',
          path: '/api/prompts/reset',
          description: 'Prompt-Templates auf Standardwerte zuruecksetzen',
          parameters: {},
          responses: { 200: '{ ok: true, prompts }' },
          example: 'POST /api/prompts/reset'
        },
        {
          method: 'GET',
          path: '/api/undo-redo',
          description: 'Undo/Redo-Status fuer Konfiguration und Plan abfragen',
          parameters: {},
          responses: { 200: '{ canUndo, canRedo, ... }' },
          example: 'GET /api/undo-redo'
        },
        {
          method: 'POST',
          path: '/api/config/undo',
          description: 'Letzte Konfigurationsaenderung rueckgaengig machen',
          parameters: {},
          responses: { 200: '{ ok: true, config }', 400: 'Nichts zum Rueckgaengig machen' },
          example: 'POST /api/config/undo'
        },
        {
          method: 'POST',
          path: '/api/config/redo',
          description: 'Rueckgaengig gemachte Konfigurationsaenderung wiederherstellen',
          parameters: {},
          responses: { 200: '{ ok: true, config }', 400: 'Nichts zum Wiederherstellen' },
          example: 'POST /api/config/redo'
        }
      ],

      Projects: [
        {
          method: 'GET',
          path: '/api/projects',
          description: 'Alle gespeicherten Projekte auflisten',
          parameters: {},
          responses: { 200: 'Array von Projekt-Objekten (id, title, phase, agentCount, createdAt, ...)' },
          example: 'GET /api/projects'
        },
        {
          method: 'GET',
          path: '/api/projects/:id',
          description: 'Einzelnes Projekt laden (state.json)',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: { 200: 'Vollstaendiger Projekt-State', 404: 'Projekt nicht gefunden' },
          example: 'GET /api/projects/proj_1234'
        },
        {
          method: 'DELETE',
          path: '/api/projects/:id',
          description: 'Projekt und alle zugehoerigen Dateien loeschen',
          parameters: { params: { id: 'string - Projekt-ID (muss mit proj_ beginnen)' } },
          responses: { 200: '{ ok: true, deleted: id }', 404: 'Projekt nicht gefunden' },
          example: 'DELETE /api/projects/proj_1234'
        },
        {
          method: 'POST',
          path: '/api/load/:id',
          description: 'Gespeichertes Projekt in den Orchestrator laden (Historie anzeigen)',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: {
            200: '{ ok: true, state }',
            404: 'Projekt nicht gefunden',
            409: 'Anderes Projekt laeuft'
          },
          example: 'POST /api/load/proj_1234'
        },
        {
          method: 'POST',
          path: '/api/resume/:id',
          description: 'Abgebrochenes/fehlgeschlagenes Projekt fortsetzen',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: {
            200: '{ ok: true, message: "Projekt wird fortgesetzt" }',
            409: 'Projekt laeuft bereits'
          },
          example: 'POST /api/resume/proj_1234'
        },
        {
          method: 'POST',
          path: '/api/clone/:id',
          description: 'Projekt-Einstellungen klonen (fuer Neustart mit gleichen Parametern)',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: {
            200: '{ ok: true, description, agentCount, tasks }',
            404: 'Projekt nicht gefunden'
          },
          example: 'POST /api/clone/proj_1234'
        },
        {
          method: 'POST',
          path: '/api/cleanup',
          description: 'Projekte aelter als 7 Tage automatisch loeschen',
          parameters: {},
          responses: { 200: '{ ok: true, deleted: [...], count }' },
          example: 'POST /api/cleanup'
        },
        {
          method: 'GET',
          path: '/api/disk-usage',
          description: 'Speicherplatz-Informationen zum projects-Verzeichnis',
          parameters: {},
          responses: { 200: '{ totalSize, projectCount, oldestProject, newestProject }' },
          example: 'GET /api/disk-usage'
        },
        {
          method: 'GET',
          path: '/api/projects/:id/changelog',
          description: 'Chronologische Agent-Aktionen eines Projekts',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: {
            200: 'Array von { timestamp, agentIndex, agentTitle, action, files, summary }',
            404: 'Projekt nicht gefunden'
          },
          example: 'GET /api/projects/proj_1234/changelog'
        },
        {
          method: 'GET',
          path: '/api/projects/:id1/diff/:id2',
          description: 'Zwei Projekte vergleichen (Agent-Unterschiede, Score-Delta)',
          parameters: {
            params: {
              id1: 'string - Erste Projekt-ID',
              id2: 'string - Zweite Projekt-ID'
            }
          },
          responses: {
            200: '{ added, removed, changed, scoresDiff }',
            404: 'Projekt nicht gefunden'
          },
          example: 'GET /api/projects/proj_1234/diff/proj_5678'
        },
        {
          method: 'GET',
          path: '/api/search',
          description: 'Projektuegergreifende Suche in Titeln, Dateien und Konversationen',
          parameters: {
            query: {
              q: 'string (min. 2 Zeichen) - Suchbegriff',
              scope: 'string - all|files|conversations|titles (default: all)'
            }
          },
          responses: {
            200: 'Array von Suchergebnissen mit projectId, type, path, match, context',
            400: 'Ungueltiger Scope'
          },
          example: 'GET /api/search?q=React&scope=files'
        }
      ],

      Queue: [
        {
          method: 'GET',
          path: '/api/queue',
          description: 'Aktuelle Projekt-Warteschlange mit geschaetzten Wartezeiten anzeigen',
          parameters: {},
          responses: { 200: 'Array von Queue-Items mit position und estimatedWaitTime' },
          example: 'GET /api/queue'
        },
        {
          method: 'DELETE',
          path: '/api/queue/:index',
          description: 'Einzelnes Element aus der Warteschlange entfernen',
          parameters: { params: { index: 'number - 0-basierter Index in der Queue' } },
          responses: { 200: '{ ok: true, removed }', 400: 'Ungueltiger Index' },
          example: 'DELETE /api/queue/0'
        },
        {
          method: 'POST',
          path: '/api/queue/reorder',
          description: 'Queue-Reihenfolge aendern (Drag & Drop)',
          parameters: { body: { from: 'number - Ausgangsindex', to: 'number - Zielindex' } },
          responses: { 200: '{ ok: true, queue }', 400: 'Ungueltige Indizes' },
          example: 'POST /api/queue/reorder { "from": 0, "to": 2 }'
        },
        {
          method: 'POST',
          path: '/api/queue/clear',
          description: 'Gesamte Warteschlange leeren',
          parameters: {},
          responses: { 200: '{ ok: true, cleared: N }' },
          example: 'POST /api/queue/clear'
        }
      ],

      Export: [
        {
          method: 'GET',
          path: '/api/export/:id',
          description: 'Projekt als ZIP-Archiv exportieren',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: { 200: 'application/zip Download', 404: 'Projekt nicht gefunden' },
          example: 'GET /api/export/proj_1234'
        },
        {
          method: 'GET',
          path: '/api/export-json/:id',
          description: 'Projekt als JSON exportieren (Agenten, Konversationen, Dateien)',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: { 200: 'application/json Download', 404: 'Projekt nicht gefunden' },
          example: 'GET /api/export-json/proj_1234'
        },
        {
          method: 'GET',
          path: '/api/export-markdown/:id',
          description: 'Projekt als Markdown-Bericht exportieren',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: { 200: 'text/markdown Download', 404: 'Projekt nicht gefunden' },
          example: 'GET /api/export-markdown/proj_1234'
        },
        {
          method: 'GET',
          path: '/api/files/:id',
          description: 'Dateibaum eines Projekts auflisten',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: { 200: 'Array von { path, size }', 404: 'Nicht gefunden' },
          example: 'GET /api/files/proj_1234'
        },
        {
          method: 'GET',
          path: '/api/file-content/:id/:filePath(*)',
          description: 'Inhalt einer einzelnen Datei aus einem Projekt lesen',
          parameters: {
            params: {
              id: 'string - Projekt-ID',
              filePath: 'string - Relativer Pfad zur Datei'
            }
          },
          responses: {
            200: '{ content, size, path } oder { binary: true, size, path }',
            404: 'Datei nicht gefunden',
            413: 'Datei zu gross (max 1 MB)'
          },
          example: 'GET /api/file-content/proj_1234/agent-1/index.js'
        },
        {
          method: 'GET',
          path: '/api/merged/:id',
          description: 'Zusammengefuehrte Dateien eines Projekts anzeigen (nach Merge)',
          parameters: { params: { id: 'string - Projekt-ID' } },
          responses: {
            200: '{ files, dir, mergeReport, conflictsInfo, mergeStats }',
            404: 'Zusammengefuehrte Dateien nicht gefunden'
          },
          example: 'GET /api/merged/proj_1234'
        },
        {
          method: 'POST',
          path: '/api/merge/:id',
          description: 'Manuellen Merge oder Re-Merge triggern',
          parameters: {
            params: { id: 'string - Projekt-ID' },
            body: { strategy: 'string (optional) - latest|largest|manual' }
          },
          responses: {
            200: '{ ok: true, totalFiles, conflicts, strategy, duration }',
            400: 'Ungueltige Strategie oder Projekt-ID stimmt nicht'
          },
          example: 'POST /api/merge/proj_1234 { "strategy": "latest" }'
        }
      ],

      Templates: [
        {
          method: 'GET',
          path: '/api/templates',
          description: 'Alle Projekt-Templates laden',
          parameters: {},
          responses: { 200: '{ templates: [...], taskPresets: [...] }' },
          example: 'GET /api/templates'
        },
        {
          method: 'POST',
          path: '/api/templates',
          description: 'Neues Projekt-Template erstellen',
          parameters: {
            body: {
              title: 'string - Template-Titel',
              description: 'string - Beschreibung',
              agentCount: 'number (1-20) - Vorgeschlagene Agentenzahl',
              icon: 'string (optional) - Icon/Emoji',
              tags: 'string[] (optional) - Tags'
            }
          },
          responses: { 200: '{ ok: true, template }', 400: 'Validierungsfehler' },
          example: 'POST /api/templates { "title": "Web App", "description": "...", "agentCount": 4 }'
        },
        {
          method: 'PUT',
          path: '/api/templates/:id',
          description: 'Bestehendes Template aktualisieren',
          parameters: {
            params: { id: 'string - Template-ID' },
            body: { title: 'string (optional)', description: 'string (optional)', agentCount: 'number (optional)', icon: 'string (optional)', tags: 'string[] (optional)' }
          },
          responses: { 200: '{ ok: true, template }', 404: 'Template nicht gefunden' },
          example: 'PUT /api/templates/tpl-1234 { "title": "Neuer Name" }'
        },
        {
          method: 'DELETE',
          path: '/api/templates/:id',
          description: 'Template loeschen',
          parameters: { params: { id: 'string - Template-ID' } },
          responses: { 200: '{ ok: true }', 404: 'Template nicht gefunden' },
          example: 'DELETE /api/templates/tpl-1234'
        },
        {
          method: 'POST',
          path: '/api/templates/import',
          description: 'Templates aus JSON importieren',
          parameters: { body: { templates: 'Array von Template-Objekten (jeweils mit name, description)' } },
          responses: { 200: '{ ok: true, imported, total }', 400: 'Ungueltiges Format' },
          example: 'POST /api/templates/import { "templates": [{ "name": "...", "description": "..." }] }'
        },
        {
          method: 'GET',
          path: '/api/templates/export',
          description: 'Alle Templates als JSON-Datei exportieren',
          parameters: {},
          responses: { 200: 'application/json Download (templates-export.json)' },
          example: 'GET /api/templates/export'
        }
      ],

      Webhooks: [
        {
          method: 'POST',
          path: '/api/webhooks',
          description: 'Neuen Webhook registrieren',
          parameters: {
            body: {
              url: 'string - HTTP(S) URL des Webhook-Empfaengers',
              events: 'string[] - Zu abonnierende Events (project-started, project-done, project-error, agent-done, agent-error, plan-created, plan-adapted, budget-warning, budget-exceeded)',
              secret: 'string (min. 8 Zeichen) - HMAC-SHA256 Signatur-Secret'
            }
          },
          responses: { 200: '{ ok: true, webhook }', 400: 'Validierungsfehler', 409: 'Maximale Anzahl oder URL existiert bereits' },
          example: 'POST /api/webhooks { "url": "https://example.com/hook", "events": ["project-done"], "secret": "mein-secret" }'
        },
        {
          method: 'GET',
          path: '/api/webhooks',
          description: 'Alle registrierten Webhooks auflisten (Secret maskiert)',
          parameters: {},
          responses: { 200: 'Array von Webhook-Objekten mit Delivery-Log' },
          example: 'GET /api/webhooks'
        },
        {
          method: 'DELETE',
          path: '/api/webhooks/:id',
          description: 'Webhook loeschen',
          parameters: { params: { id: 'string - Webhook-ID' } },
          responses: { 200: '{ ok: true, deleted }', 404: 'Webhook nicht gefunden' },
          example: 'DELETE /api/webhooks/wh-1234'
        },
        {
          method: 'POST',
          path: '/api/webhooks/:id/test',
          description: 'Test-Ping an einen registrierten Webhook senden',
          parameters: { params: { id: 'string - Webhook-ID' } },
          responses: { 200: '{ ok: true, statusCode }', 404: 'Webhook nicht gefunden', 502: 'Webhook-Test fehlgeschlagen' },
          example: 'POST /api/webhooks/wh-1234/test'
        },
        {
          method: 'POST',
          path: '/api/webhooks/:id/toggle',
          description: 'Webhook aktivieren/deaktivieren',
          parameters: { params: { id: 'string - Webhook-ID' } },
          responses: { 200: '{ ok: true, active }', 404: 'Webhook nicht gefunden' },
          example: 'POST /api/webhooks/wh-1234/toggle'
        },
        {
          method: 'POST',
          path: '/api/test-webhook',
          description: 'Test-Webhook an eine beliebige URL senden (ohne Registrierung)',
          parameters: { body: { url: 'string - HTTP(S) URL' } },
          responses: { 200: '{ ok: true, statusCode }', 400: 'URL-Validierungsfehler', 502: 'Webhook fehlgeschlagen' },
          example: 'POST /api/test-webhook { "url": "https://example.com/test" }'
        }
      ],

      Budget: [
        {
          method: 'GET',
          path: '/api/token-usage',
          description: 'Token-Verbrauch aufgeschluesselt nach Koordinator und Agenten',
          parameters: {},
          responses: { 200: '{ total, coordinator, agents, budget }' },
          example: 'GET /api/token-usage'
        },
        {
          method: 'GET',
          path: '/api/budget',
          description: 'Budget-Status und -Limits abfragen',
          parameters: {},
          responses: { 200: '{ maxTokenBudget, warnTokenBudget, totalTokens, percent, exceeded, warned, ... }' },
          example: 'GET /api/budget'
        },
        {
          method: 'POST',
          path: '/api/budget',
          description: 'Budget-Limits aktualisieren',
          parameters: {
            body: {
              maxTokenBudget: 'number (optional) - Maximales Token-Budget',
              warnTokenBudget: 'number (optional) - Warn-Schwelle',
              inputCostPerMTok: 'number (optional) - Kosten pro Million Input-Tokens',
              outputCostPerMTok: 'number (optional) - Kosten pro Million Output-Tokens'
            }
          },
          responses: { 200: '{ ok: true, config }', 400: 'Validierungsfehler' },
          example: 'POST /api/budget { "maxTokenBudget": 1000000 }'
        }
      ],

      Recovery: [
        {
          method: 'GET',
          path: '/api/recovery',
          description: 'Pruefen ob eine Crash-Recovery moeglich ist',
          parameters: {},
          responses: { 200: '{ hasCrash, projectId, projectTitle, ... }' },
          example: 'GET /api/recovery'
        },
        {
          method: 'POST',
          path: '/api/recovery/restore',
          description: 'Projekt aus Checkpoint wiederherstellen',
          parameters: {},
          responses: {
            200: '{ ok: true, message, projectId, projectTitle }',
            404: 'Kein Checkpoint gefunden',
            409: 'Anderes Projekt laeuft'
          },
          example: 'POST /api/recovery/restore'
        },
        {
          method: 'POST',
          path: '/api/recovery/discard',
          description: 'Checkpoint verwerfen und frisch starten',
          parameters: {},
          responses: { 200: '{ ok: true, message, projectId }', 404: 'Kein Checkpoint gefunden' },
          example: 'POST /api/recovery/discard'
        }
      ],

      Roles: [
        {
          method: 'GET',
          path: '/api/roles',
          description: 'Verfuegbare Agenten-Rollen auflisten',
          parameters: {},
          responses: { 200: '{ roles, defaultRoles, customRoles }' },
          example: 'GET /api/roles'
        },
        {
          method: 'POST',
          path: '/api/roles',
          description: 'Neue benutzerdefinierte Rolle erstellen',
          parameters: { body: { '...': 'Rollen-Definition (id, name, prompt, ...)' } },
          responses: { 200: '{ ok: true, role }', 400: 'Validierungsfehler' },
          example: 'POST /api/roles { "id": "tester", "name": "Tester", "prompt": "..." }'
        },
        {
          method: 'PUT',
          path: '/api/roles/:id',
          description: 'Bestehende Rolle aktualisieren',
          parameters: {
            params: { id: 'string - Rollen-ID' },
            body: { '...': 'Rollen-Felder die aktualisiert werden sollen' }
          },
          responses: { 200: '{ ok: true, role }', 400: 'Validierungsfehler' },
          example: 'PUT /api/roles/tester { "name": "QA Tester" }'
        },
        {
          method: 'DELETE',
          path: '/api/roles/:id',
          description: 'Benutzerdefinierte Rolle loeschen',
          parameters: { params: { id: 'string - Rollen-ID' } },
          responses: { 200: '{ ok: true }', 400: 'Rolle nicht gefunden oder Standard-Rolle' },
          example: 'DELETE /api/roles/tester'
        }
      ],

      Plan: [
        {
          method: 'POST',
          path: '/api/approve',
          description: 'Koordinator-Plan genehmigen (bei requireApproval=true)',
          parameters: {},
          responses: { 200: '{ ok: true }', 400: 'Kein Plan zur Genehmigung vorhanden' },
          example: 'POST /api/approve'
        },
        {
          method: 'POST',
          path: '/api/modify-plan',
          description: 'Plan vor Genehmigung modifizieren (Aufgaben aendern)',
          parameters: { body: { tasks: 'Array von Task-Objekten' } },
          responses: { 200: '{ ok: true }', 400: 'Tasks muessen ein nicht-leeres Array sein' },
          example: 'POST /api/modify-plan { "tasks": [{ "title": "...", "task": "..." }] }'
        },
        {
          method: 'POST',
          path: '/api/plan/undo',
          description: 'Letzte Planaenderung rueckgaengig machen',
          parameters: {},
          responses: { 200: '{ ok: true, tasks, agents }', 400: 'Nichts zum Rueckgaengig machen' },
          example: 'POST /api/plan/undo'
        },
        {
          method: 'POST',
          path: '/api/plan/redo',
          description: 'Rueckgaengig gemachte Planaenderung wiederherstellen',
          parameters: {},
          responses: { 200: '{ ok: true, tasks, agents }', 400: 'Nichts zum Wiederherstellen' },
          example: 'POST /api/plan/redo'
        }
      ],

      Metrics: [
        {
          method: 'GET',
          path: '/api/metrics',
          description: 'Performance-Metriken des Servers (CPU, RAM, Request-Statistiken)',
          parameters: {},
          responses: { 200: '{ uptime, memory, cpu, connections, endpoints, serverStart }' },
          example: 'GET /api/metrics'
        },
        {
          method: 'DELETE',
          path: '/api/metrics',
          description: 'Alle Metriken zuruecksetzen',
          parameters: {},
          responses: { 200: '{ ok: true, message: "Metriken zurueckgesetzt" }' },
          example: 'DELETE /api/metrics'
        },
        {
          method: 'GET',
          path: '/api/stats',
          description: 'Aggregierte Projekt-Statistiken (Erfolgsrate, Dauer, Score)',
          parameters: {},
          responses: { 200: '{ totalProjects, completedProjects, failedProjects, avgDuration, avgScore, ... }' },
          example: 'GET /api/stats'
        },
        {
          method: 'GET',
          path: '/api/analytics',
          description: 'Erweiterte Analytics (Timeline, Rollenstatistiken, Kosteneffizienz, Verteilungen)',
          parameters: {},
          responses: { 200: '{ timeline, roleStats, costEfficiency, topStats, distribution }' },
          example: 'GET /api/analytics'
        }
      ],

      Logs: [
        {
          method: 'GET',
          path: '/api/logs',
          description: 'Server-Logs abrufen (paginiert, filterbar)',
          parameters: {
            query: {
              level: 'string (optional) - Log-Level filtern (info, warn, error)',
              category: 'string (optional) - Kategorie filtern',
              search: 'string (optional) - Volltextsuche in Logs',
              offset: 'number (optional, default 0) - Pagination-Offset',
              limit: 'number (optional, default 100, max 200) - Eintraege pro Seite'
            }
          },
          responses: { 200: '{ entries, total, offset, limit }' },
          example: 'GET /api/logs?level=error&limit=50'
        },
        {
          method: 'GET',
          path: '/api/logs/export',
          description: 'Alle Logs als JSONL-Datei exportieren',
          parameters: {},
          responses: { 200: 'application/jsonl Download' },
          example: 'GET /api/logs/export'
        },
        {
          method: 'GET',
          path: '/api/logs/files',
          description: 'Rotierte Log-Dateien auflisten',
          parameters: {},
          responses: { 200: 'Array von Log-Datei-Informationen' },
          example: 'GET /api/logs/files'
        }
      ],

      Milestones: [
        {
          method: 'GET',
          path: '/api/milestones',
          description: 'Vordefinierte Meilensteine laden',
          parameters: {},
          responses: { 200: '{ milestones: [...] }' },
          example: 'GET /api/milestones'
        },
        {
          method: 'POST',
          path: '/api/milestones',
          description: 'Meilensteine speichern/aktualisieren',
          parameters: {
            body: {
              milestones: 'Array von Meilenstein-Objekten (jeweils mit id, title, tasks[])'
            }
          },
          responses: { 200: '{ ok: true, count }', 400: 'Validierungsfehler' },
          example: 'POST /api/milestones { "milestones": [{ "id": "m1", "title": "...", "tasks": [...] }] }'
        },
        {
          method: 'POST',
          path: '/api/start-milestone',
          description: 'Projekt mit einem vordefinierten Meilenstein starten',
          parameters: {
            body: {
              milestoneId: 'string - ID des zu startenden Meilensteins',
              tasks: 'Array (optional) - Ueberschriebene Tasks'
            }
          },
          responses: {
            200: '{ ok: true, message } oder { ok: true, queued: true, position }',
            404: 'Meilenstein nicht gefunden',
            409: 'Warteschlange voll'
          },
          example: 'POST /api/start-milestone { "milestoneId": "m1" }'
        }
      ],

      Docs: [
        {
          method: 'GET',
          path: '/api/docs',
          description: 'Interaktive HTML-API-Dokumentation',
          parameters: {},
          responses: { 200: 'text/html - Interaktive Dokumentationsseite' },
          example: 'GET /api/docs'
        },
        {
          method: 'GET',
          path: '/api/docs/json',
          description: 'API-Dokumentation als JSON',
          parameters: {},
          responses: { 200: 'Strukturiertes JSON-Objekt aller Endpoints' },
          example: 'GET /api/docs/json'
        },
        {
          method: 'GET',
          path: '/api/docs/openapi',
          description: 'OpenAPI 3.0 Spezifikation als JSON',
          parameters: {},
          responses: { 200: 'OpenAPI 3.0 kompatibles JSON-Objekt' },
          example: 'GET /api/docs/openapi'
        },
        {
          method: 'GET',
          path: '/api/docs/markdown',
          description: 'API-Dokumentation im Markdown-Format',
          parameters: {},
          responses: { 200: 'text/markdown - Vollstaendige Markdown-Dokumentation' },
          example: 'GET /api/docs/markdown'
        }
      ]
    }
  };
}

function generateMarkdown() {
  const docs = generateApiDocs();
  let md = '# ' + docs.title + '\n\n';
  md += '**Version:** ' + docs.version + '\n\n';
  md += docs.description + '\n\n';
  md += '**Base URL:** `' + docs.baseUrl + '`\n\n';
  md += '---\n\n';

  const categories = docs.categories;
  for (const catName of Object.keys(categories)) {
    const endpoints = categories[catName];
    md += '## ' + catName + '\n\n';

    for (const ep of endpoints) {
      md += '### `' + ep.method + ' ' + ep.path + '`\n\n';
      md += ep.description + '\n\n';

      // Parameters
      const params = ep.parameters || {};
      const hasParams = Object.keys(params).length > 0;
      if (hasParams) {
        md += '**Parameter:**\n\n';
        for (const paramType of Object.keys(params)) {
          const fields = params[paramType];
          if (typeof fields === 'object' && fields !== null) {
            md += '- *' + paramType + ':*\n';
            for (const field of Object.keys(fields)) {
              md += '  - `' + field + '`: ' + fields[field] + '\n';
            }
          }
        }
        md += '\n';
      }

      // Responses
      if (ep.responses) {
        md += '**Responses:**\n\n';
        for (const code of Object.keys(ep.responses)) {
          md += '- `' + code + '`: ' + ep.responses[code] + '\n';
        }
        md += '\n';
      }

      // Example
      if (ep.example) {
        md += '**Beispiel:** `' + ep.example + '`\n\n';
      }

      md += '---\n\n';
    }
  }

  return md;
}

function generateOpenApiSpec() {
  const docs = generateApiDocs();
  const paths = {};

  const methodMap = {
    GET: 'get',
    POST: 'post',
    PUT: 'put',
    DELETE: 'delete',
    PATCH: 'patch'
  };

  const categories = docs.categories;
  for (const catName of Object.keys(categories)) {
    const endpoints = categories[catName];
    for (const ep of endpoints) {
      // Convert Express path params to OpenAPI format
      const oaPath = ep.path.replace(/:([a-zA-Z0-9_]+)(\([^)]*\))?/g, '{$1}');
      const method = methodMap[ep.method] || ep.method.toLowerCase();

      if (!paths[oaPath]) paths[oaPath] = {};

      const operation = {
        summary: ep.description,
        tags: [catName],
        operationId: method + ep.path.replace(/[/:*()]/g, '_').replace(/_+/g, '_').replace(/_$/, ''),
        responses: {}
      };

      // Parameters (path + query)
      const parameters = [];
      const params = ep.parameters || {};

      if (params.params) {
        for (const name of Object.keys(params.params)) {
          parameters.push({
            name: name,
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: params.params[name]
          });
        }
      }

      if (params.query) {
        for (const name of Object.keys(params.query)) {
          parameters.push({
            name: name,
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: params.query[name]
          });
        }
      }

      if (params.headers) {
        for (const name of Object.keys(params.headers)) {
          parameters.push({
            name: name,
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: params.headers[name]
          });
        }
      }

      if (parameters.length > 0) {
        operation.parameters = parameters;
      }

      // Request body
      if (params.body && (method === 'post' || method === 'put' || method === 'patch')) {
        const properties = {};
        for (const field of Object.keys(params.body)) {
          properties[field] = { type: 'string', description: params.body[field] };
        }
        operation.requestBody = {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: properties
              }
            }
          }
        };
      }

      // Responses
      if (ep.responses) {
        for (const code of Object.keys(ep.responses)) {
          operation.responses[String(code)] = {
            description: ep.responses[code]
          };
        }
      } else {
        operation.responses['200'] = { description: 'Erfolgreiche Antwort' };
      }

      paths[oaPath][method] = operation;
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: docs.title,
      version: docs.version,
      description: docs.description
    },
    servers: [
      { url: docs.baseUrl, description: 'Lokaler Entwicklungsserver' }
    ],
    paths: paths
  };
}

module.exports = { generateApiDocs, generateMarkdown, generateOpenApiSpec };
