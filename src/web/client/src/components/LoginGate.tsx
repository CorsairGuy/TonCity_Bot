import { useState, useEffect, type ReactNode } from 'react';
import { Box, Button, Spinner, Text, Heading, Flash, TextInput, FormControl } from '@primer/react';
import { api } from '../api';

type Phase = 'loading' | 'ok' | 'login' | 'offline';

const RETRY_MS = 5000;

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!password) return;
    setBusy(true); setErr('');
    try {
      const d = await api.login(password);
      if (d.ok) onSuccess();
      else setErr(d.error || 'Неверный пароль');
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, bg: 'canvas.default' }}>
      <Box sx={{ width: 340, maxWidth: '95vw', border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 4, bg: 'canvas.subtle' }}>
        <Heading as="h2" sx={{ fontSize: 3, mb: 1 }}>TON City</Heading>
        <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block', mb: 3 }}>Введите пароль для доступа к панели</Text>
        {err && <Flash variant="danger" sx={{ mb: 3 }}>{err}</Flash>}
        <FormControl sx={{ mb: 3 }}>
          <FormControl.Label visuallyHidden>Пароль</FormControl.Label>
          <TextInput
            type="password"
            autoFocus
            block
            value={password}
            placeholder="Пароль"
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          />
        </FormControl>
        <Button variant="primary" block disabled={busy || !password} loading={busy} onClick={submit}>
          Войти
        </Button>
      </Box>
    </Box>
  );
}

// Бот перезапускается (обновление, 502 от прокси) или нет сети: это не повод просить пароль.
function OfflineScreen({ error }: { error: string }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, bg: 'canvas.default' }}>
      <Box sx={{ width: 340, maxWidth: '95vw', border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 4, bg: 'canvas.subtle', textAlign: 'center' }}>
        <Spinner size="medium" srText={null} />
        <Heading as="h2" sx={{ fontSize: 3, mt: 2, mb: 1 }}>Бот недоступен</Heading>
        <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block' }}>
          {error || 'Нет ответа от сервера'}. Повтор через {RETRY_MS / 1000} с.
        </Text>
      </Box>
    </Box>
  );
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [offlineErr, setOfflineErr] = useState('');
  const [attempt, setAttempt] = useState(0);

  const check = async () => {
    const d = await api.authStatus() as { ok: boolean; required?: boolean; authed?: boolean; error?: string };
    if (!d.ok) { setOfflineErr(d.error || ''); setPhase('offline'); setAttempt(a => a + 1); return; }
    setPhase(!d.required || d.authed ? 'ok' : 'login');
  };

  useEffect(() => {
    check();
    const onUnauthorized = () => setPhase('login');
    window.addEventListener('tc-unauthorized', onUnauthorized);
    return () => window.removeEventListener('tc-unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (phase !== 'offline') return;
    const t = setTimeout(check, RETRY_MS);
    return () => clearTimeout(t);
  }, [phase, attempt]);

  if (phase === 'loading') {
    return <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></Box>;
  }
  if (phase === 'offline') return <OfflineScreen error={offlineErr} />;
  if (phase === 'login') {
    return <LoginScreen onSuccess={() => setPhase('ok')} />;
  }
  return <>{children}</>;
}
