import { useState, useEffect } from 'react';
import { Box, Button, Flash, FormControl, IconButton, Label, Text, TextInput } from '@primer/react';
import { DataTable, Dialog, Table } from '@primer/react/experimental';
import { PlusIcon, SyncIcon, TrashIcon } from '@primer/octicons-react';
import { PageHeader } from '../components/PageHeader';
import { api, type Account } from '../api';
import { sortByName } from '../utils';
import { useAsk } from '../hooks/useAsk';
import { useNarrow } from '../hooks/useNarrow';
import { LoadError, errText } from '../components/LoadError';

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<{ id: number; name: string }[][]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [addErr, setAddErr] = useState('');
  const ask = useAsk();
  const narrow = useNarrow();

  const showFlash = (msg: string, ok: boolean) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [d, dup] = await Promise.all([api.accounts(), api.accountDuplicates()]);
      if (d.ok) { setAccounts(sortByName(d.accounts, 'name')); setLoadErr(''); }
      else setLoadErr(errText(d));
      if (dup.ok) setDuplicateGroups(dup.groups);
    } catch (e) { setLoadErr(String(e)); } finally { setLoading(false); }
  };

  const addAccount = async () => {
    if (!addUrl.trim()) return;
    setAdding(true); setAddErr('');
    try {
      const d = await api.addAccount(addUrl.trim());
      if (d.ok) {
        showFlash(`Аккаунт ${d.name} ${d.created ? 'добавлен' : 'обновлён'}`, true);
        setAddUrl('');
        setAddOpen(false);
        await load();
      } else setAddErr(d.error ?? 'Ошибка'); // в окне: флэш на странице прячется под его затемнением
    } catch (e) { setAddErr(String(e)); } finally { setAdding(false); }
  };

  const removeAccount = async (id: number, name: string) => {
    if (!await ask('Удалить аккаунт?', `Аккаунт «${name}» и его токены будут удалены из бота.`, { ok: 'Удалить', danger: true })) return;
    setRemoving(prev => new Set(prev).add(id));
    try {
      const d = await api.deleteAccount(id);
      if (d.ok) { showFlash(`Аккаунт ${name} удалён`, true); await load(); }
      else showFlash(`Не удалось удалить ${name}: ${d.error ?? 'ошибка'}`, false);
    } catch (e) { showFlash(`Не удалось удалить ${name}: ${e}`, false); } finally {
      setRemoving(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  useEffect(() => { load(); }, []);

  // сортировка статуса от "хуже к лучше", чтобы проблемные аккаунты было видно сразу при клике на колонку
  const STATUS_RANK: Record<Account['sessionStatus'], number> = { dead: 0, unknown: 1, connecting: 2, active: 3 };
  const data = [...accounts]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map(a => ({ ...a, _status: a.hasToken ? STATUS_RANK[a.sessionStatus] : -1 }));

  // проблемные — без токена или с протухшей сессией (то же, что красный статус в таблице)
  const problemCount = accounts.filter(a => !a.hasToken || a.sessionStatus === 'dead').length;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader
        title="Аккаунты"
        sub={accounts.length > 0 && <>
          {accounts.length}
          {problemCount > 0 && <Text sx={{ color: 'danger.fg' }}> · {problemCount} требу{problemCount === 1 ? 'ет' : 'ют'} внимания</Text>}
        </>}
        actions={<>
          <Button leadingVisual={SyncIcon} loading={loading} disabled={loading} onClick={load}>Обновить</Button>
          <Button variant="primary" leadingVisual={PlusIcon} onClick={() => setAddOpen(true)}>Добавить аккаунт</Button>
        </>}
      />
      {addOpen && (
        <Dialog
          title="Добавить аккаунт"
          onClose={() => { setAddOpen(false); setAddErr(''); }}
          position={{ narrow: 'bottom', regular: 'center' }}
          footerButtons={[
            { content: 'Отмена', onClick: () => { setAddOpen(false); setAddErr(''); } },
            { content: 'Добавить', buttonType: 'primary', loading: adding, disabled: adding || !addUrl.trim(), onClick: addAccount },
          ]}
        >
          <FormControl>
            <FormControl.Label>Ссылка из игры</FormControl.Label>
            <FormControl.Caption>Вида https://game.toncity.io/auth?t=...</FormControl.Caption>
            <TextInput
              autoFocus
              block
              value={addUrl}
              validationStatus={addErr ? 'error' : undefined}
              onChange={e => { setAddUrl(e.target.value); setAddErr(''); }}
              placeholder="https://game.toncity.io/auth?t=..."
              onKeyDown={e => e.key === 'Enter' && addAccount()}
            />
            {addErr && <FormControl.Validation variant="error">{addErr}</FormControl.Validation>}
          </FormControl>
        </Dialog>
      )}
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <LoadError error={loadErr} onRetry={load} />

      {duplicateGroups.length > 0 && (
        <Box sx={{ border: '1px solid', borderColor: 'danger.emphasis', borderRadius: 2, mb: 3, p: 3, bg: 'danger.subtle' }}>
          <Text sx={{ fontSize: 1, fontWeight: 'bold', color: 'danger.fg', display: 'block', mb: 1 }}>
            Найдены задвоенные аккаунты ({duplicateGroups.length})
          </Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>
            Эти пары аккаунтов раскодируются в ОДИН и тот же ID игрового пользователя (проверено по JWT
            в access_token, не догадка) — значит это один и тот же реальный игровой аккаунт, добавленный
            дважды. Игра ротирует refresh_token на каждый рефреш: пока обе записи бота живут независимо,
            рефреш из одной строки БД инвалидирует токен другой — отсюда постоянные «Invalid or expired
            refresh token» без возможности восстановиться. Оставьте одну запись на пару, вторую удалите.
          </Text>
          {duplicateGroups.map((group, i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', py: 1 }}>
              {group.map(a => (
                <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Label variant="danger">{a.name} (id {a.id})</Label>
                  <Button
                    variant="danger"
                    loading={removing.has(a.id)}
                    disabled={removing.size > 0}
                    onClick={() => removeAccount(a.id, a.name)}
                  >
                    Удалить
                  </Button>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )}

      <Table.Container>
        <DataTable
          data={data}
          initialSortColumn="name"
          initialSortDirection="ASC"
          columns={[
            {
              header: 'Аккаунт',
              field: 'name',
              rowHeader: true,
              width: narrow ? 'growCollapse' : 'grow',
              sortBy: 'alphanumeric',
              renderCell: row => <strong style={{ overflowWrap: 'anywhere' }}>{row.name}</strong>,
            },
            {
              header: 'Статус',
              field: '_status',
              sortBy: 'basic',
              renderCell: row => {
                if (!row.hasToken) return <Label variant="danger">Нет токена</Label>;
                switch (row.sessionStatus) {
                  case 'active': return <Label variant="success">Активен</Label>;
                  case 'dead': return <Label variant="danger">Токен протух</Label>;
                  case 'connecting': return <Label variant="attention">Подключается…</Label>;
                  default: return <Label variant="secondary">Не проверялся</Label>;
                }
              },
            },
            {
              header: '',
              field: 'name',
              id: 'action',
              align: 'end',
              renderCell: row => (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  {narrow ? (
                    <IconButton
                      variant="danger"
                      icon={TrashIcon}
                      aria-label={`Удалить ${row.name}`}
                      disabled={removing.has(row.id)}
                      onClick={() => removeAccount(row.id, row.name)}
                    />
                  ) : (
                    <Button
                      variant="danger"
                      leadingVisual={TrashIcon}
                      loading={removing.has(row.id)}
                      onClick={() => removeAccount(row.id, row.name)}
                    >
                      Удалить
                    </Button>
                  )}
                </Box>
              ),
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
