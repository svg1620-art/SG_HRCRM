import pg from 'pg';

const { Pool } = pg;
export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined })
  : null;

export async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integrations (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      external_user_id TEXT,
      employer_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vacancies (
      id BIGSERIAL PRIMARY KEY,
      hh_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      alternate_url TEXT,
      payload JSONB NOT NULL DEFAULT '{}',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id BIGSERIAL PRIMARY KEY,
      hh_negotiation_id TEXT UNIQUE NOT NULL,
      hh_resume_id TEXT,
      hh_vacancy_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Кандидат',
      stage TEXT NOT NULL DEFAULT 'Новый',
      score INTEGER,
      payload JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scoring_criteria (
      id BIGSERIAL PRIMARY KEY,
      vacancy_id BIGINT REFERENCES vacancies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      weight INTEGER NOT NULL CHECK (weight BETWEEN 0 AND 100),
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS candidates_vacancy_idx ON candidates(hh_vacancy_id);
  `);
}

export async function databaseStatus() {
  if (!pool) return { configured: false, connected: false };
  try {
    await pool.query('SELECT 1');
    return { configured: true, connected: true };
  } catch (error) {
    return { configured: true, connected: false, error: error.message };
  }
}
