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

export async function getCrmData() {
  if (!pool) return { vacancies: [], candidates: [] };
  const [vacanciesResult, candidatesResult] = await Promise.all([
    pool.query(`SELECT id, hh_id, name, status, alternate_url, synced_at
      FROM vacancies WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, hh_negotiation_id, hh_resume_id, hh_vacancy_id, name, stage, score, payload, updated_at
      FROM candidates ORDER BY updated_at DESC`),
  ]);
  const vacancyNames = new Map(vacanciesResult.rows.map(row => [row.hh_id, row.name]));
  return {
    vacancies: vacanciesResult.rows.map(row => ({
      id: Number(row.id),
      hhId: row.hh_id,
      name: row.name,
      status: row.status,
      url: row.alternate_url,
      syncedAt: row.synced_at,
    })),
    candidates: candidatesResult.rows.map(row => {
      const resume = row.payload?.resume || {};
      const salary = resume.salary;
      return {
        id: Number(row.id),
        hhNegotiationId: row.hh_negotiation_id,
        hhResumeId: row.hh_resume_id,
        name: row.name,
        role: resume.title || 'Кандидат',
        vacancy: vacancyNames.get(row.hh_vacancy_id) || `Вакансия ${row.hh_vacancy_id}`,
        stage: row.stage,
        score: row.score,
        location: resume.area?.name || 'Не указано',
        salary: salary ? `${salary.amount || salary.from || salary.to || ''} ${salary.currency || ''}`.trim() : 'Не указано',
        experience: resume.total_experience?.months ? `${Math.floor(resume.total_experience.months / 12)} лет` : 'Не указано',
        updatedAt: row.updated_at,
      };
    }),
  };
}

export async function updateCandidateStage(id, stage) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const allowed = ['Новый', 'Скрининг', 'Диалог', 'Интервью', 'Оффер', 'Нанят', 'Отказ'];
  if (!allowed.includes(stage)) throw new Error('Unknown candidate stage');
  const result = await pool.query(
    'UPDATE candidates SET stage=$1, updated_at=NOW() WHERE id=$2 RETURNING id, stage',
    [stage, id],
  );
  if (!result.rowCount) throw new Error('Candidate not found');
  return { id: Number(result.rows[0].id), stage: result.rows[0].stage };
}
