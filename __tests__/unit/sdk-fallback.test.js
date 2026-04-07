// SDK Fallback - Unit Tests
// Testet Auto-Modus Fallback-Logik und Fehlerbehandlung

'use strict';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('SDK Fallback-Logik', () => {
  let sdkModule;

  beforeEach(() => {
    jest.resetModules();
    sdkModule = require('../../src/claude-sdk');
    sdkModule._resetSDKState();
  });

  test('runClaudeSDK schlaegt fehl wenn SDK nicht installiert', async () => {
    await expect(sdkModule.runClaudeSDK('test prompt', process.cwd()))
      .rejects.toThrow(/SDK/);
  });

  test('runClaudeSDK Fehler enthaelt Installationshinweis', async () => {
    try {
      await sdkModule.runClaudeSDK('test', process.cwd());
      fail('Sollte Fehler werfen');
    } catch (e) {
      expect(e.message).toMatch(/npm install|SDK/i);
    }
  });

  test('detectSDK gibt false zurueck in Test-Umgebung', async () => {
    const available = await sdkModule.detectSDK();
    // In Test-Umgebung ist SDK normalerweise nicht installiert
    expect(available).toBe(false);
  });

  test('isSDKAvailable ist false nach fehlgeschlagener Detection', async () => {
    await sdkModule.detectSDK();
    expect(sdkModule.isSDKAvailable()).toBe(false);
  });

  test('getSDKInfo zeigt nicht-verfuegbar nach fehlgeschlagener Detection', async () => {
    await sdkModule.detectSDK();
    const info = sdkModule.getSDKInfo();
    expect(info.available).toBe(false);
    expect(info.detected).toBe(true);
    expect(info.version).toBeNull();
  });

  test('runClaudeSDK mit Timeout-Option wirft nach Ablauf', async () => {
    // SDK ist nicht verfuegbar, also wird es sofort fehlschlagen
    // Aber der Timeout-Parameter sollte akzeptiert werden
    await expect(sdkModule.runClaudeSDK('test', process.cwd(), { timeout: 1000 }))
      .rejects.toThrow();
  });

  test('runClaudeSDK mit abgebrochenem AbortController', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sdkModule.runClaudeSDK('test', process.cwd(), { abortController: controller }))
      .rejects.toThrow();
  });

  test('runClaudeSDK akzeptiert onStreamChunk Option', async () => {
    const chunks = [];
    await expect(sdkModule.runClaudeSDK('test', process.cwd(), {
      onStreamChunk: (chunk) => chunks.push(chunk)
    })).rejects.toThrow();
    // Keine Chunks da SDK nicht verfuegbar
    expect(chunks).toHaveLength(0);
  });

  test('mehrfache fehlgeschlagene runClaudeSDK-Aufrufe sind stabil', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(sdkModule.runClaudeSDK('test ' + i, process.cwd()))
        .rejects.toThrow(/SDK/);
    }
    // State ist konsistent
    expect(sdkModule.isSDKAvailable()).toBe(false);
  });
});
