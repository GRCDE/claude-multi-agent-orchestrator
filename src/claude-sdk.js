'use strict';
const logger = require('./logger');

// SDK-Zustand (gecacht nach erstem Aufruf)
let _sdkAvailable = null;
let _sdkModule = null;

/**
 * Erkennt ob das Claude Code SDK installiert und importierbar ist.
 * Ergebnis wird nach dem ersten Aufruf gecacht.
 * @returns {Promise<boolean>}
 */
async function detectSDK() {
  if (_sdkAvailable !== null) return _sdkAvailable;
  try {
    _sdkModule = await import('@anthropic-ai/claude-code');
    _sdkAvailable = true;
    logger.info('Claude Code SDK erkannt', { version: _sdkModule.version || 'unknown' });
    return true;
  } catch (e) {
    _sdkAvailable = false;
    logger.info('Claude Code SDK nicht verfügbar, CLI-Modus wird verwendet', { error: e.message });
    return false;
  }
}

/**
 * Führt einen Claude-Prompt via SDK aus.
 * Gibt { text, usage, messages } zurück:
 *   - text: String-Output (aus letzter Assistant-Nachricht extrahiert)
 *   - usage: { inputTokens, outputTokens } aggregiert über alle Nachrichten
 *   - messages: rohes Nachrichten-Array vom SDK
 *
 * @param {string} prompt
 * @param {string} workDir
 * @param {object} options - { abortController, maxTurns, onStreamChunk, timeout }
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number}, messages: Array}>}
 */
async function runClaudeSDK(prompt, workDir, options = {}) {
  if (!_sdkModule) {
    const available = await detectSDK();
    if (!available) throw new Error('Claude Code SDK nicht verfügbar. Installiere mit: npm install @anthropic-ai/claude-code');
  }

  const { query } = _sdkModule;
  const controller = options.abortController || new AbortController();

  // Timeout-Behandlung
  let timer = null;
  if (options.timeout) {
    timer = setTimeout(() => {
      controller.abort();
    }, options.timeout);
  }

  try {
    const queryOpts = {
      prompt,
      options: {
        dangerouslySkipPermissions: true,
        cwd: workDir || process.cwd(),
        maxTurns: options.maxTurns || 10,
      },
      abortController: controller,
    };

    // Streaming-Callback fuer Live-Output
    if (options.onStreamChunk && typeof options.onStreamChunk === 'function') {
      queryOpts.onMessage = (msg) => {
        if (msg.role === 'assistant' && msg.content) {
          const text = Array.isArray(msg.content)
            ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
            : (typeof msg.content === 'string' ? msg.content : '');
          if (text) options.onStreamChunk(text);
        }
      };
    }

    const messages = await query(queryOpts);

    // Text aus letzter Assistant-Nachricht extrahieren
    const assistantMsgs = (messages || []).filter(m => m.role === 'assistant');
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];

    let text = '';
    if (lastMsg) {
      if (Array.isArray(lastMsg.content)) {
        text = lastMsg.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
      } else if (typeof lastMsg.content === 'string') {
        text = lastMsg.content;
      }
    }

    // Token-Verbrauch ueber alle Nachrichten aggregieren
    let inputTokens = 0;
    let outputTokens = 0;
    for (const msg of (messages || [])) {
      if (msg.usage) {
        inputTokens += msg.usage.input_tokens || 0;
        outputTokens += msg.usage.output_tokens || 0;
      }
    }

    return {
      text: text.trim(),
      usage: { inputTokens, outputTokens },
      messages: messages || [],
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Prueft ob das SDK verfuegbar ist (synchron, nutzt gecachtes Ergebnis).
 * Gibt null zurueck wenn die Erkennung noch nicht gelaufen ist.
 */
function isSDKAvailable() {
  return _sdkAvailable;
}

/**
 * Gibt SDK-Versionsinformationen zurueck (falls verfuegbar).
 */
function getSDKInfo() {
  return {
    available: _sdkAvailable === true,
    detected: _sdkAvailable !== null,
    version: _sdkModule ? (_sdkModule.version || 'unknown') : null,
  };
}

/**
 * Setzt den SDK-Erkennungsstatus zurueck (fuer Tests).
 */
function _resetSDKState() {
  _sdkAvailable = null;
  _sdkModule = null;
}

module.exports = {
  detectSDK,
  runClaudeSDK,
  isSDKAvailable,
  getSDKInfo,
  _resetSDKState,
};
