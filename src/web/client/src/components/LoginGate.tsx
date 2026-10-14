import { useState, useEffect, type ReactNode } from 'react';
import { Box, Button, Spinner, Text, Heading, Flash } from '@primer/react';
import { api } from '../api';

type Phase = 'loading' | 'ok' | 'login';

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
        <Heading as="h2" sx={{ fontSize: 3, mb: 1 }}>TON City Farm</Heading>
        <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block', mb: 3 }}>Введите пароль для доступа к панели</Text>
        {err && <Flash variant="danger" sx={{ mb: 3 }}>{err}</Flash>}
        <input
          type="password"
          autoFocus
          value={password}
          placeholder="Пароль"
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, marginBottom: 16 }}
        />
        <Button variant="primary" block disabled={busy || !password} loading={busy} onClick={submit}>
          Войти
        </Button>
      </Box>
    </Box>
  );
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');

  const check = async () => {
    try {
      const d = await api.authStatus();
      setPhase(d.ok && (!d.required || d.authed) ? 'ok' : 'login');
    } catch { setPhase('login'); }
  };

  useEffect(() => {
    check();
    const onUnauthorized = () => setPhase('login');
    window.addEventListener('tc-unauthorized', onUnauthorized);
    return () => window.removeEventListener('tc-unauthorized', onUnauthorized);
  }, []);

  if (phase === 'loading') {
    return <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></Box>;
  }
  if (phase === 'login') {
    return <LoginScreen onSuccess={() => setPhase('ok')} />;
  }
  return <>{children}</>;
}
