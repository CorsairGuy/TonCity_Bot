'use strict';
const logger=require('../utils/logger');
const {sleep}=require('../utils/helpers');
const {QuizAnswer,MinigameLog}=require('../db/index');

// Тайминги фаз (server-side):
const READING_MS=10000;   // фаза чтения — ответ раньше даёт 400
const POST_MS=3000;       // показ результата «верно/неверно»
const answerDelay=()=>1000+Math.floor(Math.random()*2000); // 1-3с в окне ответа (раньше = больше очков)

async function logGame(account,reward,score){
  try{
    const played_at=new Date().toISOString().slice(0,10);
    await MinigameLog.upsert({account,game:'quiz',played_at,won:true,reward,score},{conflictFields:['account','game','played_at']});
  }catch(e){logger.warn(`[${account}] [quiz] logGame (запись в minigame_log не удалась — статус "сыграно" не сохранится): ${e.message}`);}
}

async function recordAnswer(q,answer_id,correct,pruneWrong){
  try{
    await QuizAnswer.upsert(
      {question_id:q.id,answer_id,status:correct?'correct':'wrong',question_text:(q.text||'').slice(0,255)},
      {conflictFields:['question_id','answer_id']}
    );
    // нашли верный → неверные по этому вопросу больше не нужны (для одиночного запуска чистим сразу)
    if(correct&&pruneWrong){
      await QuizAnswer.destroy({where:{question_id:q.id,status:'wrong'}});
    }
  }catch(_){}
}

// Удаляет все неверные ответы по вопросам, у которых уже известен верный.
// Вызывается в конце массового прогона (чтобы не мешать параллельным аккаунтам).
async function cleanupWrongAnswers(){
  try{
    const correct=await QuizAnswer.findAll({where:{status:'correct'},attributes:['question_id']});
    const ids=[...new Set(correct.map(r=>r.question_id))];
    if(ids.length)await QuizAnswer.destroy({where:{status:'wrong',question_id:ids}});
  }catch(_){}
}

// Выбор ответа: известный правильный → берём; иначе любой не-исключённый вариант.
async function pickAnswer(q){
  let rows=[];
  try{rows=await QuizAnswer.findAll({where:{question_id:q.id}});}catch(_){}
  const correct=rows.find(r=>r.status==='correct');
  if(correct)return correct.answer_id;
  const wrong=new Set(rows.filter(r=>r.status==='wrong').map(r=>r.answer_id));
  const opts=q.answers||[];
  const fresh=opts.find(a=>!wrong.has(a.id));
  return (fresh||opts[0])?.id??null;
}

const isTransient=m=>/Невозможно ответить|Too Many|429|\b400\b/i.test(m||'');
const isTerminal=m=>/закончили|complete|\b409\b/i.test(m||'');

async function answerOne(api,q,pruneWrong){
  const answer_id=await pickAnswer(q);
  if(answer_id==null)return null;
  for(let tries=0;tries<12;tries++){
    try{
      const r=await api.post('/quiz/answer',{question_id:q.id,answer_id});
      await recordAnswer(q,answer_id,!!r?.is_correct,pruneWrong);
      return r;
    }catch(e){
      const msg=e?.message||String(e);
      if(isTerminal(msg))throw e;
      if(isTransient(msg)){await sleep(2000);continue;}
      throw e;
    }
  }
  return null;
}

// Решает ежедневную «Викторину». Раз в день на аккаунт.
// onProgress(current,total) — для live-отображения текущего вопроса.
// pruneWrong — чистить неверные ответы сразу при нахождении верного (одиночный запуск).
// reward = монеты (поле reward в завершённом состоянии), score = баллы (total_score).
async function solveQuiz(api,name,onProgress,pruneWrong=true){
  let st=await api.get('/quiz/state').catch(()=>null);
  if(st&&st.game_complete){
    const reward=st.reward??null,score=st.total_score??0;
    await logGame(name,reward,score);
    return{won:true,skipped:true,reward,score};
  }
  if(!st||!st.game_started){st=await api.post('/quiz/start',{});}
  let questions=st?.questions||[];
  if(!questions.length){st=await api.get('/quiz/state');questions=st?.questions||[];}
  const total=questions.length;
  const answered=new Set((st?.responses||[]).map(r=>r.question_id));
  let idx=0;
  for(const q of questions){
    idx++;
    if(answered.has(q.id))continue;
    if(onProgress)onProgress(idx,total);
    await sleep(READING_MS);
    await sleep(answerDelay());
    try{await answerOne(api,q,pruneWrong);}
    catch(e){
      if(isTerminal(e?.message||''))break;
      logger.warn(`[${name}] [quiz] вопрос ${q.id}: ${e.message}`);
    }
    await sleep(POST_MS);
  }
  const fin=await api.get('/quiz/state').catch(()=>st);
  const reward=fin?.reward??0;      // монеты
  const score=fin?.total_score??0;  // баллы викторины
  await logGame(name,reward,score);
  logger.info(`[${name}] [quiz] завершено, +${reward} монет (счёт ${score})`);
  return{won:true,reward,score};
}
module.exports={solveQuiz,cleanupWrongAnswers};
