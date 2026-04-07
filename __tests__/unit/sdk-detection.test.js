// SDK Detection - Unit Tests
// Testet SDK-Erkennung und Auto-Modus Fallback

'use strict';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('SDK Detection', () => {
  let sdkModule;

  beforeEach(() => {
    jest.resetModules();
    sdkModule = require('../../src/claude-sdk');
    sdkModule._resetSDKState();
  });

  test('detectSDK gibt boolean zurueck', async () => {
    const result = await sdkModule.detectSDK();
    expect(typeof result).toBe('boolean');
  });

  test('isSDKAvailable ist null vor Detection', () => {
    expect(sdkModule.isSDKAvailable()).toBeNull();
  });

  test('isSDKAvailable ist boolean nach Detection', async () => {
    await sdkModule.detectSDK();
    expect(typeof sdkModule.isSDKAvailable()).toBe('boolean');
  });

  test('getSDKInfo hat korrekte Struktur', () => {
    const info = sdkModule.getSDKInfo();
    expect(info).toHaveProperty('available');
    expect(info).toHaveProperty('detected');
    expect(info).toHaveProperty('version');
    expect(typeof info.available).toBe('boolean');
    expect(typeof info.detected).toBe('boolean');
  });

  test('getSDKInfo zeigt detected=false vor Detection', () => {
    expect(sdkModule.getSDKInfo().detected).toBe(false);
  });

  test('getSDKInfo zeigt detected=true nach Detection', async () => {
    await sdkModule.detectSDK();
    expect(sdkModule.getSDKInfo().detected).toBe(true);
  });

  test('mehrfache Detection liefert gleiches Ergebnis', async () => {
    const r1 = await sdkModule.detectSDK();
    const r2 = await sdkModule.detectSDK();
    const r3 = await sdkModule.detectSDK();
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  test('_resetSDKState setzt alles zurueck', async () => {
    await sdkModule.detectSDK();
    const infoBefore = sdkModule.getSDKInfo();
    expect(infoBefore.detected).toBe(true);

    sdkModule._resetSDKState();
    const infoAfter = sdkModule.getSDKInfo();
    expect(infoAfter.detected).toBe(false);
    expect(infoAfter.available).toBe(false);
    expect(infoAfter.version).toBeNull();
    expect(sdkModule.isSDKAvailable()).toBeNull();
  });

  test('Detection ist idempotent nach Reset', async () => {
    await sdkModule.detectSDK();
    sdkModule._resetSDKState();
    const result = await sdkModule.detectSDK();
    expect(typeof result).toBe('boolean');
    expect(sdkModule.getSDKInfo().detected).toBe(true);
  });
});
