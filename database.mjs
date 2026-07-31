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
    CREATE TABLE IF NOT EXISTS dialogue_configs (
      vacancy_id BIGINT PRIMARY KEY REFERENCES vacancies(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      greeting TEXT NOT NULL DEFAULT '',
      questions JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS candidate_dialogues (
      candidate_id BIGINT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      question_index INTEGER NOT NULL DEFAULT 0,
      last_applicant_message_id TEXT,
      transcript JSONB NOT NULL DEFAULT '[]',
      last_sent_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    `SELECT c.id, c.name, c.payload, COALESCE(cd.transcript, '[]') AS dialogue_transcript
      FROM candidates c
      LEFT JOIN candidate_dialogues cd ON cd.candidate_id=c.id
      WHERE c.hh_vacancy_id=$1 AND c.score IS NULL
      ORDER BY c.updated_at DESC
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

export async function getDialogueConfig(vacancyId) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const vacancyResult = await pool.query('SELECT id, name FROM vacancies WHERE id=$1', [vacancyId]);
  if (!vacancyResult.rowCount) throw new Error('Vacancy not found');
  const result = await pool.query(
    'SELECT enabled, greeting, questions, updated_at FROM dialogue_configs WHERE vacancy_id=$1',
    [vacancyId],
  );
  const config = result.rows[0] || {};
  return {
    vacancy: { id: Number(vacancyResult.rows[0].id), name: vacancyResult.rows[0].name },
    enabled: Boolean(config.enabled),
    greeting: config.greeting || 'Здравствуйте! Спасибо за отклик на нашу вакансию. Хотим задать несколько коротких вопросов.',
    questions: config.questions || [],
    updatedAt: config.updated_at || null,
  };
}

export async function saveDialogueConfig(vacancyId, input) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const greeting = String(input?.greeting || '').trim();
  const questions = Array.isArray(input?.questions)
    ? input.questions.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  if (!greeting || greeting.length > 1500) throw new Error('Greeting must contain 1–1500 characters');
  if (!questions.length || questions.length > 10) throw new Error('Add from 1 to 10 questions');
  if (questions.some(question => question.length > 1000)) throw new Error('Each question must be no longer than 1000 characters');
  const vacancyResult = await pool.query('SELECT id FROM vacancies WHERE id=$1', [vacancyId]);
  if (!vacancyResult.rowCount) throw new Error('Vacancy not found');
  await pool.query(
    `INSERT INTO dialogue_configs(vacancy_id, enabled, greeting, questions, updated_at)
      VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT(vacancy_id) DO UPDATE
      SET enabled=$2,greeting=$3,questions=$4,updated_at=NOW()`,
    [vacancyId, Boolean(input?.enabled), greeting, JSON.stringify(questions)],
  );
  return getDialogueConfig(vacancyId);
}

export async function getDialogueWork() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const configs = await pool.query(
    `SELECT dc.vacancy_id, dc.greeting, dc.questions, v.hh_id, v.name
      FROM dialogue_configs dc JOIN vacancies v ON v.id=dc.vacancy_id
      WHERE dc.enabled=TRUE`,
  );
  const work = [];
  for (const config of configs.rows) {
    await pool.query(
      `WITH available AS (
        SELECT GREATEST(0, 5-COUNT(*))::int AS slots
        FROM candidate_dialogues cd
        JOIN candidates existing ON existing.id=cd.candidate_id
        WHERE existing.hh_vacancy_id=$1 AND cd.status IN ('pending','active')
      )
      INSERT INTO candidate_dialogues(candidate_id)
        SELECT c.id FROM candidates c, available
        WHERE c.hh_vacancy_id=$1 AND c.stage='Новый'
          AND COALESCE(c.payload->>'chat_id','') <> ''
          AND NOT EXISTS (SELECT 1 FROM candidate_dialogues cd WHERE cd.candidate_id=c.id)
        ORDER BY c.updated_at DESC LIMIT (SELECT slots FROM available)
        ON CONFLICT(candidate_id) DO NOTHING`,
      [config.hh_id],
    );
    const dialogues = await pool.query(
      `SELECT cd.*, c.name, c.hh_negotiation_id, c.payload->>'chat_id' AS chat_id
        FROM candidate_dialogues cd JOIN candidates c ON c.id=cd.candidate_id
        WHERE c.hh_vacancy_id=$1 AND cd.status IN ('pending','active')
        ORDER BY cd.updated_at LIMIT 20`,
      [config.hh_id],
    );
    for (const dialogue of dialogues.rows) work.push({ config, dialogue });
  }
  return work;
}

export async function updateDialogue(candidateId, patch) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const allowed = ['pending', 'active', 'completed', 'paused', 'error'];
  if (!allowed.includes(patch.status)) throw new Error('Invalid dialogue status');
  await pool.query(
    `UPDATE candidate_dialogues SET status=$1,question_index=$2,
      last_applicant_message_id=$3,transcript=$4,last_sent_at=$5,updated_at=NOW()
      WHERE candidate_id=$6`,
    [
      patch.status,
      patch.questionIndex,
      patch.lastApplicantMessageId || null,
      JSON.stringify(patch.transcript || []),
      patch.lastSentAt || null,
      candidateId,
    ],
  );
  if (patch.status === 'active') {
    await pool.query("UPDATE candidates SET stage='Диалог',updated_at=NOW() WHERE id=$1", [candidateId]);
  }
  if (patch.status === 'completed') {
    await pool.query("UPDATE candidates SET stage='Скрининг',score=NULL,scored_at=NULL,updated_at=NOW() WHERE id=$1", [candidateId]);
  }
}

export async function dialogueStats(vacancyId) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const result = await pool.query(
    `SELECT cd.status, COUNT(*)::int AS count
      FROM candidate_dialogues cd
      JOIN candidates c ON c.id=cd.candidate_id
      JOIN vacancies v ON v.hh_id=c.hh_vacancy_id
      WHERE v.id=$1 GROUP BY cd.status`,
    [vacancyId],
  );
  return Object.fromEntries(result.rows.map(row => [row.status, row.count]));
}
