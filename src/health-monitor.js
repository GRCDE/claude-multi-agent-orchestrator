'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

class HealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.checkInterval = options.checkInterval || 10000;
    this.alertThresholds = Object.assign({
      memoryPercent: 85,
      heapPercent: 90,
      eventLoopLag: 100,
      diskSize: 1024 * 1024 * 1024, // 1GB
    }, options.alertThresholds || {});

    this._history = [];
    this._maxHistory = 360;
    this._alerts = [];
    this._alertIdCounter = 0;
    this._timer = null;
    this._lastStatus = 'healthy';
    this._eventLoopLag = 0;
    this._lagTimer = null;

    // Referenzen fuer Verbindungszaehler und Orchestrator-Status
    this._getConnections = options.getConnections || (() => ({ sse: 0, websocket: 0 }));
    this._getOrchestratorInfo = options.getOrchestratorInfo || (() => ({ phase: 'idle', agentCount: 0, activeAgents: 0 }));
  }

  start() {
    if (this._timer) return;
    this._measureEventLoopLag();
    this._performCheck();
    this._timer = setInterval(() => this._performCheck(), this.checkInterval);
    // Unref damit Timer den Prozess nicht offen haelt
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._lagTimer) {
      clearTimeout(this._lagTimer);
      this._lagTimer = null;
    }
  }

  _measureEventLoopLag() {
    if (this._lagTimer) {
      clearTimeout(this._lagTimer);
      this._lagTimer = null;
    }
    const start = Date.now();
    this._lagTimer = setTimeout(() => {
      this._eventLoopLag = Math.max(0, Date.now() - start - 50);
      if (this._timer) {
        this._measureEventLoopLag();
      }
    }, 50);
    if (this._lagTimer && this._lagTimer.unref) this._lagTimer.unref();
  }

  _performCheck() {
    const health = this.getHealth();
    this._history.push(health);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }
    this.emit('health_check', health);

    // Status-Aenderung erkennen
    if (health.status !== this._lastStatus) {
      this.emit('status_changed', { previous: this._lastStatus, current: health.status });
      this._lastStatus = health.status;
    }

    // Alert-Pruefungen
    this._checkAlerts(health);
  }

  _checkAlerts(health) {
    // Memory-Prozent
    if (health.memory.percentage > this.alertThresholds.memoryPercent) {
      this._triggerAlert('memoryPercent', `Speicherauslastung bei ${health.memory.percentage.toFixed(1)}% (Schwellwert: ${this.alertThresholds.memoryPercent}%)`, health.memory.percentage);
    } else {
      this._clearAlertByMetric('memoryPercent');
    }

    // Heap-Prozent
    const heapPercent = (health.memory.heapUsed / health.memory.heapTotal) * 100;
    if (heapPercent > this.alertThresholds.heapPercent) {
      this._triggerAlert('heapPercent', `Heap-Auslastung bei ${heapPercent.toFixed(1)}% (Schwellwert: ${this.alertThresholds.heapPercent}%)`, heapPercent);
    } else {
      this._clearAlertByMetric('heapPercent');
    }

    // Event-Loop Lag
    if (this._eventLoopLag > this.alertThresholds.eventLoopLag) {
      this._triggerAlert('eventLoopLag', `Event-Loop Lag bei ${this._eventLoopLag}ms (Schwellwert: ${this.alertThresholds.eventLoopLag}ms)`, this._eventLoopLag);
    } else {
      this._clearAlertByMetric('eventLoopLag');
    }

    // Disk Size
    if (health.disk.projectsSize > this.alertThresholds.diskSize) {
      this._triggerAlert('diskSize', `Projektverzeichnis ${(health.disk.projectsSize / 1024 / 1024).toFixed(1)}MB (Schwellwert: ${(this.alertThresholds.diskSize / 1024 / 1024).toFixed(1)}MB)`, health.disk.projectsSize);
    } else {
      this._clearAlertByMetric('diskSize');
    }
  }

  _triggerAlert(metric, message, value) {
    // Nur einmal pro Metrik triggern (solange aktiv)
    const existing = this._alerts.find(a => a.metric === metric && !a.cleared);
    if (existing) return;

    const alert = {
      id: ++this._alertIdCounter,
      metric,
      message,
      value,
      triggeredAt: Date.now(),
      cleared: false,
    };
    this._alerts.push(alert);
    this.emit('alert_triggered', alert);
  }

  _clearAlertByMetric(metric) {
    const active = this._alerts.find(a => a.metric === metric && !a.cleared);
    if (active) {
      active.cleared = true;
      active.clearedAt = Date.now();
      this.emit('alert_cleared', active);
    }
  }

  getHealth() {
    const mem = process.memoryUsage();
    const totalMem = require('os').totalmem();
    const usedMem = totalMem - require('os').freemem();
    const cpu = process.cpuUsage();
    const connections = this._getConnections();
    const orchInfo = this._getOrchestratorInfo();

    const status = this._computeStatus(mem, totalMem, usedMem);

    return {
      status,
      uptime: process.uptime(),
      memory: {
        used: usedMem,
        total: totalMem,
        percentage: (usedMem / totalMem) * 100,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
      },
      cpu: {
        user: cpu.user,
        system: cpu.system,
      },
      disk: {
        projectsSize: this._getProjectsSize(),
      },
      connections,
      orchestrator: orchInfo,
      timestamp: Date.now(),
    };
  }

  _computeStatus(mem, totalMem, usedMem) {
    const memPercent = (usedMem / totalMem) * 100;
    const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;

    if (memPercent > 95 || heapPercent > 95 || this._eventLoopLag > 500) {
      return 'unhealthy';
    }
    if (memPercent > this.alertThresholds.memoryPercent ||
        heapPercent > this.alertThresholds.heapPercent ||
        this._eventLoopLag > this.alertThresholds.eventLoopLag) {
      return 'degraded';
    }
    return 'healthy';
  }

  _getProjectsSize() {
    try {
      if (!fs.existsSync(PROJECTS_DIR)) return 0;
      return this._dirSize(PROJECTS_DIR);
    } catch {
      return 0;
    }
  }

  _dirSize(dir) {
    let size = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          size += this._dirSize(fullPath);
        } else {
          try {
            size += fs.statSync(fullPath).size;
          } catch { /* ignorieren */ }
        }
      }
    } catch { /* ignorieren */ }
    return size;
  }

  getHealthHistory(minutes = 30) {
    if (!minutes || minutes <= 0) return this._history.slice();
    const cutoff = Date.now() - (minutes * 60 * 1000);
    return this._history.filter(h => h.timestamp >= cutoff);
  }

  getDiagnostics() {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      loadedModules: Object.keys(require.cache).length,
      eventLoopLag: this._eventLoopLag,
      gcStats: typeof global.gc === 'function' ? 'available' : 'unavailable',
      openFileDescriptors: this._estimateOpenFDs(),
      pid: process.pid,
      cwd: process.cwd(),
      memoryDetailed: process.memoryUsage(),
    };
  }

  _estimateOpenFDs() {
    // Approximation: unter Linux kann man /proc/self/fd lesen
    try {
      if (process.platform === 'linux') {
        return fs.readdirSync('/proc/self/fd').length;
      }
    } catch { /* ignorieren */ }
    // Fallback: Anzahl aktiver Handle als Schaetzung
    if (typeof process._getActiveHandles === 'function') {
      return process._getActiveHandles().length;
    }
    return -1;
  }

  setAlertThreshold(metric, value) {
    const validMetrics = ['memoryPercent', 'heapPercent', 'eventLoopLag', 'diskSize'];
    if (!validMetrics.includes(metric)) {
      throw new Error(`Ungueltige Metrik: ${metric}. Gueltig: ${validMetrics.join(', ')}`);
    }
    if (typeof value !== 'number' || value <= 0) {
      throw new Error(`Wert muss eine positive Zahl sein`);
    }
    this.alertThresholds[metric] = value;
  }

  getAlerts() {
    return this._alerts.filter(a => !a.cleared);
  }

  getAllAlerts() {
    return this._alerts.slice();
  }

  clearAlert(id) {
    const alert = this._alerts.find(a => a.id === id);
    if (!alert) return false;
    alert.cleared = true;
    alert.clearedAt = Date.now();
    this.emit('alert_cleared', alert);
    return true;
  }

  getThresholds() {
    return Object.assign({}, this.alertThresholds);
  }
}

module.exports = HealthMonitor;
