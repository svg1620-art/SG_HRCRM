import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { databaseStatus, migrate } from './database.mjs';
import { completeAuthorization, createAuthorizationUrl, integrationStatus, syncIncoming } from './hh.mjs';

const root = join(process.cwd(), 'dist');
const port = Number(process.env.PORT || 3000);
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

await migrate();

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  try {
    if (pathname === '/api/health') return json(response, 200, { ok: true, database: await databaseStatus() });
    if (pathname === '/api/hh/status') return json(response, 200, { hh: await integrationStatus(), database: await databaseStatus() });
    if (pathname === '/api/hh/connect') {
      response.writeHead(302, { Location: await createAuthorizationUrl(), 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (pathname === '/api/hh/callback') {
      const url = new URL(request.url || '/', 'http://localhost');
      if (!url.searchParams.get('code') || !url.searchParams.get('state')) throw new Error(url.searchParams.get('error') || 'OAuth callback is incomplete');
      await completeAuthorization(url.searchParams.get('code'), url.searchParams.get('state'));
      response.writeHead(302, { Location: '/?hh=connected' });
      return response.end();
    }
    if (pathname === '/api/hh/sync' && request.method === 'POST') return json(response, 200, await syncIncoming());
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error.message });
  }
  const requested = normalize(join(root, pathname));
  const file = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : join(root, 'index.html');

  response.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(response);
}).listen(port, '0.0.0.0', () => {
  console.log(`SG HRCRM listening on 0.0.0.0:${port}`);
});
