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
    ALTER TABLE candidates ADD COLUMN IF NOT EXISTS score_details JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE candidates ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;
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
    pool.query(`SELECT id, hh_negotiation_id, hh_resume_id, hh_vacancy_id, name, stage, score, score_details, payload, updated_at
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
        factors: row.score_details || [],
        location: resume.area?.name || 'Не указано',
        salary: salary ? `${salary.amount || salary.from || salary.to || ''} ${salary.currency || ''}`.trim() : 'Не указано',
        experience: resume.total_experience?.months ? `${Math.floor(resume.total_experience.months / 12)} лет` : 'Не указано',
        updatedAt: row.updated_at,
      };
    }),
  };
}

export async function getCandidatesForScoring(vacancyId, limit = 10) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const vacancyResult = await pool.query(
    'SELECT id, hh_id, name, payload FROM vacancies WHERE id=$1',
    [vacancyId],
  );
  if (!vacancyResult.rowCount) throw new Error('Vacancy not found');
  const criteriaResult = await getScoringCriteria(vacancyId);
  if (!criteriaResult.criteria.length) throw new Error('Configure scoring criteria first');
  const candidatesResult = await pool.query(
    `SELECT id, name, payload
      FROM candidates
      WHERE hh_vacancy_id=$1 AND score IS NULL
      ORDER BY updated_at DESC
      LIMIT $2`,
    [vacancyResult.rows[0].hh_id, limit],
  );
  return {
    vacancy: vacancyResult.rows[0],
    criteria: criteriaResult.criteria,
    candidates: candidatesResult.rows,
  };
}

export async function saveCandidateScore(candidateId, score, factors) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const result = await pool.query(
    `UPDATE candidates
      SET score=$1, score_details=$2, scored_at=NOW(), updated_at=NOW()
      WHERE id=$3 RETURNING id`,
    [score, JSON.stringify(factors), candidateId],
  );
  if (!result.rowCount) throw new Error('Candidate not found');
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

export async function getScoringCriteria(vacancyId) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const vacancyResult = await pool.query(
    'SELECT id, name FROM vacancies WHERE id=$1',
    [vacancyId],
  );
  if (!vacancyResult.rowCount) throw new Error('Vacancy not found');
  const criteriaResult = await pool.query(
    `SELECT id, name, description, weight, position
      FROM scoring_criteria
      WHERE vacancy_id=$1
      ORDER BY position, id`,
    [vacancyId],
  );
  return {
    vacancy: {
      id: Number(vacancyResult.rows[0].id),
      name: vacancyResult.rows[0].name,
    },
    criteria: criteriaResult.rows.map(row => ({
      id: Number(row.id),
      name: row.name,
      description: row.description,
      weight: row.weight,
      position: row.position,
    })),
  };
}

export async function replaceScoringCriteria(vacancyId, criteria) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  if (!Array.isArray(criteria) || criteria.length > 20) throw new Error('Invalid criteria list');
  const normalized = criteria.map((item, position) => {
    const name = String(item?.name || '').trim();
    const description = String(item?.description || '').trim();
    const weight = Number(item?.weight);
    if (!name || name.length > 120) throw new Error('Each criterion must have a name');
    if (description.length > 1500) throw new Error('Criterion description is too long');
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) throw new Error('Weight must be between 0 and 100');
    return { name, description, weight, position };
  });
  const total = normalized.reduce((sum, item) => sum + item.weight, 0);
  if (normalized.length && total !== 100) throw new Error('Criteria weights must add up to 100');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vacancyResult = await client.query('SELECT id FROM vacancies WHERE id=$1', [vacancyId]);
    if (!vacancyResult.rowCount) throw new Error('Vacancy not found');
    await client.query('DELETE FROM scoring_criteria WHERE vacancy_id=$1', [vacancyId]);
    for (const item of normalized) {
      await client.query(
        `INSERT INTO scoring_criteria (vacancy_id, name, description, weight, position)
          VALUES ($1, $2, $3, $4, $5)`,
        [vacancyId, item.name, item.description, item.weight, item.position],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getScoringCriteria(vacancyId);
}
