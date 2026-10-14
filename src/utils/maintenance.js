'use strict';
// Автопауза ВСЕХ запросов к игре на время технических работ.
// Сигнал техработ — тот же, что проверяет сам клиент игры: HTTP 503 + тело содержит "maintenance"
// (в бандле: errors.every(e=>e.includes("503")&&e.includes("maintenance")) → текст "Проводятся работы на серверах игры").
//
// Модель — «липкий» флаг + circuit-breaker с общим состоянием на процесс (бот и веб-сервер в одном процессе,
// все запросы идут через ApiClient, поэтому одно состояние покрывает и автозадачи, и панель):
//   • active=false — норма, запросы проходят;
//   • active=true  — техработы: acquire() мгновенно бросает MaintenanceError, к серверу игры не ходим.
//     Флаг СНИМАЕТСЯ только успешной пробой (не по таймеру) — состояние не «мерцает» между пробами.
//   • Проба (half-open): не чаще раза в PROBE_INTERVAL пропускаем ОДИН реальный запрос; ответ сервера
//     (не 503-maintenance) снимает паузу, повторный 503+maintenance — оставляет паузу до следующей пробы.
const logger=require('./logger');

const PROBE_INTERVAL=5*60*1000; // мс: как часто во время техработ пропускаем «пробу» (реальный запрос к игре)
const PROBE_MAX=60000;          // мс: если проба «подвисла» дольше — сбрасываем, чтобы не залипнуть навсегда
// При долгих техработах игра может «флапать»: проба проскакивает без maintenance, тут же следующий
// обычный запрос ловит 503 обратно — без этой паузы в чат летит спам из пар "снова доступна"/"техработы"
// каждые ~PROBE_INTERVAL. Поэтому "восстановлено" подтверждаем только если откат не случился RECOVERY_CONFIRM_MS.
const RECOVERY_CONFIRM_MS=90*1000;

let active=false;               // липкий флаг техработ (снимается только успешной пробой)
let sinceTs=0;                  // когда начались техработы (для отчёта в лог/панель)
let lastProbeAt=0;              // время последней пробы/детекта (отсчёт PROBE_INTERVAL)
let probing=false;              // проба уже в полёте
let probeStartedAt=0;
let recoveryPending=false;      // true между успешной пробой и подтверждением (см. RECOVERY_CONFIRM_MS)
let recoveryTimer=null;

class MaintenanceError extends Error{
  constructor(msRemaining){
    const s=Math.max(0,Math.ceil(msRemaining/1000));
    super(`Игра на технических работах — запросы к игре на паузе (следующая проверка через ~${s}с)`);
    this.name='MaintenanceError';
    this.maintenance=true;      // маркер для вызывающих (циклы/роуты могут отличить от обычной ошибки)
    this.retryInMs=Math.max(0,msRemaining);
  }
}

function textOf(data){
  if(data==null)return '';
  if(typeof data==='string')return data;
  try{return JSON.stringify(data);}catch(_){return String(data);}
}
// Тот же критерий, что и у клиента игры.
function isMaintenance(status,data){
  return status===503&&/maintenance/i.test(textOf(data));
}

// Вызывать ПЕРЕД запросом к игре. Бросает MaintenanceError, если сейчас нужно блокировать.
// Возвращает {probe} — является ли этот запрос пробой (единственный пропускаемый раз в PROBE_INTERVAL).
function acquire(){
  if(!active)return {probe:false};                 // норма
  const now=Date.now();
  if(probing){
    if(now-probeStartedAt>PROBE_MAX)probing=false; // подвисшая проба — сбрасываем
    else throw new MaintenanceError(PROBE_INTERVAL-(now-lastProbeAt));
  }
  if(now-lastProbeAt>=PROBE_INTERVAL){             // пора пробовать → пропускаем одну пробу
    probing=true;probeStartedAt=now;lastProbeAt=now;
    return {probe:true};
  }
  throw new MaintenanceError(PROBE_INTERVAL-(now-lastProbeAt)); // ещё рано — блок
}

function notify(text){
  // fire-and-forget: не блокируем путь запроса и не роняем детект при сбое TG
  try{require('./telegram').sendToMainThread(text).catch(()=>{});}catch(_){}
}

// Вызывать ПОСЛЕ ответа (успех или ошибка) с http-статусом и телом ответа.
function report(status,data,gate){
  const now=Date.now();
  if(isMaintenance(status,data)){
    if(!active){ // переход НОРМА → ТЕХРАБОТЫ
      active=true;sinceTs=now;lastProbeAt=now;
      logger.warn('[maintenance] игра на технических работах (503 maintenance) — все запросы к игре поставлены на паузу');
      if(recoveryPending){ // это откат случившегося только что "восстановления" — тот же простой, не спамим повторно
        if(recoveryTimer){clearTimeout(recoveryTimer);recoveryTimer=null;}
        recoveryPending=false;
      }else{
        notify('🛠 Проводятся работы на серверах игры\nПожалуйста, попробуйте зайти позже');
      }
    }
    if(gate&&gate.probe)probing=false;             // проба подтвердила: всё ещё техработы
    return;
  }
  // не техработы:
  if(gate&&gate.probe){                            // это была проба
    if(typeof status==='number'){                  // сервер ответил (пусть даже ошибкой) → игра доступна
      if(active){ // переход ТЕХРАБОТЫ → НОРМА (пока не подтверждён)
        logger.info(`[maintenance] проба прошла успешно (~${Math.round((now-sinceTs)/1000)}с) — ждём подтверждения ${RECOVERY_CONFIRM_MS/1000}с перед уведомлением`);
        recoveryPending=true;
        if(recoveryTimer)clearTimeout(recoveryTimer);
        recoveryTimer=setTimeout(()=>{
          recoveryTimer=null;
          if(recoveryPending&&!active){
            recoveryPending=false;
            logger.info('[maintenance] восстановление подтверждено');
            notify('✅ Игра снова доступна — обслуживание завершено');
          }
        },RECOVERY_CONFIRM_MS);
      }
      active=false;
    }
    probing=false;                                 // при сетевой ошибке пробы остаёмся в паузе, повторим через интервал
  }
  // обычный запрос без сигнала техработ при active=false — ничего не делаем
  // (в active=true обычные запросы сюда не доходят: acquire их блокирует)
}

// Текущее состояние (для эндпоинта панели).
function status(){
  const now=Date.now();
  return {active,since:active?sinceTs:null,retryInMs:active?Math.max(0,PROBE_INTERVAL-(now-lastProbeAt)):0};
}

module.exports={acquire,report,status,isMaintenance,MaintenanceError,PROBE_INTERVAL};
