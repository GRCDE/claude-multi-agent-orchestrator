'use strict';

const http = require('http');

const PORT = 3132;
let requestCount = 0;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Nur POST erlaubt');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requestCount++;
    const timestamp = new Date().toLocaleTimeString('de-DE');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`#${requestCount} │ ${timestamp} │ ${req.method} ${req.url}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      const parsed = JSON.parse(body);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('(Kein gültiges JSON)');
      console.log(body);
    }

    console.log(`${'─'.repeat(60)}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, () => {
  console.log(`\nWebhook-Test-Server läuft auf http://localhost:${PORT}`);
  console.log('Setze WEBHOOK_URL=http://localhost:' + PORT + ' in deiner .env');
  console.log('Warte auf eingehende Webhooks...\n');
});
