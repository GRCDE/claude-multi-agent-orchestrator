'use strict';

// ── Hook-System für den Multi-Agent Orchestrator ─────────────
//
// Kopiere diese Datei nach hooks.js und passe die Funktionen an.
// Jede Funktion ist optional – nur definierte Hooks werden aufgerufen.
// Hook-Fehler crashen NIEMALS den Hauptprozess.
//
// Verfügbare Hooks:
//   beforePlan  – Vor der Koordinator-Planung
//   afterPlan   – Nach der Planung, Aufgaben stehen fest
//   beforeAgent – Bevor ein Agent startet
//   afterAgent  – Nachdem ein Agent fertig ist
//   onComplete  – Alle Agenten abgeschlossen
//   onError     – Bei einem Fehler (Planung oder Agent)

module.exports = {

  // Wird aufgerufen bevor der Koordinator die Aufgaben plant
  // data: { description: string, agentCount: number }
  async beforePlan(data) {
    console.log(`[Hook] Planung startet: "${data.description}" mit ${data.agentCount} Agenten`);
  },

  // Wird aufgerufen nachdem der Plan erstellt wurde
  // data: { tasks: Array<{title, task, deliverable, role}>, projectTitle: string }
  async afterPlan(data) {
    console.log(`[Hook] Plan fertig: "${data.projectTitle}" – ${data.tasks.length} Aufgaben`);
  },

  // Wird aufgerufen bevor ein einzelner Agent startet
  // data: { index: number, task: {title, task, deliverable, role}, role: string }
  async beforeAgent(data) {
    console.log(`[Hook] Agent ${data.index + 1} startet: ${data.task.title} (${data.role})`);
  },

  // Wird aufgerufen nachdem ein Agent fertig ist
  // data: { index: number, status: string, duration: number|null, files: string[] }
  async afterAgent(data) {
    console.log(`[Hook] Agent ${data.index + 1} fertig: ${data.status} (${data.duration}s, ${data.files.length} Dateien)`);
  },

  // Wird aufgerufen wenn alle Agenten abgeschlossen sind
  // data: { projectId: string, totalDuration: number, agents: Array }
  async onComplete(data) {
    console.log(`[Hook] Projekt ${data.projectId} abgeschlossen in ${data.totalDuration}s`);
  },

  // Wird bei Fehlern aufgerufen (Planung oder Agent)
  // data: { phase: string, error: Error }
  async onError(data) {
    console.error(`[Hook] Fehler in Phase "${data.phase}": ${data.error.message}`);
  },
};
