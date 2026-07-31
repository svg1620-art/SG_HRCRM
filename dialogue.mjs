import { dialogueStats, getDialogueWork, updateDialogue } from './database.mjs';
import { getChatMessages, sendChatMessage } from './hh.mjs';

let running = false;

function applicantMessages(chat) {
  return (chat.messages || [])
    .filter(message =>
      message.type === 'SIMPLE'
      && message.payload?.text
      && !message.sender_display_info?.is_current_participant
      && message.sender_display_info?.role === 'APPLICANT')
    .sort((a, b) => new Date(a.creation_time) - new Date(b.creation_time));
}

export async function syncAutomatedDialogues() {
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;
  const summary = { started: 0, advanced: 0, completed: 0, errors: 0 };
  try {
    const work = await getDialogueWork();
    for (const { config, dialogue } of work) {
      const questions = config.questions || [];
      if (!questions.length || !dialogue.chat_id) continue;
      try {
        const chat = await getChatMessages(dialogue.chat_id);
        if (chat.chat_states?.write_message_state?.allowed === false) {
          await updateDialogue(dialogue.candidate_id, {
            status: 'paused',
            questionIndex: dialogue.question_index,
            lastApplicantMessageId: dialogue.last_applicant_message_id,
            transcript: dialogue.transcript,
            lastSentAt: dialogue.last_sent_at,
          });
          continue;
        }
        const replies = applicantMessages(chat);
        const latestReply = replies.at(-1);
        if (dialogue.status === 'pending') {
          await sendChatMessage(dialogue.chat_id, `${config.greeting}\n\n${questions[0]}`);
          await updateDialogue(dialogue.candidate_id, {
            status: 'active',
            questionIndex: 0,
            lastApplicantMessageId: latestReply?.id,
            transcript: [],
            lastSentAt: new Date(),
          });
          summary.started += 1;
          continue;
        }
        if (!latestReply || latestReply.id === dialogue.last_applicant_message_id) continue;
        const transcript = [...(dialogue.transcript || []), {
          question: questions[dialogue.question_index],
          answer: latestReply.payload.text,
          answeredAt: latestReply.creation_time,
        }];
        const nextIndex = dialogue.question_index + 1;
        if (nextIndex >= questions.length) {
          await sendChatMessage(dialogue.chat_id, 'Спасибо за ответы! Мы передали информацию рекрутеру и вернёмся к вам после рассмотрения.');
          await updateDialogue(dialogue.candidate_id, {
            status: 'completed',
            questionIndex: nextIndex,
            lastApplicantMessageId: latestReply.id,
            transcript,
            lastSentAt: new Date(),
          });
          summary.completed += 1;
        } else {
          await sendChatMessage(dialogue.chat_id, questions[nextIndex]);
          await updateDialogue(dialogue.candidate_id, {
            status: 'active',
            questionIndex: nextIndex,
            lastApplicantMessageId: latestReply.id,
            transcript,
            lastSentAt: new Date(),
          });
          summary.advanced += 1;
        }
      } catch (error) {
        console.error(`Automated dialogue failed for candidate ${dialogue.candidate_id}`, error);
        summary.errors += 1;
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

export { dialogueStats };
