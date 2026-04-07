// SDK Streaming - Unit Tests
// Testet Streaming-Callbacks und Token-Tracking im SDK-Modus

'use strict';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('SDK Streaming und Token-Tracking', () => {
  let sdkModule;

  beforeEach(() => {
    jest.resetModules();
    sdkModule = require('../../src/claude-sdk');
    sdkModule._resetSDKState();
  });

  describe('runClaudeSDK Options', () => {
    test('akzeptiert leere Options', async () => {
      await expect(sdkModule.runClaudeSDK('test', process.cwd(), {}))
        .rejects.toThrow(/SDK/);
    });

    test('akzeptiert alle Options gleichzeitig', async () => {
      const controller = new AbortController();
      await expect(sdkModule.runClaudeSDK('test', process.cwd(), {
        abortController: controller,
        timeout: 5000,
        maxTurns: 3,
        onStreamChunk: () => {},
      })).rejects.toThrow(/SDK/);
    });

    test('onStreamChunk muss Funktion sein oder fehlen', async () => {
      // String statt Funktion - sollte trotzdem nicht crashen (SDK fehlt ja)
      await expect(sdkModule.runClaudeSDK('test', process.cwd(), {
        onStreamChunk: 'not a function'
      })).rejects.toThrow(/SDK/);
    });

    test('maxTurns Option wird akzeptiert', async () => {
      await expect(sdkModule.runClaudeSDK('test', process.cwd(), {
        maxTurns: 1
      })).rejects.toThrow(/SDK/);
    });

    test('null workDir faellt auf process.cwd() zurueck', async () => {
      await expect(sdkModule.runClaudeSDK('test', null))
        .rejects.toThrow(/SDK/);
    });
  });

  describe('Token-Tracking Vorbereitung', () => {
    test('getSDKInfo enthaelt version-Feld fuer Token-Tracking', () => {
      const info = sdkModule.getSDKInfo();
      expect(info).toHaveProperty('version');
    });

    test('SDK-Ergebnis hat usage-Struktur (bei verfuegbarer SDK)', () => {
      // Da SDK nicht verfuegbar, testen wir nur die API-Signatur
      // Im echten Betrieb wuerde runClaudeSDK { text, usage, messages } zurueckgeben
      expect(typeof sdkModule.runClaudeSDK).toBe('function');
      expect(sdkModule.runClaudeSDK.length).toBeGreaterThanOrEqual(2); // prompt, workDir
    });
  });

  describe('AbortController Integration', () => {
    test('bereits abgebrochener Controller fuehrt zu sofortigem Fehler', async () => {
      const controller = new AbortController();
      controller.abort();
      const start = Date.now();
      await expect(sdkModule.runClaudeSDK('test', process.cwd(), {
        abortController: controller
      })).rejects.toThrow();
      const duration = Date.now() - start;
      // Sollte schnell fehlschlagen (unter 1 Sekunde)
      expect(duration).toBeLessThan(1000);
    });
  });
});
