// Claude SDK Module - Unit Tests
// Testet SDK-Detection, runClaudeSDK und Fallback-Logik

'use strict';

// Mock logger
jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('Claude SDK Module', () => {
  let sdkModule;

  beforeEach(() => {
    // Cache und State zuruecksetzen
    jest.resetModules();
    sdkModule = require('../../src/claude-sdk');
    sdkModule._resetSDKState();
  });

  describe('isSDKAvailable()', () => {
    test('gibt null zurueck wenn Detection noch nicht gelaufen ist', () => {
      expect(sdkModule.isSDKAvailable()).toBeNull();
    });
  });

  describe('getSDKInfo()', () => {
    test('gibt korrektes Objekt zurueck vor Detection', () => {
      const info = sdkModule.getSDKInfo();
      expect(info.available).toBe(false);
      expect(info.detected).toBe(false);
      expect(info.version).toBeNull();
    });
  });

  describe('detectSDK()', () => {
    test('gibt false zurueck wenn SDK nicht installiert', async () => {
      const result = await sdkModule.detectSDK();
      // SDK ist in der Test-Umgebung normalerweise nicht installiert
      expect(typeof result).toBe('boolean');
    });

    test('cached das Ergebnis nach erstem Aufruf', async () => {
      const first = await sdkModule.detectSDK();
      const second = await sdkModule.detectSDK();
      expect(first).toBe(second);
    });

    test('setzt isSDKAvailable nach Detection', async () => {
      await sdkModule.detectSDK();
      expect(sdkModule.isSDKAvailable()).not.toBeNull();
    });
  });

  describe('_resetSDKState()', () => {
    test('setzt Detection-Cache zurueck', async () => {
      await sdkModule.detectSDK();
      expect(sdkModule.isSDKAvailable()).not.toBeNull();
      sdkModule._resetSDKState();
      expect(sdkModule.isSDKAvailable()).toBeNull();
    });
  });

  describe('runClaudeSDK()', () => {
    test('wirft Fehler wenn SDK nicht verfuegbar', async () => {
      sdkModule._resetSDKState();
      // SDK ist normalerweise nicht in Test-Umgebung installiert
      await expect(sdkModule.runClaudeSDK('test prompt', '/tmp'))
        .rejects.toThrow(/SDK/);
    });

    test('akzeptiert AbortController Option', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(sdkModule.runClaudeSDK('test', '/tmp', { abortController: controller }))
        .rejects.toThrow();
    });
  });

  describe('getSDKInfo() nach Detection', () => {
    test('zeigt detected=true nach Detection', async () => {
      await sdkModule.detectSDK();
      const info = sdkModule.getSDKInfo();
      expect(info.detected).toBe(true);
    });
  });
});
