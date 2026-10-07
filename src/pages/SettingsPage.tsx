import { useState } from 'react';
import type { UnitCode } from '../../core/unitMeta';
import { Button, Empty, ErrorBox, PageTitle, Panel, Pill, Segmented, Skeleton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, dash, duration, int, SEVERITY_LABEL } from '../lib/format';
import { useRemote } from '../lib/hooks';
import type { ThemeChoice } from '../lib/theme';
import type { AuthState } from '../lib/types';

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const DAY_TYPE: Record<string, string> = { all: 'todos os dias', weekday: 'dias úteis', weekend: 'fins de semana' };
const STATUS: Record<string, { tone: string; label: string }> = {
  sent: { tone: 'normal', label: 'Enviada' },
  failed: { tone: 'critico', label: 'Falhou' },
  suppressed: { tone: 'muted', label: 'Não enviada' },
  queued: { tone: 'atencao', label: 'Na fila' },
  sending: { tone: 'atencao', label: 'Enviando' },
};
const SUPPRESS: Record<string, string> = { shadow_mode: 'modo sombra', not_configured: 'destinatários não configurados' };

export function SettingsPage({ unit, theme, onTheme, auth }: { unit: UnitCode; theme: ThemeChoice; onTheme: (t: ThemeChoice) => void; auth: AuthState }) {
  const cfg = useRemote(signal => api.config(unit, signal), [unit]);
  const notes = useRemote(signal => api.notifications(unit, signal), [unit], 60_000);
  const [test, setTest] = useState<{ busy: boolean; message?: string; ok?: boolean }>({ busy: false });
  const c = cfg.data;

  const sendTest = async () => {
    if (!confirm(`Enviar uma mensagem de teste aos destinatários de ${unit}? A mensagem tem custo.`)) return;
    setTest({ busy: true });
    try {
      await api.testNotification(unit);
      setTest({ busy: false, ok: true, message: 'Mensagem de teste enviada.' });
      notes.reload();
    } catch (e) {
      setTest({ busy: false, ok: false, message: e instanceof ApiError ? e.message : 'Falha ao enviar' });
    }
  };

  return (
    <>
      <PageTitle unit={unit} title="Configurações" subtitle="Regras, faixas horárias e notificações desta unidade. Cada unidade tem a sua própria configuração." />
      {cfg.error && !c && <ErrorBox error={cfg.error} onRetry={cfg.reload} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Faixas operacionais" hint="O consumo esperado é calculado separadamente em cada faixa (e para dias úteis × fins de semana)">
          {!c ? <Skeleton className="h-40" /> : (
            <table className="data-table">
              <thead><tr><th>Faixa</th><th>Horário</th><th>Dias</th><th className="r">Tolerância</th></tr></thead>
              <tbody>
                {c.windows.map(w => (
                  <tr key={w.key + w.dayType}>
                    <td className="font-medium">{w.name}</td>
                    <td className="num">{hhmm(w.startMin)}–{hhmm(w.endMin === 1440 ? 0 : w.endMin)}</td>
                    <td className="text-ink-3">{DAY_TYPE[w.dayType] ?? w.dayType}</td>
                    <td className="num r">{w.thresholdMultiplier === 1 ? 'padrão' : `×${w.thresholdMultiplier.toString().replace('.', ',')}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-ink-3">“Tolerância” maior deixa a faixa menos sensível (ex.: troca de turno). As faixas vêm do banco de dados e podem ser diferentes em cada hospital.</p>
        </Panel>

        <Panel title="Regras de detecção" hint={c ? `Versão ${c.rules.version} · histórico de ${c.rules.lookbackDays} dias` : undefined}>
          {!c ? <Skeleton className="h-40" /> : (
            <>
              <table className="data-table">
                <thead><tr><th>Nível</th><th className="r">Desvios (σ)</th><th className="r">Excesso mínimo</th><th className="r">Confirmação</th></tr></thead>
                <tbody>
                  {(['atencao', 'alto', 'critico'] as const).map(s => (
                    <tr key={s}>
                      <td className="font-medium">{SEVERITY_LABEL[s]}</td>
                      <td className="num r">&gt; {c.rules.levels[s].z.toString().replace('.', ',')}</td>
                      <td className="num r">+{Math.round(c.rules.levels[s].pct * 100)}%</td>
                      <td className="num r">{c.rules.levels[s].persistence} leituras</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="mt-3 space-y-1 text-xs text-ink-3">
                <li>Esperado = mediana das leituras válidas da mesma faixa; variação normal = desvio absoluto mediano (robusto a picos).</li>
                <li>Nada abaixo do maior valor já visto na faixa (+{Math.round(c.rules.envelope.tolerance * 100)}%) é alerta — protege equipamentos que ligam e desligam.</li>
                <li>Recuperação após {c.rules.recoveryReadings} leituras normais; reabre o mesmo alerta se voltar em até {duration(c.rules.reopenGraceMinutes)}.</li>
                <li>Alerta que não se resolve sobe de nível: atenção → alto em {duration(c.rules.escalateAfterMinutes.atencao)}, alto → crítico em {duration(c.rules.escalateAfterMinutes.alto)}.</li>
                <li>Tarifa usada nas estimativas: R$ {c.tariffBrlPerKwh.toFixed(2).replace('.', ',')}/kWh (estimativa de mercado — não é o valor do contrato).</li>
              </ul>
            </>
          )}
        </Panel>

        <Panel title="Notificações (WhatsApp)" className="lg:col-span-2"
          actions={auth.authRequired && auth.authenticated ? <Button onClick={sendTest} disabled={test.busy || !c?.notify.configured}>{test.busy ? 'Enviando…' : 'Enviar mensagem de teste'}</Button> : undefined}>
          {!c ? <Skeleton className="h-24" /> : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                <span>Envio: {c.notify.configured ? <Pill tone="normal">Configurado · {int(c.notify.recipients)} destinatário(s)</Pill> : <Pill tone="critico">Não configurado</Pill>}</span>
                {c.shadowMode && <Pill tone="atencao">Modo sombra: avalia e registra, mas não envia</Pill>}
                <span className="text-ink-3">
                  Mensagens a partir de <strong className="text-ink">{SEVERITY_LABEL[c.policy.notifyFrom]}</strong> · excesso acumulado mínimo de {int(c.policy.minExcessKwhToNotify)} kWh ·
                  no máximo {c.policy.maxPerUnitPerHour}/hora (crítico nunca é retido) · lembrete {c.policy.reminderMinutes.critico ? `a cada ${duration(c.policy.reminderMinutes.critico)} (crítico)` : 'desligado'}
                </span>
              </div>
              {test.message && <p role="status" className="text-[13px]" style={{ color: test.ok ? 'var(--ok)' : 'var(--crit)' }}>{test.message}</p>}
              {!auth.authRequired && <p className="text-xs text-ink-3">Para enviar mensagem de teste, defina APP_ACCESS_PASSWORD no servidor (ações que geram custo exigem login).</p>}
              <div>
                <h3 className="mb-1.5 text-sm font-semibold">Últimas notificações de {unit}</h3>
                {!notes.data ? <Skeleton className="h-24" /> : notes.data.notifications.length === 0 ? <Empty title="Nenhuma notificação ainda" /> : (
                  <div className="overflow-x-auto rounded-md border border-line">
                    <table className="data-table">
                      <thead><tr><th>Quando</th><th>Tipo</th><th>Situação</th><th className="r">Alertas</th><th>Detalhe</th></tr></thead>
                      <tbody>
                        {notes.data.notifications.map(n => (
                          <tr key={n.id}>
                            <td className="num whitespace-nowrap">{dateTime(n.createdAt)}</td>
                            <td>{n.kind === 'test' ? 'Teste' : 'Resumo de alertas'}</td>
                            <td><Pill tone={STATUS[n.status]?.tone ?? 'muted'}>{STATUS[n.status]?.label ?? n.status}</Pill></td>
                            <td className="num r">{n.alertCount || dash}</td>
                            <td className="text-xs text-ink-3">{n.status === 'suppressed' ? SUPPRESS[n.suppressReason ?? ''] ?? n.suppressReason : n.error ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Aparência">
          <Segmented label="Tema" value={theme} onChange={onTheme} options={[{ value: 'system', label: 'Automático' }, { value: 'light', label: 'Claro' }, { value: 'dark', label: 'Escuro' }]} />
        </Panel>
      </div>
    </>
  );
}
