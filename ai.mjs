import { getCandidatesForScoring, saveCandidateScore } from './database.mjs';

const apiUrl = 'https://api.openai.com/v1/responses';
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna';

function professionalResume(resume = {}) {
  return {
    title: resume.title,
    total_experience: resume.total_experience,
    experience: resume.experience,
    skill_set: resume.skill_set,
    skills: resume.skills,
    education: resume.education,
    language: resume.language,
    professional_roles: resume.professional_roles,
    employments: resume.employments,
    schedules: resume.schedules,
    travel_time: resume.travel_time,
    business_trip_readiness: resume.business_trip_readiness,
    about_me: resume.skills_description || resume.about_me,
  };
}

function outputText(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  throw new Error('OpenAI returned no structured result');
}

async function scoreCandidate(vacancy, criteria, candidate) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  const criterionNames = criteria.map(item => item.name);
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'developer',
          content: `You assist a human recruiter with a preliminary, non-binding assessment.
Use only job-relevant professional evidence. Ignore and never infer age, sex, gender,
photo, ethnicity, nationality, health, disability, religion, family status, and other
sensitive personal characteristics. Score every criterion on a calibrated 0–100 scale:
0 means clear evidence of complete mismatch, 25 means mostly mismatch, 50 means mixed
or insufficient professional evidence, 75 means a good match, and 100 means exceptionally
strong direct evidence. Missing information is not a mismatch and should normally receive
50 with an explanation that evidence is insufficient. Return concise Russian explanations.
The human recruiter makes all employment decisions.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            vacancy: {
              name: vacancy.name,
              description: vacancy.payload?.description,
              keySkills: vacancy.payload?.key_skills,
            },
            criteria,
            candidate: professionalResume(candidate.payload?.resume),
            dialogue: candidate.dialogue_transcript || [],
          }),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'candidate_score',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              factors: {
                type: 'array',
                minItems: criteria.length,
                maxItems: criteria.length,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', enum: criterionNames },
                    score: { type: 'integer', minimum: 0, maximum: 100 },
                    note: { type: 'string', maxLength: 240 },
                  },
                  required: ['label', 'score', 'note'],
                },
              },
            },
            required: ['factors'],
          },
        },
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `OpenAI error ${response.status}`);
  const result = JSON.parse(outputText(body));
  const byName = new Map(result.factors.map(item => [item.label, item]));
  const factors = criteria.map(criterion => ({
    label: criterion.name,
    score: Math.round(Number(byName.get(criterion.name)?.score || 0)),
    note: String(byName.get(criterion.name)?.note || 'Недостаточно данных'),
  }));
  const score = Math.round(factors.reduce((sum, factor, index) =>
    sum + factor.score * criteria[index].weight / 100, 0));
  await saveCandidateScore(candidate.id, score, factors);
  return { id: Number(candidate.id), score };
}

export async function scoreVacancyCandidates(vacancyId) {
  const batch = await getCandidatesForScoring(vacancyId, 10);
  const results = [];
  const errors = [];
  for (const candidate of batch.candidates) {
    try {
      results.push(await scoreCandidate(batch.vacancy, batch.criteria, candidate));
    } catch (error) {
      console.error(`Unable to score candidate ${candidate.id}`, error);
      errors.push({ id: Number(candidate.id), error: error.message });
    }
  }
  return {
    model,
    scored: results.length,
    remainingBatchErrors: errors.length,
    results,
    errors,
  };
}
