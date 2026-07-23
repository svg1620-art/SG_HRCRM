import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pool } from './database.mjs';

const userAgent = process.env.HH_USER_AGENT || 'SG-HRCRM/0.1 (serg@serviceguru.ru)';
const key = process.env.APP_ENCRYPTION_KEY ? createHash('sha256').update(process.env.APP_ENCRYPTION_KEY).digest() : null;
const env = name => process.env[name]?.trim();

function encrypt(value) {
  if (!key) throw new Error('APP_ENCRYPTION_KEY is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decrypt(value) {
  if (!key) throw new Error('APP_ENCRYPTION_KEY is not configured');
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function hhFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'HH-User-Agent': userAgent, Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!response.ok) throw new Error(`hh.ru ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export async function createAuthorizationUrl() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  if (!env('HH_CLIENT_ID') || !env('HH_REDIRECT_URI') || !key) throw new Error('hh.ru OAuth environment is incomplete');
  const state = randomBytes(24).toString('base64url');
  await pool.query('DELETE FROM oauth_states WHERE expires_at < NOW()');
  await pool.query('INSERT INTO oauth_states(state, provider, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'10 minutes\')', [state, 'hh']);
  const params = new URLSearchParams({ response_type: 'code', client_id: env('HH_CLIENT_ID'), redirect_uri: env('HH_REDIRECT_URI'), state });
  return `https://hh.ru/oauth/authorize?${params}`;
}

export async function completeAuthorization(code, state) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const valid = await pool.query('DELETE FROM oauth_states WHERE state=$1 AND provider=$2 AND expires_at > NOW() RETURNING state', [state, 'hh']);
  if (!valid.rowCount) throw new Error('OAuth state is invalid or expired');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: env('HH_CLIENT_ID'), client_secret: env('HH_CLIENT_SECRET'), code, redirect_uri: env('HH_REDIRECT_URI') });
  const tokenResponse = await fetch('https://api.hh.ru/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'HH-User-Agent': userAgent }, body });
  if (!tokenResponse.ok) throw new Error(`hh.ru token ${tokenResponse.status}: ${await tokenResponse.text()}`);
  const tokens = await tokenResponse.json();
  const me = await hhFetch('https://api.hh.ru/me', tokens.access_token);
  await pool.query(`INSERT INTO integrations(provider, access_token, refresh_token, expires_at, external_user_id, employer_id, metadata, updated_at)
    VALUES ('hh',$1,$2,NOW()+($3 || ' seconds')::interval,$4,$5,$6,NOW())
    ON CONFLICT(provider) DO UPDATE SET access_token=$1,refresh_token=$2,expires_at=NOW()+($3 || ' seconds')::interval,external_user_id=$4,employer_id=$5,metadata=$6,updated_at=NOW()`,
    [encrypt(tokens.access_token), tokens.refresh_token ? encrypt(tokens.refresh_token) : null, String(tokens.expires_in || 0), String(me.id || ''), String(me.employer?.id || ''), me]);
  return me;
}

export async function integrationStatus() {
  if (!pool) return { connected: false, reason: 'database' };
  const result = await pool.query("SELECT employer_id, metadata, updated_at FROM integrations WHERE provider='hh'");
  if (!result.rowCount) return { connected: false };
  return { connected: true, employerId: result.rows[0].employer_id, manager: result.rows[0].metadata, updatedAt: result.rows[0].updated_at };
}

export async function syncIncoming() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const integration = await pool.query("SELECT access_token, employer_id FROM integrations WHERE provider='hh'");
  if (!integration.rowCount) throw new Error('hh.ru is not connected');
  const token = decrypt(integration.rows[0].access_token);
  const employerId = integration.rows[0].employer_id;
  const vacancies = await hhFetch(`https://api.hh.ru/employers/${employerId}/vacancies/active?per_page=100`, token);
  let candidateCount = 0;
  for (const vacancy of vacancies.items || []) {
    await pool.query(`INSERT INTO vacancies(hh_id,name,status,alternate_url,payload,synced_at) VALUES($1,$2,'active',$3,$4,NOW())
      ON CONFLICT(hh_id) DO UPDATE SET name=$2,status='active',alternate_url=$3,payload=$4,synced_at=NOW()`, [vacancy.id, vacancy.name, vacancy.alternate_url, vacancy]);
    const negotiations = await hhFetch(`https://api.hh.ru/negotiations?vacancy_id=${encodeURIComponent(vacancy.id)}&status=active&per_page=100`, token);
    for (const item of negotiations.items || []) {
      const resume = item.resume || {};
      const name = [resume.first_name, resume.last_name].filter(Boolean).join(' ') || resume.title || 'Кандидат';
      await pool.query(`INSERT INTO candidates(hh_negotiation_id,hh_resume_id,hh_vacancy_id,name,payload,updated_at) VALUES($1,$2,$3,$4,$5,NOW())
        ON CONFLICT(hh_negotiation_id) DO UPDATE SET hh_resume_id=$2,hh_vacancy_id=$3,name=$4,payload=$5,updated_at=NOW()`, [item.id, resume.id || null, vacancy.id, name, item]);
      candidateCount += 1;
    }
  }
  return { vacancies: vacancies.items?.length || 0, candidates: candidateCount };
}
