import { useState } from 'react';

import { draftFromMission } from '../lib/content.ts';
import { Button, Notice, Panel, SectionTitle } from './primitives.tsx';

/** Turns the crew's report into draft pieces in the content calendar. The tap is the approval; nothing is published. */
export function ContentPanel({ missionId }: { missionId: string }) {
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      setCount((await draftFromMission(missionId)).items.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron crear las piezas.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="space-y-3">
      <SectionTitle>Contenidos para redes</SectionTitle>
      <p className="text-sm text-[var(--color-ink-dim)]">Convierte este informe en borradores de publicaciones (texto, guion de voz e idea de foto). Tarda unos 10–30 segundos.</p>
      <Button busy={busy} onClick={() => void go()}>Crear piezas en Contenidos</Button>
      {error !== null && <Notice tone="mock" title="No se pudo">{error}</Notice>}
      {count !== null && (
        <p className="text-sm">
          Se han creado {count} piezas. <a className="underline" href="#/content">Abrir Contenidos</a>
        </p>
      )}
    </Panel>
  );
}
