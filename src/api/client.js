'use strict';
const axios=require('axios'),cfg=require('../config');
const {apiLock}=require('../utils/lock');
const maintenance=require('../utils/maintenance');
const reqSign=require('../utils/reqSign');
const wsSession=require('../utils/wsSession');
const buildingReg=require('../utils/buildingReg');
// Ошибка «нет здания» без похода в сеть (аккаунт не имеет здания для этой фичи).
function noBuildingError(method,p,key){
  const err=new Error(`${method}: ${p}: пропущено — у аккаунта нет здания (${key})`);
  err.noBuilding=true;err.status=403;err.skipped=true;
  return err;
}
// WS не успел авторизоваться (напр. аккаунт в escalating-backoff после серии сбоев) — раньше в этом
// случае запрос всё равно уходил и сервер отвечал "Invalid request signature" (сбивало с толку,
// т.к. подпись валидна, просто нет живого WS). Явная ошибка вместо тихого пропуска через catch(_){}.
function wsNotReadyError(method,p){
  const err=new Error(`${method}: ${p}: пропущено — WS не авторизован (см. [ws:...] в логе)`);
  err.wsNotReady=true;err.skipped=true;
  return err;
}
// Ещё нет seed для подписи (сессия для этого клиента ни разу не поднималась — напр. веб-эндпоинт
// дёрнул api сразу через makeApiForAccount, без предварительного ensureSession). Раньше в этом
// случае запрос всё равно уходил БЕЗ подписи вообще, и сервер отвечал 403 "Request signature
// required" — теперь сначала пробуем получить seed через refreshFn, и только если не вышло — явная
// ошибка вместо гарантированно обречённого запроса.
function noSeedError(method,p){
  const err=new Error(`${method}: ${p}: пропущено — нет seed для подписи (сессия не поднята, refresh не помог)`);
  err.noSeed=true;err.skipped=true;
  return err;
}
const mkH=t=>({'accept':'*/*','accept-encoding':'gzip, deflate','accept-language':'en-US,en;q=0.9','authorization':`Bearer ${t}`,'cookie':'i18n_redirected=ru','origin':'https://game.toncity.io','priority':'u=1, i','referer':'https://game.toncity.io/','sec-ch-ua':'"Not-A.Brand";v="24", "Chromium";v="146"','sec-ch-ua-mobile':'?0','sec-ch-ua-platform':'"Windows"','sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-origin','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'});
function applyAuthHeader(headers,token){
  const value=`Bearer ${token}`;
  if(headers&&typeof headers.set==='function'){headers.set('authorization',value);return;}
  if(headers&&typeof headers==='object'){headers.authorization=value;headers.Authorization=value;}
}
function formatAxiosError(method,path,e){
  const status=e?.response?.status;
  const statusText=e?.response?.statusText;
  const data=e?.response?.data;
  const body=typeof data==='string'?data:(data?JSON.stringify(data):'');
  const parts=[method,path,status?`status ${status}`:'',statusText||'',body].filter(Boolean);
  // нет status/statusText/body вообще — ответа от сервера НЕ БЫЛО (таймаут/обрыв соединения), а не
  // просто пустое тело ошибки. Без этого уточнения сообщение выглядит как голое "POST: /path",
  // будто бот сам не приложил текст ошибки, хотя на самом деле сервер вообще не ответил
  if(!status&&!statusText&&!body)parts.push(`нет ответа от сервера (${e?.code||'сеть/таймаут'})`);
  const err=new Error(parts.join(': ')||e.message);
  err.cause=e;
  err.status=status;
  // Сервер отвечает 403 «У вас нет здания, необходимого для этого действия», если у аккаунта
  // нет здания для этой фичи (Павильон удачи, Центральный рынок и т.п.). Это НЕ ошибка бота —
  // модули должны такой случай тихо пропускать. Помечаем флагом noBuilding.
  const errText=(data&&typeof data==='object'&&(data.error||data.message))||(typeof data==='string'?data:'');
  if(status===403&&/нет здания/i.test(String(errText)))err.noBuilding=true;
  // Тот же 403, которым сервер отвечает и на "нет живого авторизованного WS" (см. wsSession.js) —
  // если это пришло уже ПОСЛЕ того, как наш ensureReady() подтвердил готовность WS, значит сервер
  // сам аннулировал сессию без закрытия нашего сокета (напр. параллельный вход того же аккаунта
  // через настоящий клиент игры). Помечаем, чтобы _request() форсировал реальный реконнект,
  // а не продолжал слать запросы в WS, который сервер больше не считает авторизованным.
  if(status===403&&/invalid request signature/i.test(String(errText)))err.badSignature=true;
  // Сервер отвечает 403 {"message":"Direct API access is not allowed"} на /market/direct, когда с
  // одного аккаунта дёргают рынок напрямую слишком часто — это ПЕР-АККАУНТНЫЙ лимит на стороне
  // сервера. Общий apiLock (2 rps на ВСЕ аккаунты) его не покрывает: один аккаунт может быть выбран
  // несколько запросов подряд. Помечаем флагом, чтобы вызывающий модуль поставил именно этот
  // аккаунт на кулдаун и взял другого, а не бил в него снова.
  if(status===403&&/direct api access is not allowed/i.test(String(errText)))err.directDenied=true;
  return err;
}
// «Игра не ответила» — соединение оборвалось/вышел таймаут, HTTP-ответа НЕТ вообще. Это НЕ то же
// самое, что ответ 4xx/5xx: там игра запрос обработала и высказалась, повторять нечего.
// Сюда же таймаут общей очереди (apiLock): запрос столько ждал слот, что мы отменили ожидание —
// ответа игры мы опять-таки не видели. Для чтения это повод повторить, для действий — нет.
const isNoAnswer = e => /apiLock: задача не завершилась/i.test(String(e?.message || '')) || (!e?.response && (
  ['ECONNABORTED','ETIMEDOUT','ECONNRESET','EAI_AGAIN','ENOTFOUND','EPIPE'].includes(e?.code) ||
  /timeout|socket hang up|network error/i.test(String(e?.message||''))));

// Сколько раз перечитывать. Только для ЧТЕНИЯ (GET): читать безопасно сколько угодно, ответа мы
// всё равно ещё не получили. Для изменяющих запросов (POST/PATCH: улучшение, взнос в казну,
// реконструкция, ход в игре) повтор ЗАПРЕЩЁН: молчание сервера не значит, что он не обработал —
// по опыту обрабатывает, и повтор сделал бы действие дважды.
// Повторов немного и намеренно: сверху ретраит ещё и проход по аккаунтам (web/lib/accountSweep.js),
// и десять попыток на каждом уровне умножались друг на друга — 57 аккаунтов молотили игру сотнями
// запросов, из-за чего она молчала ЕЩЁ больше, а страница получала данные не по всем аккаунтам
// (жалоба 21.08.2026 про магазин). Три попытки закрывают одиночный сбой, а массовый решается
// снижением темпа — см. датчик давления ниже.
const READ_RETRIES = 3;
// Плюс общий потолок по времени: сам запрос ждёт ответа до 30 с, и без ограничения десять попыток
// держали бы один вызов больше пяти минут — а его ждёт цикл прокачки или страница панели.
const READ_BUDGET_MS = 30000;
// Сколько раз пробуем поднять сессию (WS/seed) перед тем, как сдаться. Это НЕ повтор запроса к
// игре: такие ошибки помечены skipped, запрос не отправлялся — повтор безопасен и для действий.
const SESSION_RETRIES = 3;
// Давление = сколько ответов подряд игра не дала (по всему процессу, не по одному аккаунту).
// Растёт на каждом молчании, обнуляется первым же успешным ответом. Пауза перед повтором
// умножается на него: при массовом сбое стадо из полусотни аккаунтов расходится по времени
// вместо того, чтобы синхронно долбить игру.
let noAnswerPressure = 0;
const bumpPressure = () => { noAnswerPressure = Math.min(noAnswerPressure + 1, 20); };
const easePressure = () => { noAnswerPressure = 0; };
const readBackoffMs = attempt => {
  const base = Math.min(1000 * attempt, 5000);
  const crowd = 1 + Math.min(noAnswerPressure, 10) / 2;      // до ×6 при массовом молчании
  return Math.round(base * crowd * (0.5 + Math.random()));   // + разброс, чтобы не ходить строем
};
class ApiClient{
  constructor(t){
    this.token=t;
    this._accountId=null;
    this._refreshFn=null;
    this._ax=axios.create({baseURL:cfg.baseUrl,timeout:30000,headers:mkH(t)});
    this._ax.interceptors.request.use(config=>{applyAuthHeader(config.headers,this.token);return config;});
  }
  setToken(t){this.token=t;}
  setAccountId(id){this._accountId=id;}
  setRefreshFn(fn){this._refreshFn=fn;}
  // Пропустить общий apiLock (нужно для латентность-чувствительных путей — авто-закрытие
  // TP/SL и исполнение условных ордеров Башни Сатоши по курсу, где важна скорость, а не
  // экономия рейт-лимита). Раньше это делалось подменой this._run — метод, который apiForAcc()
  // подменял инстанс-полем, но при рефакторинге _request() (инлайн apiLock.run вместо this._run())
  // this._run перестал существовать и вызываться, поэтому подмена молча переставала работать:
  // «no lock» вызовы всё равно уходили в ту же общую очередь 2rps/concurrency:1.
  setNoLock(v){this._noLock=!!v;}
  // заголовки подписи запроса (X-Req-Token/Ts/Nonce). Пусто, если нет seed/WASM —
  // тогда запрос идёт как раньше. Свежие ts/nonce на каждый вызов (в т.ч. retry).
  _sign(method,p){return reqSign.headersFor(this._accountId,method,p)||{};}
  // единый путь всех запросов: сначала предохранитель техработ (мгновенный отказ, если игра на паузе),
  // затем обычная логика с авто-рефрешем токена на 401. Ответы (успех/ошибка) скармливаем детектору техработ.
  //
  // ВАЖНО: seed/WS-готовность проверяются ВНУТРИ apiLock.run (т.е. прямо перед фактической отправкой),
  // а не до постановки в очередь. apiLock — ОДИН общий лимитер (2 rps, concurrency 1) на ВСЕ аккаунты
  // и ВСЕ модули разом (маркет-цены, квесты, стейкинг, вордли...), очередь может копиться на десятки
  // секунд. Раньше ensureReady() проверялся ДО apiLock.run — за время ожидания в очереди WS у флапающего
  // аккаунта успевал закрыться/переподключиться, и уже "протухшую" на момент проверки готовность запрос
  // всё равно уходил в сеть с устаревшим signature-контекстом → сервер отвечал тем же 403 "Invalid request
  // signature", которым он же обозначает и "нет живого авторизованного WS" (см. комментарии выше). Проверка
  // должна происходить прямо перед отправкой, без разрыва между check и act.
  async _request(method,p,fn){
    // building-gate: если путь требует здание, а у аккаунта его нет — не ходим в сеть вообще
    // («любые действия внутри здания только при его наличии»).
    const missing=buildingReg.shouldBlock(this._accountId,p);
    if(missing)throw noBuildingError(method,p,missing);
    // Повтор ТОЛЬКО для чтения и ТОЛЬКО когда игра вообще не ответила (см. isNoAnswer). Пауза между
    // попытками — снаружи apiLock, иначе ожидание держало бы общий лимитер и тормозило весь бот.
    const readable = method === 'GET';
    const started = Date.now();
    const deadline = started + READ_BUDGET_MS;
    const readAttempts = readable ? READ_RETRIES : 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= Math.max(readAttempts, SESSION_RETRIES); attempt++) {
      try {
        return await this._send(method, p, fn);
      } catch (e) {
        lastErr = e;
        // Запрос НЕ УХОДИЛ в игру (нет seed / WS не поднялся — такие ошибки помечены skipped).
        // Это можно повторять даже для ИЗМЕНЯЮЩИХ запросов: игра ничего не получила и ничего не
        // выполнила. Между попытками подталкиваем сессию к реальному переподключению, иначе
        // ждать бесполезно — сокет сам себя не поднимет.
        if (e && e.skipped && attempt < SESSION_RETRIES && Date.now() < deadline) {
          if (this._accountId != null) { try { wsSession.forceReconnect(this._accountId); } catch (_) {} }
          const wait = 2000 * attempt;
          require('../utils/logger').warn(`[api] ${method} ${p}: сессия не готова (попытка ${attempt}) — поднимаю WS, повтор через ${wait / 1000}с`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        const noAnswer = isNoAnswer(e?.cause || e);
        if (noAnswer) bumpPressure();      // датчик общего давления: игра молчит
        if (!readable || !noAnswer || attempt >= readAttempts || Date.now() >= deadline) {
          // дописываем в текст, сколько раз пробовали — иначе строка в логе модуля выглядит так,
          // будто повтора не было вовсе (вопрос 21.08: «а вторая строка тоже делает новый запрос?»)
          if (attempt > 1 && e && typeof e.message === 'string' && !/попыт/i.test(e.message)) {
            e.message += ` — сдался после ${attempt} попыток за ${Math.round((Date.now() - started) / 1000)}с`;
          }
          throw e;
        }
        const wait = readBackoffMs(attempt);
        if (attempt === 1 || attempt % 4 === 0) {
          require('../utils/logger').warn(`[api] [acc ${this._accountId ?? '—'}] ${method} ${p}: игра не ответила (попытка ${attempt}, давление ${noAnswerPressure}) — повтор через ${Math.round(wait/1000)}с`);
        }
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  async _send(method,p,fn){
    const runner=this._noLock?(task)=>task():(task)=>apiLock.run(task);
    return runner(async()=>{
      const gate=maintenance.acquire(); // бросит MaintenanceError, если игра на технических работах
      // сервер пускает REST только при активном авторизованном WS этого аккаунта.
      // WS-хендшейк подписывается seed'ом, поэтому открываем только когда seed уже есть.
      if(this._accountId!=null){
        if(!reqSign.hasSeed(this._accountId)){
          // сессия для этого клиента ещё ни разу не поднималась — пробуем получить seed через
          // refreshFn (doRefresh кладёт его при успехе), прежде чем слать запрос вслепую
          if(this._refreshFn){try{await this._refreshFn();}catch(_){}}
          if(!reqSign.hasSeed(this._accountId))throw noSeedError(method,p); // не репортим maintenance — запроса не было
        }
        let wsOk=true;
        try{wsOk=await wsSession.ensureReady(this._accountId,()=>this.token,this._refreshFn?async()=>{await this._refreshFn();}:null);}catch(_){wsOk=false;}
        if(!wsOk)throw wsNotReadyError(method,p); // не репортим maintenance — запроса к серверу не было
      }
      try{
        const data=(await fn()).data;
        maintenance.report(200,null,gate);
        easePressure();          // игра ответила — давление снимаем
        return data;
      }catch(e){
        maintenance.report(e?.response?.status,e?.response?.data,gate);
        if(e?.response?.status===401&&this._refreshFn){
          const ok=await this._refreshFn();
          if(ok){
            try{const data=(await fn()).data;maintenance.report(200,null,gate);return data;}
            catch(e2){
              maintenance.report(e2?.response?.status,e2?.response?.data,gate);
              const err2=formatAxiosError(method,p,e2);
              // и "Invalid request signature", и "Direct API access is not allowed" = сервер не видит
              // живой авторизованный WS этого аккаунта → форсируем реальный реконнект WS
              if((err2.badSignature||err2.directDenied)&&this._accountId!=null)wsSession.forceReconnect(this._accountId);
              throw err2;
            }
          }
        }
        const err=formatAxiosError(method,p,e);
        if((err.badSignature||err.directDenied)&&this._accountId!=null)wsSession.forceReconnect(this._accountId);
        throw err;
      }
    });
  }
  // opts.timeout — разовое укорочение таймаута для конкретной ручки. Нужно там, где игра
  // регулярно висит до общего axios timeout:30000, а ждать столько дорого: запрос всё это время
  // держит общий apiLock (2 rps на все аккаунты), т.е. одна залипшая ручка тормозит весь бот.
  async get(p,params={},opts={}){return this._request('GET',p,()=>this._ax.get(p,{params,headers:this._sign('GET',p),...(opts.timeout?{timeout:opts.timeout}:{})}));}
  async post(p,d={}){return this._request('POST',p,()=>this._ax.post(p,d,{headers:{'content-type':'application/json',...this._sign('POST',p)}}));}
  async patch(p,d={}){return this._request('PATCH',p,()=>this._ax.patch(p,d,{headers:{'content-type':'application/json',...this._sign('PATCH',p)}}));}
}
module.exports=ApiClient;
