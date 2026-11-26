// static-server: serves public/ read-only with Node.js built-ins only.
//
//   PORT=8080 node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// The file under public/ a request path names, or null.
function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

function send(res, status, body, type = 'text/plain; charset=utf-8', head = false) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : body);
}

const server = http.createServer((req, res) => {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.setHeader('Allow', 'GET, HEAD');
    send(res, 405, 'Method Not Allowed\n');
    return;
  }
  const file = resolveFile(req.url || '/');
  if (!file) { send(res, 404, 'Not Found\n', undefined, head); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { send(res, 404, 'Not Found\n', undefined, head); return; }
    fs.readFile(file, (err2, data) => {
      if (err2) { send(res, 404, 'Not Found\n', undefined, head); return; }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      send(res, 200, data, type, head);
    });
  });
});

server.listen(port, () => {
  console.log(`Workshop Cut Planner on http://localhost:${port}/`);
});
