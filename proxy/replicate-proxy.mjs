// Minimal CORS proxy for the Replicate API. It does exactly one thing:
// forward every incoming request verbatim to https://api.replicate.com and add
// CORS headers to the response so the browser app can call it directly.
//
// It is NOT a general open proxy: the upstream host is hard-coded, so it can
// only ever talk to Replicate. No logging of bodies, no auth handling, no
// caching, no rewriting — nothing else.
//
//   node proxy/replicate-proxy.mjs        (or: npm run proxy)
//
// Then set the app's "Proxy URL" field to  http://localhost:8787/v1

import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT) || 8787;
// Bind to loopback by default so the proxy isn't an open Replicate relay for
// anyone else on the LAN. Override with HOST=0.0.0.0 only if you deliberately
// want to expose it.
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM_HOST = 'api.replicate.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer, Accept',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer((req, res) => {
  // Preflight — answer directly, never forwarded.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const headers = { ...req.headers, host: UPSTREAM_HOST };
  delete headers.origin;
  delete headers.referer;

  const upstream = https.request(
    { host: UPSTREAM_HOST, port: 443, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, { ...up.headers, ...CORS_HEADERS });
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: `Proxy upstream error: ${err.message}` }));
  });

  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`Replicate CORS proxy → https://${UPSTREAM_HOST}`);
  console.log(`Listening on http://${HOST}:${PORT} (bound to ${HOST})`);
  console.log(`Set the app's "Proxy URL" field to  http://localhost:${PORT}/v1`);
});
