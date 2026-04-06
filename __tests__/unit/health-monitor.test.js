'use strict';
const HealthMonitor = require('../../src/health-monitor');

describe('HealthMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new HealthMonitor({ checkInterval: 100000 }); // Langer Intervall, kein auto-check
  });

  afterEach(() => {
    monitor.stop();
  });

  test('getHealth() gibt korrektes Format zurueck', () => {
    const health = monitor.getHealth();
    expect(health).toHaveProperty('status');
    expect(health).toHaveProperty('uptime');
    expect(health).toHaveProperty('memory');
    expect(health).toHaveProperty('cpu');
    expect(health).toHaveProperty('disk');
    expect(health).toHaveProperty('connections');
    expect(health).toHaveProperty('orchestrator');
    expect(health).toHaveProperty('timestamp');
  });

  test('status ist healthy bei normalem Betrieb', () => {
    const health = monitor.getHealth();
    expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);
    // Unter normalen Testbedingungen sollte es healthy sein
    expect(health.status).toBe('healthy');
  });

  test('status wird degraded bei niedrigem memoryPercent-Schwellwert', () => {
    // Schwellwert auf 0.001% setzen → fast sicher ueberschritten
    monitor.setAlertThreshold('memoryPercent', 0.001);
    const health = monitor.getHealth();
    expect(['degraded', 'unhealthy']).toContain(health.status);
  });

  test('Memory-Daten sind vorhanden und plausibel', () => {
    const health = monitor.getHealth();
    expect(health.memory.used).toBeGreaterThan(0);
    expect(health.memory.total).toBeGreaterThan(0);
    expect(health.memory.percentage).toBeGreaterThan(0);
    expect(health.memory.percentage).toBeLessThanOrEqual(100);
    expect(health.memory.heapUsed).toBeGreaterThan(0);
    expect(health.memory.heapTotal).toBeGreaterThan(0);
    expect(health.memory.rss).toBeGreaterThan(0);
  });

  test('CPU-Daten sind vorhanden', () => {
    const health = monitor.getHealth();
    expect(typeof health.cpu.user).toBe('number');
    expect(typeof health.cpu.system).toBe('number');
  });

  test('getHealthHistory() gibt Array zurueck', () => {
    const history = monitor.getHealthHistory();
    expect(Array.isArray(history)).toBe(true);
  });

  test('getHealthHistory() enthaelt Eintraege nach Check', () => {
    monitor._performCheck();
    monitor._performCheck();
    const history = monitor.getHealthHistory();
    expect(history.length).toBe(2);
  });

  test('History-Limit max 360 Eintraege', () => {
    // Fuege 360 Eintraege direkt in History ein
    for (let i = 0; i < 360; i++) {
      monitor._history.push({ timestamp: Date.now(), status: 'healthy' });
    }
    expect(monitor._history.length).toBe(360);
    // _performCheck fuegt einen hinzu und entfernt den aeltesten
    monitor._performCheck();
    expect(monitor._history.length).toBeLessThanOrEqual(360);
    // Nochmal 5 Checks
    for (let i = 0; i < 5; i++) {
      monitor._performCheck();
    }
    expect(monitor._history.length).toBeLessThanOrEqual(360);
  });

  test('getDiagnostics() hat nodeVersion und platform', () => {
    const diag = monitor.getDiagnostics();
    expect(diag).toHaveProperty('nodeVersion');
    expect(diag.nodeVersion).toBe(process.version);
    expect(diag).toHaveProperty('platform');
    expect(diag.platform).toBe(process.platform);
    expect(diag).toHaveProperty('arch');
    expect(diag).toHaveProperty('loadedModules');
    expect(typeof diag.loadedModules).toBe('number');
    expect(diag).toHaveProperty('eventLoopLag');
  });

  test('setAlertThreshold() setzt Schwellwert', () => {
    monitor.setAlertThreshold('memoryPercent', 50);
    expect(monitor.alertThresholds.memoryPercent).toBe(50);
  });

  test('setAlertThreshold() wirft bei ungueltiger Metrik', () => {
    expect(() => monitor.setAlertThreshold('invalid', 50)).toThrow('Ungueltige Metrik');
  });

  test('setAlertThreshold() wirft bei ungueltigem Wert', () => {
    expect(() => monitor.setAlertThreshold('memoryPercent', -1)).toThrow('positive Zahl');
    expect(() => monitor.setAlertThreshold('memoryPercent', 'abc')).toThrow('positive Zahl');
  });

  test('Alert wird emittiert wenn Schwellwert ueberschritten', (done) => {
    monitor.setAlertThreshold('memoryPercent', 0.001); // Wird sicher ueberschritten
    monitor.on('alert_triggered', (alert) => {
      expect(alert).toHaveProperty('id');
      expect(alert).toHaveProperty('metric');
      expect(alert.metric).toBe('memoryPercent');
      expect(alert).toHaveProperty('message');
      expect(alert.cleared).toBe(false);
      done();
    });
    monitor._performCheck();
  });

  test('getAlerts() gibt aktive Alerts zurueck', () => {
    monitor.setAlertThreshold('memoryPercent', 0.001);
    monitor._performCheck();
    const alerts = monitor.getAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].cleared).toBe(false);
  });

  test('clearAlert() markiert Alert als gelesen', () => {
    monitor.setAlertThreshold('memoryPercent', 0.001);
    monitor._performCheck();
    const alerts = monitor.getAlerts();
    expect(alerts.length).toBeGreaterThan(0);

    const id = alerts[0].id;
    const result = monitor.clearAlert(id);
    expect(result).toBe(true);

    const activeAlerts = monitor.getAlerts();
    expect(activeAlerts.find(a => a.id === id)).toBeUndefined();
  });

  test('clearAlert() gibt false bei unbekannter ID', () => {
    expect(monitor.clearAlert(999)).toBe(false);
  });

  test('start() und stop() funktionieren ohne Fehler', () => {
    const m = new HealthMonitor({ checkInterval: 50 });
    m.start();
    expect(m._timer).not.toBeNull();
    m.stop();
    expect(m._timer).toBeNull();
  });

  test('start() mehrfach aufrufen erstellt keinen zweiten Timer', () => {
    monitor.start();
    const timer1 = monitor._timer;
    monitor.start();
    expect(monitor._timer).toBe(timer1);
    monitor.stop();
  });

  test('getThresholds() gibt Kopie der Schwellwerte zurueck', () => {
    const thresholds = monitor.getThresholds();
    expect(thresholds.memoryPercent).toBe(85);
    expect(thresholds.heapPercent).toBe(90);
    expect(thresholds.eventLoopLag).toBe(100);
    thresholds.memoryPercent = 999;
    expect(monitor.alertThresholds.memoryPercent).toBe(85); // Original unveraendert
  });

  test('status_changed Event wird emittiert', (done) => {
    monitor.setAlertThreshold('memoryPercent', 0.001);
    monitor._lastStatus = 'healthy';
    monitor.on('status_changed', (data) => {
      expect(data).toHaveProperty('previous');
      expect(data).toHaveProperty('current');
      expect(data.previous).toBe('healthy');
      done();
    });
    monitor._performCheck();
  });

  test('Connections werden korrekt von Callback gelesen', () => {
    const m = new HealthMonitor({
      getConnections: () => ({ sse: 5, websocket: 3 }),
    });
    const health = m.getHealth();
    expect(health.connections.sse).toBe(5);
    expect(health.connections.websocket).toBe(3);
    m.stop();
  });

  test('Orchestrator-Info wird korrekt von Callback gelesen', () => {
    const m = new HealthMonitor({
      getOrchestratorInfo: () => ({ phase: 'running', agentCount: 4, activeAgents: 2 }),
    });
    const health = m.getHealth();
    expect(health.orchestrator.phase).toBe('running');
    expect(health.orchestrator.agentCount).toBe(4);
    expect(health.orchestrator.activeAgents).toBe(2);
    m.stop();
  });
});
