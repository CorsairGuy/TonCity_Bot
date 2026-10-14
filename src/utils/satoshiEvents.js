'use strict';
// Маленькая шина событий Башни Сатоши — чтобы страница обновлялась без перезагрузки, когда
// позиция открылась/закрылась (в т.ч. авто по TP/SL или условному ордеру) из любого места
// (веб-роут, монитор авто-закрытия, монитор условных ордеров). web/server.js слушает это и
// рассылает всем открытым вкладкам /ws/satoshi — без него пришлось бы либо городить общий
// EventEmitter через циклические require, либо просто ждать периодического опроса.
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);

function positionsChanged(account) { bus.emit('positions-changed', { account }); }
function onPositionsChanged(cb) { bus.on('positions-changed', cb); return () => bus.off('positions-changed', cb); }

module.exports = { positionsChanged, onPositionsChanged };
