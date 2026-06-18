const https = require('https');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.resolve(__dirname, '..', 'logs', 'activity');

function logToFile(level, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 23);
    fs.appendFileSync(path.join(LOG_DIR, `${date}.log`), `[${time}] [${level}] ${msg}\n`);
  } catch { /* ignore */ }
}

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

const DEEPSEEK_MODELS = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro':   'DeepSeek V4 Pro',
};

/**
 * Run a prompt against DeepSeek API (OpenAI-compatible, streaming).
 * @param {string} message
 * @param {{ model?: string, onProgress?: Function, signal?: AbortSignal }} opts
 * @returns {Promise<{ response: string, model: string }>}
 */
const runDeepSeek = (message, { model = 'deepseek-chat', onProgress, signal } = {}) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: message }],
      stream: true,
      temperature: 0.7,
      max_tokens: 4096,
    });

    const url = new URL(DEEPSEEK_API_URL);
    const reqOptions = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 300000,
    };

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.on('data', (chunk) => { errorBody += chunk.toString(); });
        res.on('end', () => {
          logToFile('ERROR', `DeepSeek [${model}] HTTP ${res.statusCode}: ${errorBody.slice(0, 200)}`);
          reject(new Error(`DeepSeek API error: ${res.statusCode} — ${errorBody.slice(0, 100)}`));
        });
        return;
      }

      let response = '';
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              response += delta;
              if (onProgress) onProgress({ type: 'text', text: delta });
            }
          } catch { /* skip malformed SSE line */ }
        }
      });

      res.on('end', () => {
        logToFile('INFO', `DeepSeek [${model}] response: ${response.slice(0, 200)}`);
        resolve({ response: response.trim(), model });
      });

      res.on('error', (err) => {
        logToFile('ERROR', `DeepSeek [${model}] stream error: ${err.message}`);
        reject(err);
      });
    });

    req.on('error', (err) => {
      logToFile('ERROR', `DeepSeek [${model}] request error: ${err.message}`);
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DeepSeek request timeout'));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Request cancelled'));
      });
    }

    req.write(payload);
    req.end();
  });
};

module.exports = { runDeepSeek, DEEPSEEK_MODELS };
