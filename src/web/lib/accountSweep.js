'use strict';
// Проход «живым запросом по всем аккаунтам» с ретраями — общий для страниц, которые показывают
// данные прямо из игры (раздел «Годовщина», магазин билетов).
//
// Зачем ретраи: пустая строка у аккаунта обычно означает не «этому аккаунту нельзя», а разовый
// сбой — таймаут, 429, 5xx, ещё не поднявшаяся WS-сессия (её поднимает сам ApiClient при следующей
// попытке). Такие ошибки дожимаем повторами с нарастающей паузой.
//
// Почему НЕ бесконечно: opRegistry снимает ключ операции только в finally, поэтому вечный ретрай
// одного мёртвого аккаунта навсегда подвесил бы кнопку «Обновить» для всех — ровно эти грабли уже
// ловили 03.08 (см. таймауты в routes/refresh.js). Отсюда бюджет: не больше RETRY_DELAYS+1 попыток
// и не дольше ACCOUNT_BUDGET_MS на аккаунт. Исчерпали — строка приезжает с error, а кнопка
// «Обновить» на странице запустит следующий заход.
const logger=require('../../utils/logger');
const{sleep}=require('../../utils/helpers');

const RETRY_DELAYS=[1000,2000,4000,8000,15000,15000,20000,20000];
const ACCOUNT_BUDGET_MS=180_000;
// Одновременно в игру идёт не больше CONCURRENCY запросов. Раньше проход стартовал ВСЕ аккаунты
// разом (Promise.all по 60 штук) — и в логе 12.08 видно результат: у всех аккаунтов подряд, в одну
// и ту же секунду, `GET /anniversary-event/: нет ответа от сервера (ECONNABORTED)`, т.е. запросы
// просто стояли в очереди и вышибались по axios timeout:30000. Это и была «данные пришли не по
// всем аккаунтам»: не игра отказывала, а мы сами её заваливали. Ретраи такую очередь только
// удлиняют, поэтому лечится именно ограничением параллелизма.
const CONCURRENCY=6;

// Ошибки, которые повторять бессмысленно: игра отказывает не «сейчас», а «этому аккаунту вообще».
// Живые примеры из лога 12.08:
//   403 «У вас нет здания, необходимого для этого действия»
//   403 «Экономика политик откроется при населении 1 000 000 — продолжайте развивать город»
// Оба ответа не изменятся ни на десятой попытке, ни через минуту — повторять их значит зря
// долбить игру и держать проход. Единственный 403, который ретраить ОСМЫСЛЕННО, — про подпись/WS
// (сессия могла ещё не подняться, следующая попытка её поднимает).
function isPermanent(e){
  if(!e)return false;
  if(e.noBuilding)return true;
  // Нет seed для подписи / WS не авторизован — сессия аккаунта не поднимается, и refresh уже не
  // помог (ApiClient пробует его сам ПЕРЕД тем, как отдать эту ошибку). Повторы тут бесполезны:
  // в логе 12.08 такие аккаунты честно отработали все шесть попыток с тем же результатом и просто
  // засоряли лог. Лечится входом в аккаунт заново, а не ретраем.
  if(e.noSeed||e.wsNotReady)return true;
  const msg=String(e.message||'');
  if(/нет seed для подписи|WS не авторизован|signature required/i.test(msg))return true;
  return e.status===403;
}

// Человеческий текст вместо внутренней формулировки: страница показывает его в плашке, и «нет seed
// для подписи» там ничего не объясняет тому, кто просто смотрит на список аккаунтов.
function explain(e){
  const msg=String(e?.message||'нет ответа от игры');
  if(e?.noSeed||e?.wsNotReady||/нет seed для подписи|WS не авторизован/i.test(msg))
    return 'аккаунт не авторизован в игре — нужен повторный вход';
  return msg;
}

// fallback — форма строки для аккаунта, у которого запрос так и не удался (объект или функция).
// Без неё в строке остаются только {id,name,error}, и страница, обращаясь к вложенным полям,
// падает целиком из-за одного мёртвого аккаунта.
// onlyIds — пройти НЕ по всем аккаунтам, а только по перечисленным. Нужно кнопке/автоповтору
// «добрать сбойные»: после общего прохода страница просит ещё раз ровно тех, кто не ответил,
// вместо повторного опроса всех шестидесяти.
// mutating:true — проход ИЗМЕНЯЕТ данные в игре (заклеймы, покупки, взносы). Тогда молчание игры

// (ECONNABORTED) НЕ повод повторять: такой запрос она, судя по всему, обрабатывает, и повтор

// сделал бы действие дважды. Для чтения повторы, наоборот, нужны — их делает и сам api/client.js.

async function sweepAccounts(makeApiForAccount,fn,{fallback={},label='sweep',onlyIds=null,mutating=false}={}){
  const{Account}=require('../../db/index');
  const{Op}=require('sequelize');
  const where={access_token:{[Op.not]:null}};
  if(Array.isArray(onlyIds)&&onlyIds.length)where.id=onlyIds.map(Number).filter(Number.isFinite);
  const accs=await Account.findAll({where,order:[['name','ASC']],attributes:['id','name']});
  const oneAccount=async acc=>{
    const startedAt=Date.now();
    let lastErr=null;
    for(let attempt=0;attempt<=RETRY_DELAYS.length;attempt++){
      try{
        const api=await makeApiForAccount(acc.id,{noLock:true});
        const data=await fn(api,acc);
        if(attempt>0)logger.info(`[${acc.name}] [${label}] ответ получен с ${attempt+1}-й попытки`);
        return{id:acc.id,name:acc.name,...data,attempts:attempt+1};
      }catch(e){
        lastErr=e;
        if(isPermanent(e))break;
        // изменяющий проход + игра промолчала → не повторяем: действие могло пройти
        if(mutating&&require('../../utils/helpers').isNoAnswerError(e)){
          logger.warn(`[${acc.name}] [${label}] игра не ответила — повтор НЕ делаю (действие могло быть выполнено)`);
          break;
        }
        const delay=RETRY_DELAYS[attempt];
        if(delay==null||Date.now()-startedAt+delay>ACCOUNT_BUDGET_MS)break;
        logger.warn(`[${acc.name}] [${label}] попытка ${attempt+1} не удалась (${e.message}) — повтор через ${Math.round(delay/1000)}с`);
        await sleep(delay);
      }
    }
    return{
      id:acc.id,name:acc.name,
      ...(typeof fallback==='function'?fallback():fallback),
      error:explain(lastErr),
      permanent:isPermanent(lastErr)||undefined,
    };
  };

  // пул на CONCURRENCY «рабочих»: каждый берёт следующий свободный аккаунт из общей очереди.
  // Результаты кладём по индексу, чтобы порядок строк не зависел от того, кто ответил быстрее.
  const out=new Array(accs.length);
  let next=0;
  const worker=async()=>{
    while(true){
      const i=next++;
      if(i>=accs.length)return;
      out[i]=await oneAccount(accs[i]);
    }
  };
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,accs.length)},worker));
  return out;
}

module.exports={sweepAccounts,isPermanent,explain};
