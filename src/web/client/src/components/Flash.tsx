import { Flash as PrimerFlash } from '@primer/react';

interface FlashState { msg: string; ok: boolean }

export function Flash({ flash }: { flash: FlashState | null }) {
  if (!flash) return null;
  return (
    <PrimerFlash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>
      {flash.msg}
    </PrimerFlash>
  );
}