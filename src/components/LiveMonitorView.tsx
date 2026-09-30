import React, { useMemo, useState } from 'react';
import { ProcessedTelemetryData } from '../types';
import { logAlert } from '../lib/alertLog';
import { buildSectorBandStats, detectSectorAnomalies, formatSectorParam, formatValorParam, formatSetorNomeParam, formatDataHoraParam, formatPercentualParam, formatExcedenteKwhParam, formatCustoEventoParam, formatImpactoMensalValorParam, formatOcorrenciasParam, formatCausaProvavelParam, formatAcaoRecomendadaParam, formatStandardAlertMessage, getActionText, getAlertMarginPct, withHospitalPrefix, SectorAnomaly } from '../lib/anomalyDetection';
import { Bot, AlertTriangle, CheckCircle2, Activity, Send, Clock, RefreshCw, Database } from 'lucide-react';
import { useHospital } from '../config/HospitalContext';

interface Props {
  data: ProcessedTelemetryData[];
  lastUpdate: Date;
  onRefresh: () => void;
}

export function LiveMonitorView({ data, lastUpdate, onRefresh }: Props) {
  const { hospital } = useHospital();
  const [notifying, setNotifying] = useState<Record<string, boolean>>({});
  // Sem planilha de telemetria não há anomalia pra notificar. Com planilha,
  // o /api/notify?hospital=<id> roteia pros destinatários daquele hospital
  // (env ALERT_PHONE_NUMBERS_<ID> na Vercel).
  const notifyDisabled = !hospital.sheetUrl;

  const handleNotify = async (alertId: string, anomaly: SectorAnomaly) => {
    if (notifyDisabled) return;
    setNotifying(prev => ({ ...prev, [alertId]: true }));
    try {
      // Telefone/remetente salvos em Configurações são específicos do
      // hospital atual (HCN) — só usados quando é ele. Pros demais
      // hospitais, manda undefined e deixa o /api/notify resolver pelo
      // runtime do hospital (ALERT_PHONE_NUMBERS_<ID>/ALERT_WHATSAPP_FROM_<ID>);
      // um valor sempre-preenchido aqui bloquearia essa resolução (o backend
      // só cai no runtime quando o campo vem vazio do frontend).
      const isDefaultHospital = hospital.id === 'atual';
      const phone = isDefaultHospital ? (localStorage.getItem('notify_phone_number') || '5511949102183') : undefined;
      const appId = localStorage.getItem('vonage_app_id');
      const privateKey = localStorage.getItem('vonage_private_key');
      const whatsappFrom = isDefaultHospital ? (localStorage.getItem('vonage_whatsapp_from') || '556298792013') : undefined;
      // Nome do setor com o hospital no texto do alerta (WhatsApp/número
      // compartilhado). Não mexe no que o dashboard mostra nem no logAlert.
      const forAlert = withHospitalPrefix(anomaly, hospital.label, hospital.id === 'atual');
      const message = formatStandardAlertMessage(forAlert);
      const sectorParam = formatSectorParam(forAlert.sectorName, forAlert.severity);
      const valor = formatValorParam(forAlert.val, forAlert.expectedMax);
      const templateParams = forAlert.templateOverride
        ? [
            formatDataHoraParam(forAlert),
            formatSetorNomeParam(forAlert.sectorName),
            formatPercentualParam(anomaly),
            formatExcedenteKwhParam(anomaly),
            formatCustoEventoParam(anomaly),
            formatImpactoMensalValorParam(anomaly),
            formatOcorrenciasParam(anomaly),
            formatCausaProvavelParam(anomaly),
            formatAcaoRecomendadaParam(anomaly),
          ]
        : undefined;
      const response = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sector: sectorParam, message, valor, phone, appId, privateKey, whatsappFrom, templateOverride: anomaly.templateOverride, templateParams, hospital: hospital.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to send notification");

      const smsFallback = (data.results || []).find((r: any) => r.channel === 'sms' && r.whatsappError);
      if (smsFallback) {
        console.warn("WhatsApp falhou, notificação caiu para SMS:", smsFallback.whatsappError);
        alert(`Notificação enviada por SMS (WhatsApp falhou: ${smsFallback.whatsappError})`);
      } else {
        alert("Notificação enviada com sucesso!");
      }
      
      // Log the alert to local history view
      logAlert(anomaly, hospital.id);
    } catch (e: any) {
      console.warn("Notification error:", e);
      alert(`Erro ao enviar notificação: ${e?.message || e}`);
    } finally {
      setNotifying(prev => ({ ...prev, [alertId]: false }));
    }
  };

  const { lastRecord, alerts, totalPlant } = useMemo(() => {
    if (!data || data.length === 0) return { lastRecord: null, alerts: [] as SectorAnomaly[], totalPlant: 0 };

    const last = data[data.length - 1];

    // Mesma base estatística (por setor e turno) usada no Relatório de
    // Diagnóstico da IA, aplicada apenas ao último registro de 15 minutos.
    const sStats = buildSectorBandStats(data, hospital.allSectors, hospital.alertEngineV2);
    const alerts = detectSectorAnomalies(last, sStats, data, undefined, hospital.sectorMapping, hospital.allSectors, hospital.alertEngineV2);
    alerts.sort((a, b) => b.deviation - a.deviation);

    const total = Number(last.Total_Consumption || 0);

    return { lastRecord: last, alerts, totalPlant: total };
  }, [data, hospital.id]);

  // Registra automaticamente as anomalias ativas no histórico local
  React.useEffect(() => {
    if (alerts && alerts.length > 0) {
      alerts.forEach(alert => logAlert(alert, hospital.id));
    }
  }, [alerts]);

  const formatKw = (val: number) => Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(val);

  if (!lastRecord) {
    return <div className="text-gray-400 p-8 flex justify-center items-center h-full">Nenhum dado disponível.</div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">

      {/* HEADER SECTION */}
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Clock className="text-blue-500 w-6 h-6" />
            Monitoramento de 15 Minutos
          </h2>
          <p className="text-gray-400 text-sm mt-1">
            Visualização em tempo real das anomalias no último ciclo registrado (automático a cada 15m).
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2 bg-[#1A1A1A] border border-[#333] px-3 py-1.5 rounded-md">
             <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
             <div className="text-xs text-gray-300 font-mono">Último Fetch: {lastUpdate.toLocaleTimeString()}</div>
             <button onClick={onRefresh} className="ml-2 hover:bg-[#333] p-1 rounded-md transition-colors" title="Atualizar agora">
               <RefreshCw className="w-3 h-3 text-gray-400 hover:text-white" />
             </button>
          </div>
          <div className="text-xs text-gray-500 font-mono">Timestamp do dado: {lastRecord.timestamp}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="chart-container flex items-center justify-between col-span-1">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">CONSUMO GLOBAL (15m)</div>
             <div className="text-2xl font-bold text-white font-mono">{formatKw(totalPlant)} <span className="text-sm text-gray-500 font-sans">kWh</span></div>
           </div>
           <Activity className="text-blue-500/50 w-8 h-8" />
        </div>
        <div className="chart-container flex items-center justify-between col-span-1">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">TOTAL DE SETORES ANALISADOS</div>
             <div className="text-2xl font-bold text-white font-mono">{hospital.allSectors.length}</div>
           </div>
           <Database className="text-emerald-500/50 w-8 h-8" />
        </div>
        <div className="chart-container flex items-center justify-between col-span-1">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">ANOMALIAS ATIVAS (AGORA)</div>
             <div className={`text-2xl font-bold font-mono ${alerts.length > 0 ? 'text-red-500' : 'text-green-500'}`}>{alerts.length}</div>
           </div>
           {alerts.length > 0 ? <AlertTriangle className="text-red-500/50 w-8 h-8" /> : <CheckCircle2 className="text-green-500/50 w-8 h-8" />}
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="chart-container flex flex-col items-center justify-center py-16 border-green-500/20 bg-green-950/5">
          <CheckCircle2 className="w-12 h-12 text-green-500 mb-4 opacity-80" />
          <h3 className="text-xl font-medium text-green-400 mb-2">Operação Normal</h3>
          <p className="text-gray-400 text-center max-w-lg">
            Nenhuma anomalia detectada no último ciclo de 15 minutos ({lastRecord.timestamp}). Todos os setores estão operando dentro do desvio padrão esperado.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <h3 className="font-semibold text-lg text-gray-200 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-500" />
            Detalhes das Anomalias ({lastRecord.timestamp})
          </h3>

          <div className="grid grid-cols-1 gap-4">
            {alerts.map((alert, idx) => {
              const actionText = getActionText(alert);

              // Get last 3 points
              const t0 = data.length >= 3 ? data[data.length - 3] : null;
              const t1 = data.length >= 2 ? data[data.length - 2] : null;
              const t2 = lastRecord;

              let trendText = "";
              if (t0 && t1 && t2) {
                 const v0 = Number(t0[alert.sectorKey]) || 0;
                 const v1 = Number(t1[alert.sectorKey]) || 0;
                 const v2 = alert.val;

                 const time0 = t0.time;
                 const time1 = t1.time;
                 const time2 = t2.time;

                 const actionVerb = v2 > v1 ? 'teve um aumento' : 'registrou uma variação';
                 trendText = `Às ${time0} ele consumiu ${formatKw(v0)} kWh e às ${time1} foi para ${formatKw(v1)} kWh e posteriormente ${actionVerb} às ${time2} para ${formatKw(v2)} kWh.`;
              }

              let diagnosticText = trendText
                  ? `Identificado pico crítico. ${trendText} O setor apresenta anomalia no perfil de carga (Média esperada: ${formatKw(alert.mean)} kWh, Limite: ${formatKw(alert.expectedMax)} kWh).`
                  : `Identificado pico crítico de consumo. O setor está operando com ${formatKw(alert.val)} kWh no intervalo de 15 minutos, caracterizando uma anomalia severa no perfil de carga.`;

              const normalSectors: {name: string, val: number}[] = [];
              for (const k of hospital.allSectors) {
                if (k !== alert.sectorKey && !alerts.some(a => a.sectorKey === k)) {
                  normalSectors.push({ name: k.replace(/_Quality|ME_CLIM_|DJ\d+_/, '').replace(/_/g, ' '), val: Number(lastRecord[k]) || 0 });
                }
                if (normalSectors.length >= 2) break;
              }

              if (normalSectors.length >= 2) {
                 diagnosticText += ` Em contraste, os setores ${normalSectors[0].name} (${formatKw(normalSectors[0].val)} kWh) e ${normalSectors[1].name} (${formatKw(normalSectors[1].val)} kWh) operam dentro da normalidade neste instante.`;
              }

              return (
                <div key={idx} className="chart-container border border-red-500/20 bg-red-950/10 relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>

                  <div className="flex flex-col md:flex-row gap-6">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-3">
                        <Bot className="w-5 h-5 text-red-400" />
                        <h4 className="font-medium text-red-400 text-lg">IA ALERTA: {alert.sectorName}</h4>
                      </div>

                      <div className="space-y-4 text-sm text-gray-300">
                        <div>
                          <span className="text-gray-500">Diagnóstico da IA:</span> {diagnosticText}
                        </div>
                        <div>
                          <span className="text-gray-500">Ação de Campo:</span> {actionText}
                        </div>

                        <div className="pt-2">
                          <button
                            onClick={() => handleNotify(alert.sectorKey + alert.time, alert)}
                            disabled={notifying[alert.sectorKey + alert.time] || notifyDisabled}
                            title={notifyDisabled ? 'Alertas automáticos deste hospital ainda não configurados' : undefined}
                            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-md border border-blue-500/30 transition-colors text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Send className="w-3 h-3" />
                            {notifying[alert.sectorKey + alert.time] ? 'Enviando Notificação...' : 'Notificar Equipe (WhatsApp/SMS)'}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="w-full md:w-64 flex flex-col gap-3 justify-center bg-[#111] p-4 rounded-md border border-[#222]">
                       <div>
                         <div className="text-gray-500 text-[10px] mb-1">CONSUMO ATUAL</div>
                         <div className="text-red-400 font-mono text-xl">{formatKw(alert.val)} kWh</div>
                       </div>
                       <div>
                         <div className="text-gray-500 text-[10px] mb-1">MÉDIA HISTÓRICA ({alert.band})</div>
                         <div className="text-gray-300 font-mono text-sm">{formatKw(alert.mean)} kWh</div>
                       </div>
                       <div>
                         <div className="text-gray-500 text-[10px] mb-1">
                           PADRÃO ESPERADO ({alert.representativeMetric === 'mean' ? 'média' : alert.representativeMetric === 'median' ? 'mediana' : 'moda'})
                         </div>
                         <div className="text-gray-300 font-mono text-sm">{formatKw(alert.centralValue)} kWh</div>
                       </div>
                       <div>
                         <div className="text-gray-500 text-[10px] mb-1">LIMITE DISPARO (padrão +{getAlertMarginPct()}%)</div>
                         <div className="text-gray-400 font-mono text-sm">{formatKw(alert.expectedMax)} kWh{alert.crossValidated ? ' · confirmado por 2 métricas' : ''}</div>
                       </div>
                       <div>
                         <div className="text-gray-500 text-[10px] mb-1">IMPACTO FINANCEIRO PROJETADO/MÊS</div>
                         <div className="text-amber-400 font-mono text-sm">
                           {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(alert.projecaoMensalBRL)}
                         </div>
                       </div>
                       {alert.frequenciaHistorica > 0 && (
                         <div>
                           <div className="text-gray-500 text-[10px] mb-1">OCORRÊNCIAS (30 DIAS)</div>
                           <div className="text-gray-400 font-mono text-sm">{alert.frequenciaHistorica}x neste setor/turno</div>
                         </div>
                       )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
