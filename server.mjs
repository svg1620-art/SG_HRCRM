import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import {
  databaseStatus,
  getDialogueConfig,
  getCrmData,
  getScoringCriteria,
  migrate,
  replaceScoringCriteria,
  saveDialogueConfig,
  updateCandidateStage,
} from './database.mjs';
import { completeAuthorization, createAuthorizationUrl, integrationStatus, syncIncoming } from './hh.mjs';
import { scoreVacancyCandidates } from './ai.mjs';
import { dialogueStats, syncAutomatedDialogues } from './dialogue.mjs';
import {
  changePassword,
  createAdmin,
  currentUser,
  ensureBootstrapAdmin,
  listAdmins,
  login,
  logout,
  setAdminActive,
} from './auth.mjs';

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
await ensureBootstrapAdmin();
const dialogueTimer = setInterval(() => {
  syncAutomatedDialogues().catch(error => console.error('Dialogue background sync failed', error));
}, 60_000);
dialogueTimer.unref();

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_768) throw new Error('Request body is too large');
  }
  return body ? JSON.parse(body) : {};
}

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  try {
    if (pathname === '/api/health') return json(response, 200, { ok: true, database: await databaseStatus() });
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readJson(request);
      const result = await login(body.username, body.password);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `sg_session=${encodeURIComponent(result.token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600`,
      });
      return response.end(JSON.stringify({ user: result.user }));
    }
    if (pathname === '/api/hh/callback') {
      const url = new URL(request.url || '/', 'http://localhost');
      if (!url.searchParams.get('code') || !url.searchParams.get('state')) throw new Error(url.searchParams.get('error') || 'OAuth callback is incomplete');
      await completeAuthorization(url.searchParams.get('code'), url.searchParams.get('state'));
      response.writeHead(302, { Location: '/?hh=connected' });
      return response.end();
    }
    const user = await currentUser(request);
    if (pathname === '/api/auth/status') return json(response, 200, { authenticated: Boolean(user), user });
    if (pathname.startsWith('/api/') && !user) return json(response, 401, { error: 'Требуется вход' });
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      await logout(request);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'sg_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      });
      return response.end('{"ok":true}');
    }
    if (pathname === '/api/auth/password' && request.method === 'POST') {
      const body = await readJson(request);
      const result = await changePassword(user.id, body.currentPassword, body.newPassword);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'sg_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      });
      return response.end(JSON.stringify(result));
    }
    if (pathname === '/api/admins' && request.method === 'GET') {
      if (user.role !== 'owner') return json(response, 403, { error: 'Только владелец может управлять администраторами' });
      return json(response, 200, { admins: await listAdmins() });
    }
    if (pathname === '/api/admins' && request.method === 'POST') {
      if (user.role !== 'owner') return json(response, 403, { error: 'Только владелец может управлять администраторами' });
      return json(response, 201, await createAdmin(await readJson(request)));
    }
    const adminActiveMatch = pathname.match(/^\/api\/admins\/(\d+)\/active$/);
    if (adminActiveMatch && request.method === 'PATCH') {
      if (user.role !== 'owner') return json(response, 403, { error: 'Только владелец может управлять администраторами' });
      const body = await readJson(request);
      return json(response, 200, await setAdminActive(Number(adminActiveMatch[1]), body.active, user));
    }
    if (pathname === '/api/crm') return json(response, 200, await getCrmData());
    const stageMatch = pathname.match(/^\/api\/candidates\/(\d+)\/stage$/);
    if (stageMatch && request.method === 'PATCH') {
      const body = await readJson(request);
      return json(response, 200, await updateCandidateStage(Number(stageMatch[1]), body.stage));
    }
    const criteriaMatch = pathname.match(/^\/api\/vacancies\/(\d+)\/criteria$/);
    if (criteriaMatch && request.method === 'GET') {
      return json(response, 200, await getScoringCriteria(Number(criteriaMatch[1])));
    }
    if (criteriaMatch && request.method === 'PUT') {
      const body = await readJson(request);
      return json(response, 200, await replaceScoringCriteria(Number(criteriaMatch[1]), body.criteria));
    }
    const scoreMatch = pathname.match(/^\/api\/vacancies\/(\d+)\/score$/);
    if (scoreMatch && request.method === 'POST') {
      return json(response, 200, await scoreVacancyCandidates(Number(scoreMatch[1])));
    }
    const dialogueConfigMatch = pathname.match(/^\/api\/vacancies\/(\d+)\/dialogue$/);
    if (dialogueConfigMatch && request.method === 'GET') {
      const vacancyId = Number(dialogueConfigMatch[1]);
      return json(response, 200, {
        ...await getDialogueConfig(vacancyId),
        stats: await dialogueStats(vacancyId),
      });
    }
    if (dialogueConfigMatch && request.method === 'PUT') {
      const body = await readJson(request);
      return json(response, 200, await saveDialogueConfig(Number(dialogueConfigMatch[1]), body));
    }
    if (pathname === '/api/dialogues/sync' && request.method === 'POST') {
      return json(response, 200, await syncAutomatedDialogues());
    }
    if (pathname === '/api/hh/status') return json(response, 200, { hh: await integrationStatus(), database: await databaseStatus() });
    if (pathname === '/api/hh/connect') {
      response.writeHead(302, { Location: await createAuthorizationUrl(), 'Cache-Control': 'no-store' });
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
