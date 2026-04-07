'use strict';

// ── i18n / Lokalisierungssystem ──────────────────────────────
// Unterstützt Deutsch (de) und Englisch (en) mit Interpolation
// Fallback: Wenn Key in gewählter Sprache fehlt → deutsch

const LANGUAGES = {
  de: 'Deutsch',
  en: 'English',
};

let currentLanguage = 'de';

// ── Übersetzungen ─────────────────────────────────────────────
const translations = {
  de: {
    // Phasen
    'phase.idle': 'Bereit',
    'phase.running': 'Läuft',
    'phase.error': 'Fehler',
    'phase.complete': 'Abgeschlossen',
    'phase.awaiting_approval': 'Warte auf Genehmigung',
    'phase.aborted': 'Abgebrochen',
    'phase.planning': 'Planungsphase',
    'phase.merging': 'Zusammenführung',

    // Agent-Status
    'agent.status.waiting': 'Wartend',
    'agent.status.running': 'Läuft',
    'agent.status.done': 'Fertig',
    'agent.status.error': 'Fehler',
    'agent.status.skipped': 'Übersprungen',
    'agent.status.planning': 'Wird geplant…',

    // Agent-Aktionen
    'agent.started': 'Agent {id} gestartet',
    'agent.finished': 'Agent {id} abgeschlossen',
    'agent.skipped': 'Agent {id} übersprungen',
    'agent.error': 'Agent {id} Fehler: {error}',
    'agent.round': 'Agent {id} Runde {round}',
    'agent.question': 'Agent {id} hat eine Frage an den Koordinator',
    'agent.message': 'Nachricht von Agent {from} an Agent {to}',
    'agent.typing': 'Agent {id} schreibt...',
    'agent.timeout': 'Agent {id} Zeitüberschreitung nach {seconds}s',
    'agent.retrying': 'Agent {id} wird erneut versucht (Versuch {attempt})',
    'agent.skipped_budget': 'Agent {id} übersprungen: Token-Budget überschritten',
    'agent.stopped_budget': 'Agent {id} gestoppt: Token-Budget in Runde {round} überschritten',
    'agent.intervention': 'Intervention für Agent {id}: {type}',

    // Koordinator
    'coordinator.planning': 'Koordinator plant Aufgaben',
    'coordinator.answering': 'Koordinator beantwortet Frage',
    'coordinator.interim': 'Koordinator erstellt Zwischenbericht',
    'coordinator.adapting': 'Koordinator passt Plan an',
    'coordinator.error': 'Koordinator-Fehler: {error}',

    // Fehlermeldungen
    'error.cli_not_found': 'Claude CLI nicht installiert oder nicht im PATH',
    'error.cli_install_hint': 'Bitte installiere Claude Code CLI: npm install -g @anthropic-ai/claude-code',
    'error.empty_description': 'Projektbeschreibung darf nicht leer sein',
    'error.no_disk_space': 'Kein Speicherplatz mehr verfügbar',
    'error.rate_limit': 'Rate-Limit erreicht, warte {seconds}s',
    'error.network': 'Netzwerkfehler: {error}',
    'error.timeout': 'Zeitüberschreitung nach {seconds}s',
    'error.unknown': 'Unbekannter Fehler',
    'error.invalid_language': 'Ungültige Sprache: {lang}. Erlaubt: {allowed}',
    'error.project_not_found': 'Projekt {id} nicht gefunden',
    'error.budget_exceeded': 'Token-Budget überschritten: {total} / {budget} Tokens',
    'error.budget_warning': 'Token-Budget Warnschwelle erreicht: {total} / {warn} Tokens',
    'error.invalid_field': 'Unbekanntes Feld: {field}',
    'error.field_range': '{field} muss zwischen {min} und {max} liegen',

    // Projekt
    'project.started': 'Projekt gestartet',
    'project.completed': 'Projekt abgeschlossen',
    'project.aborted': 'Projekt abgebrochen',
    'project.partially_completed': 'Projekt teilweise abgeschlossen',
    'project.score_calculated': 'Projekt-Score berechnet',
    'project.loaded': 'Projekt geladen',
    'project.resumed': 'Projekt wird fortgesetzt',
    'project.default_title': 'Projekt',

    // Merge
    'merge.started': 'Zusammenführung gestartet ({strategy})',
    'merge.completed': 'Zusammenführung abgeschlossen: {files} Dateien',
    'merge.conflict': 'Zusammenführungskonflikt in {file}',

    // UI-Labels
    'ui.start': 'Starten',
    'ui.stop': 'Stoppen',
    'ui.reset': 'Zurücksetzen',
    'ui.export': 'Exportieren',
    'ui.settings': 'Einstellungen',
    'ui.agents': 'Agenten',
    'ui.coordinator': 'Koordinator',
    'ui.description': 'Projektbeschreibung',
    'ui.agent_count': 'Anzahl Agenten',
    'ui.approve': 'Genehmigen',
    'ui.reject': 'Ablehnen',
    'ui.language': 'Sprache',
    'ui.status': 'Status',
    'ui.duration': 'Dauer',
    'ui.progress': 'Fortschritt',

    // API-Responses
    'api.project_started': 'Projekt gestartet',
    'api.project_reset': 'Projekt zurückgesetzt',
    'api.project_aborted': 'Projekt abgebrochen',
    'api.config_updated': 'Konfiguration aktualisiert',
    'api.too_many_requests': 'Zu viele Anfragen. Bitte warte eine Minute.',
    'api.auth_required': 'Authentifizierung erforderlich',
    'api.invalid_content_type': 'Content-Type muss application/json sein',

    // Parallele Ausführung
    'parallel.start': 'Parallele Ausführung: {count} Agenten, max {max} gleichzeitig',
    'parallel.semaphore': 'Semaphore: {running} laufend, {waiting} wartend',

    // Sonstiges
    'misc.transcript_no_space': 'Warnung: Kein Speicherplatz für Transcript',
    'misc.history_trimmed': '... gekürzt ...',
    'misc.auto_retry': 'Auto-Retry in {seconds}s',

    // SDK
    'sdk.not_available': 'Claude Code SDK nicht verfügbar. CLI-Modus wird verwendet.',
    'sdk.detected': 'Claude Code SDK erkannt (Version: {version})',
    'sdk.mode_changed': 'Claude-Modus geändert: {mode}',
    'sdk.invalid_mode': 'Ungültiger Claude-Modus: {mode}. Erlaubt: cli, sdk, auto',
    'sdk.fallback_cli': 'SDK-Fehler, Fallback auf CLI-Modus',

    // Git
    'git.commit_success': 'Git-Commit erstellt: {hash}',
    'git.commit_failed': 'Git-Commit fehlgeschlagen: {error}',
    'git.push_success': 'Git-Push erfolgreich: {branch}',
    'git.push_failed': 'Git-Push fehlgeschlagen: {error}',
    'git.branch_created': 'Git-Branch erstellt: {branch}',
    'git.not_configured': 'Git-Integration nicht konfiguriert',
    'git.disabled': 'Git-Integration deaktiviert',
  },

  en: {
    // Phases
    'phase.idle': 'Ready',
    'phase.running': 'Running',
    'phase.error': 'Error',
    'phase.complete': 'Complete',
    'phase.awaiting_approval': 'Awaiting approval',
    'phase.aborted': 'Aborted',
    'phase.planning': 'Planning phase',
    'phase.merging': 'Merging',

    // Agent status
    'agent.status.waiting': 'Waiting',
    'agent.status.running': 'Running',
    'agent.status.done': 'Done',
    'agent.status.error': 'Error',
    'agent.status.skipped': 'Skipped',
    'agent.status.planning': 'Being planned…',

    // Agent actions
    'agent.started': 'Agent {id} started',
    'agent.finished': 'Agent {id} completed',
    'agent.skipped': 'Agent {id} skipped',
    'agent.error': 'Agent {id} error: {error}',
    'agent.round': 'Agent {id} round {round}',
    'agent.question': 'Agent {id} has a question for the coordinator',
    'agent.message': 'Message from agent {from} to agent {to}',
    'agent.typing': 'Agent {id} is typing...',
    'agent.timeout': 'Agent {id} timed out after {seconds}s',
    'agent.retrying': 'Agent {id} retrying (attempt {attempt})',
    'agent.skipped_budget': 'Agent {id} skipped: token budget exceeded',
    'agent.stopped_budget': 'Agent {id} stopped: token budget exceeded in round {round}',
    'agent.intervention': 'Intervention for agent {id}: {type}',

    // Coordinator
    'coordinator.planning': 'Coordinator is planning tasks',
    'coordinator.answering': 'Coordinator is answering question',
    'coordinator.interim': 'Coordinator generating interim report',
    'coordinator.adapting': 'Coordinator adapting plan',
    'coordinator.error': 'Coordinator error: {error}',

    // Error messages
    'error.cli_not_found': 'Claude CLI not installed or not in PATH',
    'error.cli_install_hint': 'Please install Claude Code CLI: npm install -g @anthropic-ai/claude-code',
    'error.empty_description': 'Project description must not be empty',
    'error.no_disk_space': 'No disk space available',
    'error.rate_limit': 'Rate limit reached, waiting {seconds}s',
    'error.network': 'Network error: {error}',
    'error.timeout': 'Timeout after {seconds}s',
    'error.unknown': 'Unknown error',
    'error.invalid_language': 'Invalid language: {lang}. Allowed: {allowed}',
    'error.project_not_found': 'Project {id} not found',
    'error.budget_exceeded': 'Token budget exceeded: {total} / {budget} tokens',
    'error.budget_warning': 'Token budget warning threshold reached: {total} / {warn} tokens',
    'error.invalid_field': 'Unknown field: {field}',
    'error.field_range': '{field} must be between {min} and {max}',

    // Project
    'project.started': 'Project started',
    'project.completed': 'Project completed',
    'project.aborted': 'Project aborted',
    'project.partially_completed': 'Project partially completed',
    'project.score_calculated': 'Project score calculated',
    'project.loaded': 'Project loaded',
    'project.resumed': 'Project resuming',
    'project.default_title': 'Project',

    // Merge
    'merge.started': 'Merge started ({strategy})',
    'merge.completed': 'Merge completed: {files} files',
    'merge.conflict': 'Merge conflict in {file}',

    // UI labels
    'ui.start': 'Start',
    'ui.stop': 'Stop',
    'ui.reset': 'Reset',
    'ui.export': 'Export',
    'ui.settings': 'Settings',
    'ui.agents': 'Agents',
    'ui.coordinator': 'Coordinator',
    'ui.description': 'Project description',
    'ui.agent_count': 'Number of agents',
    'ui.approve': 'Approve',
    'ui.reject': 'Reject',
    'ui.language': 'Language',
    'ui.status': 'Status',
    'ui.duration': 'Duration',
    'ui.progress': 'Progress',

    // API responses
    'api.project_started': 'Project started',
    'api.project_reset': 'Project reset',
    'api.project_aborted': 'Project aborted',
    'api.config_updated': 'Configuration updated',
    'api.too_many_requests': 'Too many requests. Please wait a minute.',
    'api.auth_required': 'Authentication required',
    'api.invalid_content_type': 'Content-Type must be application/json',

    // Parallel execution
    'parallel.start': 'Parallel execution: {count} agents, max {max} concurrent',
    'parallel.semaphore': 'Semaphore: {running} running, {waiting} waiting',

    // Miscellaneous
    'misc.transcript_no_space': 'Warning: No disk space for transcript',
    'misc.history_trimmed': '... trimmed ...',
    'misc.auto_retry': 'Auto-retry in {seconds}s',

    // SDK
    'sdk.not_available': 'Claude Code SDK not available. Using CLI mode.',
    'sdk.detected': 'Claude Code SDK detected (Version: {version})',
    'sdk.mode_changed': 'Claude mode changed: {mode}',
    'sdk.invalid_mode': 'Invalid Claude mode: {mode}. Allowed: cli, sdk, auto',
    'sdk.fallback_cli': 'SDK error, falling back to CLI mode',

    // Git
    'git.commit_success': 'Git commit created: {hash}',
    'git.commit_failed': 'Git commit failed: {error}',
    'git.push_success': 'Git push successful: {branch}',
    'git.push_failed': 'Git push failed: {error}',
    'git.branch_created': 'Git branch created: {branch}',
    'git.not_configured': 'Git integration not configured',
    'git.disabled': 'Git integration disabled',
  },
};

// ── t() – Übersetzungsfunktion mit Interpolation ──────────────
function t(key, lang, params) {
  // Sprache validieren, Fallback zu currentLanguage, dann 'de'
  const useLang = (lang && translations[lang]) ? lang : currentLanguage;

  // Zuerst in gewünschter Sprache suchen, dann Fallback zu Deutsch
  let str = translations[useLang]?.[key];
  if (str === undefined) {
    str = translations.de?.[key];
  }
  if (str === undefined) {
    return key; // Key selbst zurückgeben wenn nirgends gefunden
  }

  // Interpolation: {param} durch Werte ersetzen
  if (params && typeof params === 'object') {
    for (const [pKey, pVal] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${pKey}\\}`, 'g'), String(pVal));
    }
  }

  return str;
}

// ── Sprache setzen / lesen ────────────────────────────────────
function getLanguage() {
  return currentLanguage;
}

function setLanguage(lang) {
  if (translations[lang]) {
    currentLanguage = lang;
    return true;
  }
  return false;
}

// ── Alle Übersetzungen für eine Sprache ───────────────────────
function getTranslations(lang) {
  if (translations[lang]) {
    return { ...translations[lang] };
  }
  return null;
}

// ── Alle Keys einer Sprache ───────────────────────────────────
function getKeys(lang) {
  if (translations[lang]) {
    return Object.keys(translations[lang]);
  }
  return [];
}

module.exports = { t, LANGUAGES, getLanguage, setLanguage, getTranslations, getKeys, translations };
