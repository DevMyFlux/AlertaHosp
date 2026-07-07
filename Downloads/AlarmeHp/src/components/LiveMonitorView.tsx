import React, { useMemo, useState } from 'react';
import { ProcessedTelemetryData, ALL_SECTORS } from '../types';
import { Bot, AlertTriangle, CheckCircle2, Activity, Send, Clock, RefreshCw, Database } from 'lucide-react';

interface Props {
  data: ProcessedTelemetryData[];
  lastUpdate: Date;
  onRefresh: () => void;
}

export function LiveMonitorView({ data, lastUpdate, onRefresh }: Props) {
  const [notifying, setNotifying] = useState<Record<string, boolean>>({});

  const handleNotify = async (alertId: string, sector: string, diagnostic: string, action: string) => {
    setNotifying(prev => ({ ...prev, [alertId]: true }));
    try {
      const phone = localStorage.getItem('notify_phone_number') || '5511943004579';
      const appId = localStorage.getItem('vonage_app_id');
      const privateKey = localStorage.getItem('vonage_private_key');
      const whatsappFrom = localStorage.getItem('vonage_whatsapp_from') || '556298792013';
      const message = `Diagnóstico: ${diagnostic}\n\nAção: ${action}`;
      const response = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sector, message, phone, appId, privateKey, whatsappFrom })
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
    } catch (e: any) {
      console.warn("Notification error:", e);
      alert(`Erro ao enviar notificação: ${e?.message || e}`);
    } finally {
      setNotifying(prev => ({ ...prev, [alertId]: false }));
    }
  };

  const { lastRecord, sectorStats, recentAlerts, totalPlant } = useMemo(() => {
    if (!data || data.length === 0) return { lastRecord: null, sectorStats: {}, recentAlerts: [], totalPlant: 0 };

    const last = data[data.length - 1];
    
    // We calculate standard deviation across the entire dataset to detect anomalies, just like DiagnosticsView
    const stats: Record<string, { avg: number, std: number }> = {};
    ALL_SECTORS.forEach(sec => {
      let sum = 0;
      let count = 0;
      data.forEach(d => {
        if (d[sec] !== undefined && typeof d[sec] === 'number') {
          sum += d[sec] as number;
          count++;
        }
      });
      const avg = count > 0 ? sum / count : 0;
      
      let varianceSum = 0;
      data.forEach(d => {
        if (d[sec] !== undefined && typeof d[sec] === 'number') {
          varianceSum += Math.pow((d[sec] as number) - avg, 2);
        }
      });
      const std = count > 0 ? Math.sqrt(varianceSum / count) : 0;
      
      stats[sec] = { avg, std };
    });

    const anomalies: any[] = [];
    ALL_SECTORS.forEach(sec => {
      const val = Number(last[sec]) || 0;
      const avg = stats[sec]?.avg || 0;
      const std = stats[sec]?.std || 0;
      const threshold = avg + (std * 2);

      if (val > threshold && val > 0.5) { // Minimum threshold 0.5
        anomalies.push({
          sectorKey: sec,
          sectorName: sec.replace(/_Quality|ME_CLIM_|DJ\d+_/, '').replace(/_/g, ' '),
          time: last.time,
          timestamp: last.timestamp,
          val,
          avg,
          std,
          threshold
        });
      }
    });

    // Sort by severity (deviation from threshold)
    anomalies.sort((a, b) => (b.val - b.threshold) - (a.val - a.threshold));

    const total = Number(last.Total_Consumption || 0);

    return { lastRecord: last, sectorStats: stats, recentAlerts: anomalies, totalPlant: total };
  }, [data]);

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
             <div className="text-2xl font-bold text-white font-mono">{ALL_SECTORS.length}</div>
           </div>
           <Database className="text-emerald-500/50 w-8 h-8" />
        </div>
        <div className="chart-container flex items-center justify-between col-span-1">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">ANOMALIAS ATIVAS (AGORA)</div>
             <div className={`text-2xl font-bold font-mono ${recentAlerts.length > 0 ? 'text-red-500' : 'text-green-500'}`}>{recentAlerts.length}</div>
           </div>
           {recentAlerts.length > 0 ? <AlertTriangle className="text-red-500/50 w-8 h-8" /> : <CheckCircle2 className="text-green-500/50 w-8 h-8" />}
        </div>
      </div>

      {recentAlerts.length === 0 ? (
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
            {recentAlerts.map((alert, idx) => {
              // Generate AI Diagnostic Text
              let actionText = "Contatar equipe de manutenção imediatamente.";
              if (alert.sectorKey.includes('CME') || alert.sectorKey.includes('UTI')) {
                actionText = "Contatar enfermaria/supervisão local para confirmar o uso extraordinário de equipamentos (suporte à vida). Não desarmar sem validação clínica.";
              } else if (alert.sectorKey.includes('CLIM') || alert.sectorKey.includes('HVAC')) {
                actionText = "Acionar equipe de facilities (Refrigeração). Verificar possível travamento de compressor ou falha no termostato.";
              } else if (alert.sectorKey.includes('RM') || alert.sectorKey.includes('Tomografia') || alert.sectorKey.includes('Radiologia')) {
                 actionText = "Acionar equipe de engenharia clínica. Verificar status do Chiller do equipamento e agendamento de exames em massa.";
              }
              
              // Get last 3 points
              const t0 = data.length >= 3 ? data[data.length - 3] : null;
              const t1 = data.length >= 2 ? data[data.length - 2] : null;
              const t2 = lastRecord;

              let trendText = "";
              if (t0 && t1 && t2) {
                 const v0 = Number(t0[alert.sectorKey as keyof typeof t0]) || 0;
                 const v1 = Number(t1[alert.sectorKey as keyof typeof t1]) || 0;
                 const v2 = alert.val;
                 
                 const time0 = t0.time;
                 const time1 = t1.time;
                 const time2 = t2.time;

                 const actionVerb = v2 > v1 ? 'teve um aumento' : 'registrou uma variação';
                 trendText = `Às ${time0} ele consumiu ${formatKw(v0)} kWh e às ${time1} foi para ${formatKw(v1)} kWh e posteriormente ${actionVerb} às ${time2} para ${formatKw(v2)} kWh.`;
              }
              
              let diagnosticText = trendText 
                  ? `Identificado pico crítico. ${trendText} O setor apresenta anomalia no perfil de carga (Média esperada: ${formatKw(alert.avg)} kWh, Limite: ${formatKw(alert.threshold)} kWh).`
                  : `Identificado pico crítico de consumo. O setor está operando com ${formatKw(alert.val)} kWh no intervalo de 15 minutos, caracterizando uma anomalia severa no perfil de carga.`;
              
              const allKeys = ALL_SECTORS;
              const normalSectors: {name: string, val: number}[] = [];
              for (const k of allKeys) {
                if (k !== alert.sectorKey && !recentAlerts.some(a => a.sectorKey === k)) {
                  normalSectors.push({ name: k.replace(/_Quality|ME_CLIM_|DJ\d+_/, '').replace(/_/g, ' '), val: Number(lastRecord[k as keyof typeof lastRecord]) || 0 });
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
                            onClick={() => handleNotify(alert.sectorKey + alert.time, alert.sectorName, diagnosticText, actionText)}
                            disabled={notifying[alert.sectorKey + alert.time]}
                            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-md border border-blue-500/30 transition-colors text-xs font-medium"
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
                         <div className="text-gray-500 text-[10px] mb-1">MÉDIA HISTÓRICA</div>
                         <div className="text-gray-300 font-mono text-sm">{formatKw(alert.avg)} kWh</div>
                       </div>
                       <div>
                         <div className="text-gray-500 text-[10px] mb-1">LIMITE DISPARO (2σ)</div>
                         <div className="text-gray-400 font-mono text-sm">{formatKw(alert.threshold)} kWh</div>
                       </div>
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
