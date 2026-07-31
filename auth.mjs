import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './database.mjs';

const scrypt = promisify(scryptCallback);
const sessionDays = 14;

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored).split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

const tokenHash = token => createHash('sha256').update(token).digest('hex');

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export async function ensureBootstrapAdmin() {
  if (!pool) return;
  const username = process.env.CRM_USERNAME?.trim();
  const password = process.env.CRM_PASSWORD?.trim();
  if (!username || !password) return;
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  if (count.rows[0].count) return;
  await pool.query(
    `INSERT INTO admin_users(username,display_name,password_hash,role)
      VALUES($1,$2,$3,'owner')`,
    [username.toLowerCase(), 'Владелец', await hashPassword(password)],
  );
}

export async function currentUser(request) {
  if (!pool) return null;
  const token = cookieValue(request, 'sg_session');
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id,u.username,u.display_name,u.role
      FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE`,
    [tokenHash(token)],
  );
  return result.rowCount ? {
    id: Number(result.rows[0].id),
    username: result.rows[0].username,
    displayName: result.rows[0].display_name,
    role: result.rows[0].role,
  } : null;
}

export async function login(username, password) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const result = await pool.query(
    'SELECT id,username,display_name,password_hash,role FROM admin_users WHERE username=$1 AND active=TRUE',
    [String(username || '').trim().toLowerCase()],
  );
  if (!result.rowCount || !await verifyPassword(String(password || ''), result.rows[0].password_hash)) {
    throw new Error('Неверный логин или пароль');
  }
  const token = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM admin_sessions WHERE expires_at<NOW()');
  await pool.query(
    `INSERT INTO admin_sessions(token_hash,user_id,expires_at)
      VALUES($1,$2,NOW()+($3 || ' days')::interval)`,
    [tokenHash(token), result.rows[0].id, String(sessionDays)],
  );
  return {
    token,
    user: {
      id: Number(result.rows[0].id),
      username: result.rows[0].username,
      displayName: result.rows[0].display_name,
      role: result.rows[0].role,
    },
  };
}

export async function logout(request) {
  const token = cookieValue(request, 'sg_session');
  if (pool && token) await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [tokenHash(token)]);
}

export async function listAdmins() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const result = await pool.query(
    'SELECT id,username,display_name,role,active,created_at FROM admin_users ORDER BY created_at',
  );
  return result.rows.map(row => ({
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  }));
}

export async function createAdmin(input) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const username = String(input?.username || '').trim().toLowerCase();
  const displayName = String(input?.displayName || '').trim();
  const password = String(input?.password || '');
  if (!/^[a-z0-9._@+-]{3,80}$/.test(username)) throw new Error('Логин: 3–80 латинских символов');
  if (!displayName || displayName.length > 100) throw new Error('Укажите имя администратора');
  if (password.length < 10) throw new Error('Пароль должен содержать минимум 10 символов');
  try {
    const result = await pool.query(
      `INSERT INTO admin_users(username,display_name,password_hash,role)
        VALUES($1,$2,$3,'admin') RETURNING id`,
      [username, displayName, await hashPassword(password)],
    );
    return { id: Number(result.rows[0].id) };
  } catch (error) {
    if (error.code === '23505') throw new Error('Такой логин уже существует');
    throw error;
  }
}

export async function setAdminActive(id, active, actor) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  if (Number(id) === actor.id && !active) throw new Error('Нельзя отключить собственную учётную запись');
  const result = await pool.query(
    `UPDATE admin_users SET active=$1 WHERE id=$2 AND role<>'owner' RETURNING id`,
    [Boolean(active), id],
  );
  if (!result.rowCount) throw new Error('Администратор не найден или является владельцем');
  if (!active) await pool.query('DELETE FROM admin_sessions WHERE user_id=$1', [id]);
  return { id: Number(id), active: Boolean(active) };
}

export async function changePassword(userId, currentPassword, newPassword) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  if (String(newPassword || '').length < 10) throw new Error('Новый пароль должен содержать минимум 10 символов');
  const result = await pool.query('SELECT password_hash FROM admin_users WHERE id=$1 AND active=TRUE', [userId]);
  if (!result.rowCount || !await verifyPassword(String(currentPassword || ''), result.rows[0].password_hash)) {
    throw new Error('Текущий пароль указан неверно');
  }
  await pool.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [await hashPassword(newPassword), userId]);
  await pool.query('DELETE FROM admin_sessions WHERE user_id=$1', [userId]);
  return { ok: true };
}
