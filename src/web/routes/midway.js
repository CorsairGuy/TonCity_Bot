'use strict';
// «Карнавальная аллея» (/anniversary-midway/) — пять балаганов, по одному в день, 19–24.08.2026.
// У каждого дня свой кошелёк билетов (purse), победа даёт win_tickets, оплачиваемых побед в день —
// paid_wins_cap. День 1 — «Четыре в ряд»; что будет во 2–5, игра заранее не раскрывает (identifier
// пустой до открытия дня), поэтому ничего не хардкодим — раннер сам скажет, если балаган не знаком.
//
// Данные ЖИВЫЕ, как у остальных разделов Годовщины: снимков в БД нет, событие идёт пять дней.
// Прогресс игры лежит в процессе бота (web/lib/midwayRunner.js) — поэтому спиннеры кнопок
// переживают перезагрузку страницы: вкладка не хранит состояние, а спрашивает /api/midway/status.
const logger = require('../../utils/logger');
const opRegistry = require('../lib/opRegistry');
const { sweepAccounts } = require('../lib/accountSweep');
const midwayRunner = require('../lib/midwayRunner');

module.exports = function (app, ctx) {
  const { makeApiForAccount } = ctx;
  const forAllAccounts = (fn, fallback = {}, onlyIds = null) =>
    sweepAccounts(makeApiForAccount, fn, { fallback, label: 'midway', onlyIds });
  const idsOf = req => {
    const raw = String(req.query?.ids || '').trim();
    if (!raw) return null;
    const ids = raw.split(',').map(x => Number(x.trim())).filter(Number.isFinite);
    return ids.length ? ids : null;
  };
  const opKey = (base, ids) => (ids ? `${base}:${ids.join(',')}` : base);
  // Приводим ответ к одной форме — в том числе для аккаунтов, у которых запрос не удался
  // (иначе одна мёртвая строка роняла бы всю страницу, как это было с доской карнавала).
  // Балаганы, которые бот умеет играть. Порядок важен только для подписи в интерфейсе.
  const GAMES = { connect_four: 'Четыре в ряд', battleship: 'Морской бой', pentago: 'Пентаго', quoridor: 'Коридор',
  dots_and_boxes: 'Точки и коробки' };

  function normalize(raw) {
    const c4 = raw?.connect_four || {};
    const stalls = Array.isArray(raw?.stalls) ? raw.stalls : [];
    // Вчерашний балаган остаётся открытым, поэтому «сегодняшний» — это тот из открытых, где ещё
    // остались оплачиваемые победы; если везде выбрано — последний открытый (он и есть сегодняшний).
    const open = stalls.filter(s => s.is_open);
    const today = open.find(s => {
      const c = raw?.[s.identifier] || {};
      return Number(c.paid_wins_cap || 0) > Number(c.paid_wins || 0);
    }) || open[open.length - 1] || null;
    const counters = raw?.[today?.identifier] || {};
    return {
      is_open: !!raw?.is_open,
      opens_at: raw?.opens_at ?? null,
      ends_at: raw?.ends_at ?? null,
      tickets_balance: Number(raw?.tickets_balance ?? 0),
      stalls: stalls.map(s => ({
        day: Number(s.day ?? 0),
        identifier: s.identifier || '',
        opens_at: s.opens_at ?? null,
        is_open: !!s.is_open,
        purse: Number(s.purse ?? 0),
        tickets_earned: Number(s.tickets_earned ?? 0),
      })),
      today_identifier: today?.identifier || '',
      // Счётчики ИМЕННО сегодняшнего балагана — страница рисует прогресс по ним и не обязана
      // знать, какая именно игра идёт (день 3-5 игра пока не раскрывает).
      active: {
        identifier: today?.identifier || '',
        title: GAMES[today?.identifier] || '',
        supported: !!GAMES[today?.identifier],
        paid_wins: Number(counters.paid_wins ?? 0),
        paid_wins_cap: Number(counters.paid_wins_cap ?? 0),
        win_tickets: Number(counters.win_tickets ?? 0),
        tickets_earned: Number(counters.tickets_earned ?? 0),
      },
      connect_four: {
        paid_wins: Number(c4.paid_wins ?? 0),
        paid_wins_cap: Number(c4.paid_wins_cap ?? 0),
        win_tickets: Number(c4.win_tickets ?? 0),
        tickets_earned: Number(c4.tickets_earned ?? 0),
        total_wins: Number(c4.total_wins ?? 0),
        move_seconds: Number(c4.move_seconds ?? 0),
      },
      // партию с живым игроком бот не трогает — страница покажет предупреждение
      active_game: raw?.active_game
        ? { code: raw.active_game.code, status: raw.active_game.status, vs_bot: !!raw.active_game.vs_bot, moves: Number(raw.active_game.moves ?? 0) }
        : null,
    };
  }

  app.get('/api/midway', async (req, res) => {
    try {
      const ids = idsOf(req);
      const accounts = await opRegistry.run(opKey('midway', ids), () => forAllAccounts(async api => {
        const raw = await api.get('/anniversary-midway/');
        return { midway: normalize(raw) };
      }, () => ({ midway: normalize(null) }), ids));
      res.json({ ok: true, accounts });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Сыграть за ОДИН аккаунт: доигрываем дневной кошелёк (paid_wins → paid_wins_cap) против бота.
  app.post('/api/midway/play', async (req, res) => {
    try {
      const { account_id } = req.body || {};
      const { Account } = require('../../db/index');
      const acc = await Account.findByPk(Number(account_id), { attributes: ['id', 'name'] });
      if (!acc) return res.status(404).json({ ok: false, error: 'аккаунт не найден' });
      midwayRunner.enqueue(acc.id, acc.name, makeApiForAccount);
      logger.info(`[${acc.name}] [midway] поставлен в очередь на игру`);
      res.json({ ok: true, started: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Сыграть за всех: очередь та же, разбирается пулом (см. CONCURRENCY в midwayRunner).
  // account_ids необязателен — без него берём все аккаунты.
  app.post('/api/midway/play-all', async (req, res) => {
    try {
      const { account_ids } = req.body || {};
      const { Account } = require('../../db/index');
      const ids = Array.isArray(account_ids) ? account_ids.map(Number).filter(Number.isFinite) : null;
      const accs = ids && ids.length
        ? await Account.findAll({ where: { id: ids }, attributes: ['id', 'name'] })
        : await Account.findAll({ attributes: ['id', 'name'], order: [['id', 'ASC']] });
      for (const acc of accs) midwayRunner.enqueue(acc.id, acc.name, makeApiForAccount);
      logger.info(`[midway] поставлено в очередь аккаунтов: ${accs.length}`);
      res.json({ ok: true, started: accs.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/midway/status', (req, res) => {
    midwayRunner.prune();
    res.json({ ok: true, rows: midwayRunner.list() });
  });
};
