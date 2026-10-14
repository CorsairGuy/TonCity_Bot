'use strict';
// Будим цикл прокачки города конкретного аккаунта раньше долгого сна, когда пользователь только
// что сохранил новые цели улучшений (см. web/routes/cityStrategy.js) — иначе index.js's
// cityUpgradeLoop мог спать до 6 часов после "нечего делать", даже если строители свободны прямо
// сейчас и новая цель уже актуальна.
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(200); // по одному ожидающему на каждый активный аккаунт

function wake(account) { bus.emit(`wake:${account}`); }

// ждать либо `ms`, либо сигнал wake(account) — смотря что раньше
function waitOrWake(account, ms) {
  return new Promise(resolve => {
    const onWake = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { bus.off(`wake:${account}`, onWake); resolve(); }, ms);
    bus.once(`wake:${account}`, onWake);
  });
}

module.exports = { wake, waitOrWake };
