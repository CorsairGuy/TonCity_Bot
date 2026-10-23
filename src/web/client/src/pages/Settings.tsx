import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Text, FormControl, Select, TextInput, SegmentedControl, ToggleSwitch } from '@primer/react';
import { SunIcon, MoonIcon } from '@primer/octicons-react';
import { api } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useAppTheme } from '../components/AppThemeProvider';
import { UpdatesCard } from '../components/UpdatesCard';
import { useAsk } from '../hooks/useAsk';

export function Settings() {
  const ask = useAsk();
  const { theme, setTheme } = useAppTheme();
  const [logLevel, setLogLevel] = useState('info');
  const [botToken, setBotToken] = useState('');
  const [maintenanceChatId, setMaintenanceChatId] = useState('');
  const [maintenanceThreadId, setMaintenanceThreadId] = useState('');
  const [wordleChatId, setWordleChatId] = useState('');
  const [wordleThreadId, setWordleThreadId] = useState('');
  const [marketChatId, setMarketChatId] = useState('');
  const [marketThreadId, setMarketThreadId] = useState('');
  const [marketMonitoring, setMarketMonitoring] = useState(true);
  const [savingMarketMonitoring, setSavingMarketMonitoring] = useState(false);
  const [savingTg, setSavingTg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [pwSet, setPwSet] = useState(false);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const { flash, showFlash } = useFlash();

  useEffect(() => {
    api.config().then(d => {
      if (!d.ok) return;
      setLogLevel(d.settings.logLevel ?? 'info');
      const features = (d.settings.features as Record<string, boolean>) ?? {};
      setMarketMonitoring(features.marketMonitoring ?? true);
      const tg = d.settings.telegram ?? {};
      setBotToken(tg.botToken ?? '');
      setMaintenanceChatId(tg.maintenanceChatId ?? '');
      setMaintenanceThreadId(tg.maintenanceThreadId ?? '');
      setWordleChatId(tg.wordleChatId ?? '');
      setWordleThreadId(tg.wordleThreadId ?? '');
      setMarketChatId(tg.marketChatId ?? '');
      setMarketThreadId(tg.marketThreadId ?? '');
    }).catch(() => {});
    api.authStatus().then(d => { if (d.ok) setPwSet(d.required); }).catch(() => {});
  }, []);

  const savePassword = async () => {
    if (pw1.length < 4) { showFlash('Пароль слишком короткий (мин. 4 символа)', false); return; }
    if (pw1 !== pw2) { showFlash('Пароли не совпадают', false); return; }
    setSavingPw(true);
    try {
      const d = await api.setPassword(pw1);
      if (d.ok) { showFlash(pwSet ? 'Пароль изменён' : 'Пароль установлен', true); setPwSet(true); setPw1(''); setPw2(''); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setSavingPw(false); }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    location.reload();
  };

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.saveConfig({ logLevel });
      if (d.ok) showFlash('Настройки сохранены', true);
      else showFlash('Ошибка: ' + d.error, false);
    } finally { setSaving(false); }
  };

  const toggleMarketMonitoring = async (next: boolean) => {
    setMarketMonitoring(next);
    setSavingMarketMonitoring(true);
    try {
      const d = await api.saveConfig({ features: { marketMonitoring: next } });
      if (!d.ok) { setMarketMonitoring(!next); showFlash('Ошибка: ' + d.error, false); }
    } finally { setSavingMarketMonitoring(false); }
  };

  const saveTelegram = async () => {
    setSavingTg(true);
    try {
      const d = await api.saveConfig({
        telegram: {
          botToken,
          maintenanceChatId, maintenanceThreadId,
          wordleChatId, wordleThreadId,
          marketChatId, marketThreadId,
        },
      });
      if (d.ok) showFlash('Настройки Telegram сохранены', true);
      else showFlash('Ошибка: ' + d.error, false);
    } finally { setSavingTg(false); }
  };

  const restart = async () => {
    if (!await ask('Перезапустить бот?', 'Бот и панель будут недоступны несколько секунд.', { ok: 'Перезапустить', danger: true })) return;
    setRestarting(true);
    try {
      await api.restart();
      showFlash('Перезапуск...', true);
      setTimeout(() => location.reload(), 3000);
    } catch (e: unknown) { showFlash('Ошибка: ' + String(e), false); setRestarting(false); }
  };

  const monitoringPossible = !!botToken.trim() && !!marketChatId.trim();

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Настройки</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
          <Text sx={{ fontWeight: 'bold' }}>Оформление</Text>
        </Box>
        <Box sx={{ p: 3 }}>
          <FormControl>
            <FormControl.Label>Тема</FormControl.Label>
            <Box sx={{ mt: 1 }}>
              <SegmentedControl aria-label="Тема оформления">
                <SegmentedControl.IconButton icon={SunIcon} aria-label="Светлая" selected={theme === 'light'} onClick={() => setTheme('light')} />
                <SegmentedControl.IconButton icon={MoonIcon} aria-label="Тёмная" selected={theme === 'dark'} onClick={() => setTheme('dark')} />
              </SegmentedControl>
            </Box>
            <FormControl.Caption>Переключается вручную и запоминается в браузере. {theme === 'dark' ? 'Тёмная' : 'Светлая'} тема.</FormControl.Caption>
          </FormControl>
        </Box>
      </Box>

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
          <Text sx={{ fontWeight: 'bold' }}>Система</Text>
        </Box>
        <Box sx={{ p: 3 }}>
          <Box sx={{ maxWidth: 320 }}>
            <FormControl>
              <FormControl.Label>Уровень логов</FormControl.Label>
              <Select value={logLevel} onChange={e => setLogLevel(e.target.value)}>
                <Select.Option value="error">error — только ошибки</Select.Option>
                <Select.Option value="warn">warn — предупреждения и ошибки</Select.Option>
                <Select.Option value="info">info — стандартный</Select.Option>
                <Select.Option value="debug">debug — подробный</Select.Option>
              </Select>
              <FormControl.Caption>Определяет детализацию вывода в файл логов</FormControl.Caption>
            </FormControl>
          </Box>
        </Box>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderTop: '1px solid', borderColor: 'border.default' }}>
          <Button variant="primary" onClick={save} disabled={saving} loading={saving}>
            Сохранить
          </Button>
        </Box>
      </Box>

      <UpdatesCard />

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
          <Text sx={{ fontWeight: 'bold' }}>Telegram-уведомления</Text>
        </Box>
        <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ maxWidth: 480 }}>
            <FormControl>
              <FormControl.Label>Токен бота</FormControl.Label>
              <TextInput block value={botToken} onChange={e => setBotToken(e.target.value)} placeholder="1234567890:AAAA..." />
              <FormControl.Caption>
                Токен, полученный от @BotFather. Общий для всех уведомлений ниже. Если оставить
                пустым — никакие Telegram-уведомления отправляться не будут.
              </FormControl.Caption>
            </FormControl>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3, p: 2, border: '1px solid', borderColor: 'border.default', borderRadius: 2 }}>
            <Box>
              <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block' }}>Мониторинг цен рынка</Text>
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                Периодическая проверка курсов Центрального рынка и пост в Telegram. Выключение
                останавливает сам цикл проверки, не только уведомления.
                {!monitoringPossible && ' Пока не заполнены токен бота и Chat ID "Цены на рынке" ниже — мониторинг не запускается, независимо от этого переключателя.'}
              </Text>
            </Box>
            <ToggleSwitch checked={marketMonitoring && monitoringPossible} disabled={savingMarketMonitoring || !monitoringPossible} onClick={() => toggleMarketMonitoring(!marketMonitoring)} aria-label="Мониторинг цен рынка" />
          </Box>

          {[
            { title: 'Технические работы игры', chat: maintenanceChatId, setChat: setMaintenanceChatId, thread: maintenanceThreadId, setThread: setMaintenanceThreadId },
            { title: 'Wordle', chat: wordleChatId, setChat: setWordleChatId, thread: wordleThreadId, setThread: setWordleThreadId },
            { title: 'Цены на рынке', chat: marketChatId, setChat: setMarketChatId, thread: marketThreadId, setThread: setMarketThreadId },
          ].map(({ title, chat, setChat, thread, setThread }) => (
            <Box key={title} sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Text sx={{ fontSize: 1, fontWeight: 'bold', width: 200, flexShrink: 0 }}>{title}</Text>
              <Box sx={{ minWidth: 200, flex: 1 }}>
                <FormControl>
                  <FormControl.Label>Chat ID</FormControl.Label>
                  <TextInput block value={chat} onChange={e => setChat(e.target.value)} placeholder="-1001234567890" />
                </FormControl>
              </Box>
              <Box sx={{ minWidth: 160, flex: 1 }}>
                <FormControl>
                  <FormControl.Label>Тред (топик)</FormControl.Label>
                  <TextInput block value={thread} onChange={e => setThread(e.target.value)} placeholder="не обязательно" />
                </FormControl>
              </Box>
            </Box>
          ))}
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
            Пустой Chat ID — уведомления этого типа отправляться не будут, даже если токен указан.
          </Text>
        </Box>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderTop: '1px solid', borderColor: 'border.default' }}>
          <Button variant="primary" onClick={saveTelegram} disabled={savingTg} loading={savingTg}>
            Сохранить
          </Button>
        </Box>
      </Box>

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text sx={{ fontWeight: 'bold' }}>Безопасность</Text>
          {pwSet && <Button onClick={logout}>Выйти</Button>}
        </Box>
        <Box sx={{ p: 3 }}>
          {!pwSet && (
            <Flash variant="warning" sx={{ mb: 3 }}>
              Пароль не задан — панель открыта без авторизации. Задайте пароль, особенно если бот доступен по сети.
            </Flash>
          )}
          <Box sx={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <FormControl>
              <FormControl.Label>{pwSet ? 'Новый пароль' : 'Пароль'}</FormControl.Label>
              <TextInput type="password" block value={pw1} onChange={e => setPw1(e.target.value)} placeholder="мин. 4 символа" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Повторите пароль</FormControl.Label>
              <TextInput type="password" block value={pw2} onChange={e => setPw2(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') savePassword(); }} />
            </FormControl>
            <Box>
              <Button variant="primary" onClick={savePassword} disabled={savingPw || !pw1} loading={savingPw}>
                {pwSet ? 'Сменить пароль' : 'Установить пароль'}
              </Button>
            </Box>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
              Хранится как scrypt-хэш в settings.json. Сессия — на 30 дней. Забыли пароль — удалите <code>web.passwordHash</code> из config/settings.json на сервере.
            </Text>
          </Box>
        </Box>
      </Box>

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
          <Text sx={{ fontWeight: 'bold' }}>Опасная зона</Text>
        </Box>
        <Box sx={{ p: 3, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '3px solid', borderLeftColor: 'danger.fg' }}>
          <Box>
            <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block' }}>Перезапуск бота</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
              Прерывает текущие операции. Docker автоматически перезапустит процесс.
            </Text>
          </Box>
          <Button variant="danger" onClick={restart} disabled={restarting} loading={restarting}>
            Перезапустить
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
