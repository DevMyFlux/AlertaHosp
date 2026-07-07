import React, { useMemo, useState } from 'react';
import { ProcessedTelemetryData, ALL_SECTORS } from '../types';
import { Bot, AlertTriangle, CheckCircle2, Activity, Send } from 'lucide-react';

interface Props {
  data: ProcessedTelemetryData[];
}

type TimeBand = 'Café da Manhã (07-10h)' | 'Almoço (10-14h)' | 'Jantar (18-22h)' | 'Demais Horários';

function getBand(hour: number): TimeBand {
  if (hour >= 7 && hour < 10) return 'Café da Manhã (07-10h)';
  if (hour >= 10 && hour < 14) return 'Almoço (10-14h)';
  if (hour >= 18 && hour < 22) return 'Jantar (18-22h)';
  return 'Demais Horários';
}

const SECTOR_MAPPING: Record<string, { label: string; sub?: string; type: string }> = {
  'DJ1_Lavanderia': { label: 'Lavanderia', sub: 'ME_CLIM_LAVANDERIA', type: 'Infra' },
  'DJ7_Oncologia': { label: 'Oncologia', sub: 'ME_CLIM_ONC_A_T', type: 'Crítico' },
  'DJ13_Laboratorio': { label: 'Laboratório', sub: 'ME_CLIM_LABORATORIO', type: 'Crítico' },
  'DJ40_Refeitorio': { label: 'Refeitório', sub: 'ME_CLIM_REF', type: 'Infra' },
  'DJ50_CME': { label: 'CME', sub: 'ME_CLIM_CC_CO_CME', type: 'Crítico' },
  'SADT': { label: 'SADT', type: 'Crítico' },
  'ME_UTI_QG_E3': { label: 'UTI QG', sub: 'ME_CLIM_UTI', type: 'Crítico' },
  'ME_UTI_QD_IT': { label: 'UTI QD IT', sub: 'ME_CLIM_UTI', type: 'Crítico' },
  'DJ14_Radiologia': { label: 'Radiologia', type: 'Imagem' },
  'DJ60_RM': { label: 'Ressonância', type: 'Imagem' },
  'DJ61_Tomografia': { label: 'Tomografia', type: 'Imagem' },
  'DJ58_RX1': { label: 'Raios-X 1', type: 'Imagem' },
  'DJ59_RX2': { label: 'Raios-X 2', type: 'Imagem' }
};

export function DiagnosticsView({ data }: Props) {
  const [hoursToAnalyze, setHoursToAnalyze] = useState(12);
  const [notifying, setNotifying] = useState<Record<string, boolean>>({});

  const handleNotify = async (alertId: string, sector: string, diagnostic: string, action: string) => {
    setNotifying(prev => ({ ...prev, [alertId]: true }));
    try {
      const phone = localStorage.getItem('notify_phone_number') || '5511949102183';
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

  const { sectorStats, alerts } = useMemo(() => {
    if (!data.length) return { sectorStats: {}, alerts: [] };

    // 1. Calculate historical behavior for ALL_SECTORS per band
    const histData: Record<string, Record<TimeBand, number[]>> = {};
    ALL_SECTORS.forEach(sec => {
      histData[sec] = {
        'Café da Manhã (07-10h)': [],
        'Almoço (10-14h)': [],
        'Jantar (18-22h)': [],
        'Demais Horários': [],
      };
    });

    data.forEach(row => {
      const band = getBand(row.hour);
      ALL_SECTORS.forEach(sec => {
        const val = Number(row[sec]);
        if (!isNaN(val) && val > 0) {
          histData[sec][band].push(val);
        }
      });
    });

    const calcStats = (vals: number[]) => {
      if (!vals.length) return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };
      const sorted = [...vals].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const mean = sum / sorted.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      const variance = sorted.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sorted.length;
      const stdDev = Math.sqrt(variance);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      return { mean, median, stdDev, min, max };
    };

    const sStats: Record<string, Record<TimeBand, any>> = {};
    ALL_SECTORS.forEach(sec => {
      sStats[sec] = {} as any;
      (Object.keys(histData[sec]) as TimeBand[]).forEach(band => {
        sStats[sec][band] = calcStats(histData[sec][band]);
      });
    });

    // 2. Look at the last N elements
    const readingsPerHour = 4; // 15 min intervals
    const elementsToAnalyze = hoursToAnalyze * readingsPerHour;
    const recentData = data.slice(-elementsToAnalyze);

    const activeAlerts: any[] = [];

    recentData.forEach(row => {
      const band = getBand(row.hour);
      const dateStr = row.timestamp.split(/[T ]/)[0];

      Object.keys(SECTOR_MAPPING).forEach(sec => {
        const actualKey = ALL_SECTORS.find(k => k.includes(sec)) || sec;
        const val = Number(row[actualKey]);
        const s = sStats[actualKey]?.[band];
        
        if (!s || s.mean === 0) return;

        const upperLimit = s.mean + (1.5 * s.stdDev);
        
        if (val > upperLimit && val > 5) {
          const deviation = ((val - upperLimit) / upperLimit) * 100;
          if (deviation > 10) { 
            let severity = 'Moderado';
            if (deviation > 50) severity = 'Crítico';
            else if (deviation > 20) severity = 'Alto';

            const mapInfo = SECTOR_MAPPING[sec];
            let subVal = 0;
            let subMedian = 1;
            let actualSubKey = '';
            
            if (mapInfo.sub) {
              actualSubKey = ALL_SECTORS.find(k => k.includes(mapInfo.sub!)) || mapInfo.sub;
              subVal = Number(row[actualSubKey]) || 0;
              subMedian = sStats[actualSubKey]?.[band]?.median || 1;
            }

            activeAlerts.push({
              date: dateStr,
              time: row.time,
              band,
              sectorName: mapInfo.label,
              sectorKey: actualKey,
              type: mapInfo.type,
              val,
              expectedMax: upperLimit,
              deviation,
              severity,
              subVal,
              subMedian,
              subName: actualSubKey,
            });
          }
        }
      });
    });

    // Reverse sort by severity/deviation and limit to top 15 so it's not overwhelming
    activeAlerts.sort((a, b) => b.deviation - a.deviation);
    return { sectorStats: sStats, alerts: activeAlerts.slice(0, 15) };
  }, [data, hoursToAnalyze]);

  if (!data.length || !sectorStats) return null;

  const formatKw = (val: number) => Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(val);

  const lastDate = data.length > 0 ? data[data.length - 1].timestamp.split(/[T ]/)[0] : '';

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      
      {/* Header Panel */}
      <div className="chart-container flex flex-col md:flex-row items-start md:items-center justify-between bg-blue-950/20 border-blue-500/30 gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-blue-500/10 rounded-lg">
            <Bot className="w-8 h-8 text-[var(--accent-blue)]" />
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight" style={{color: 'var(--accent-blue)'}}>MyFlux AI Diagnostics</h2>
            <p className="text-sm text-gray-400 mt-1">Análise preditiva de anomalias com base em médias históricas e desvio padrão.</p>
          </div>
        </div>
        <div className="filter-group flex items-center bg-[#18181b] p-2 rounded-md border border-[#333]">
          <Activity className="w-4 h-4 text-gray-400 mr-2" />
          <label className="text-xs text-gray-400 mr-3">Escopo de Análise:</label>
          <select 
            className="bg-transparent text-sm text-white outline-none border-none cursor-pointer" 
            value={hoursToAnalyze} 
            onChange={(e) => setHoursToAnalyze(Number(e.target.value))}
          >
            <option value={3}>Últimas 3 Horas</option>
            <option value={6}>Últimas 6 Horas</option>
            <option value={12}>Últimas 12 Horas</option>
            <option value={24}>Últimas 24 Horas</option>
            <option value={168}>Última Semana</option>
            <option value={720}>Último Mês</option>
            <option value={999999}>Todo o Período</option>
          </select>
        </div>
      </div>

      {/* Alertas Ativos */}
      <div className="chart-container">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          <h3 className="font-semibold text-lg text-gray-200">
            Alertas Ativos Detectados {hoursToAnalyze < 999999 ? `(Últimas ${hoursToAnalyze}h${lastDate ? ` - ${lastDate}` : ''})` : '(Todo o Período)'}
          </h3>
        </div>
        
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-green-500 border border-green-500/20 bg-green-500/5 rounded-lg">
            <CheckCircle2 className="w-12 h-12 mb-3 opacity-80" />
            <p className="text-lg font-medium">Nenhuma anomalia detectada</p>
            <p className="text-sm opacity-70">Operação dentro da normalidade estatística no período selecionado.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#333]">
            <table className="w-full text-left text-sm text-gray-400">
              <thead className="text-xs text-gray-300 uppercase bg-[#18181b] border-b border-[#333]">
                <tr>
                  <th className="px-4 py-3">Horário</th>
                  <th className="px-4 py-3">Setor</th>
                  <th className="px-4 py-3">Turno</th>
                  <th className="px-4 py-3">Consumo</th>
                  <th className="px-4 py-3">Lim. Estatístico</th>
                  <th className="px-4 py-3">Desvio</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((al, idx) => (
                  <tr key={idx} className="border-b border-[#222] bg-[#1d1d24] hover:bg-[#252530] transition-colors">
                    <td className="px-4 py-3 font-mono">{al.time}</td>
                    <td className="px-4 py-3 font-medium text-gray-200">{al.sectorName}</td>
                    <td className="px-4 py-3 text-xs">{al.band}</td>
                    <td className="px-4 py-3 font-mono text-amber-400">{formatKw(al.val)} kWh</td>
                    <td className="px-4 py-3 font-mono">{formatKw(al.expectedMax)} kWh</td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-bold text-amber-400 bg-amber-400/10 px-2 py-1 rounded">
                        +{formatKw(al.deviation)}%
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full border ${
                        al.severity === 'Crítico' ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                        al.severity === 'Alto' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' :
                        'bg-blue-500/10 border-blue-500/30 text-blue-400'
                      }`}>
                        {al.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Diagnóstico detalhado estilo Relatório IA e Sugestões de Prompts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {alerts.length > 0 ? (
          <div className="chart-container flex flex-col bg-[#0a0a0c] border border-blue-900/30">
            <div className="flex items-center gap-2 mb-4 border-b border-[#222] pb-3">
              <Bot className="w-5 h-5 text-blue-400" />
              <h3 className="font-semibold text-lg text-gray-200">Relatório de Diagnóstico da IA</h3>
            </div>
            
            <div className="space-y-6 flex-1 max-h-[600px] overflow-y-auto custom-scrollbar text-sm font-mono leading-relaxed text-gray-300 pr-2">
              {alerts.slice(0, 3).map((mainAlert, idx) => {
                const rowIndex = data.findIndex(r => r.timestamp.includes(mainAlert.time) && r.timestamp.includes(mainAlert.date));
                const rowData = rowIndex >= 0 ? data[rowIndex] : undefined;
                let totalPlant = 0;
                const normalSectors: {name: string, val: number}[] = [];
                
                let trendText = "";
                if (rowIndex >= 2) {
                   const t0 = data[rowIndex - 2];
                   const t1 = data[rowIndex - 1];
                   const t2 = data[rowIndex];
                   
                   const v0 = Number(t0[mainAlert.sectorKey as keyof typeof t0]) || 0;
                   const v1 = Number(t1[mainAlert.sectorKey as keyof typeof t1]) || 0;
                   const v2 = mainAlert.val;
                   
                   const time0 = t0.time;
                   const time1 = t1.time;
                   const time2 = t2.time;

                   const actionVerb = v2 > v1 ? 'teve um aumento' : 'registrou uma variação';
                   trendText = `Às ${time0} ele consumiu ${formatKw(v0)} kWh e às ${time1} foi para ${formatKw(v1)} kWh e posteriormente ${actionVerb} às ${time2} para ${formatKw(v2)} kWh.`;
                }

                if (rowData) {
                  totalPlant = Number(rowData.Total_Consumption || 0);
                  
                  // Find a couple of normal sectors
                  const allKeys = ALL_SECTORS;
                  for (const k of allKeys) {
                    if (k !== mainAlert.sectorKey && !alerts.some(a => a.sectorKey === k && a.time === mainAlert.time)) {
                      normalSectors.push({ name: k, val: Number(rowData[k as keyof typeof rowData]) || 0 });
                    }
                    if (normalSectors.length >= 2) break;
                  }
                }

                // Filter other alerts that happened at the SAME time
                const concurrentAlerts = alerts.filter(a => a.time === mainAlert.time && a.sectorKey !== mainAlert.sectorKey);

                const isClimaHigh = mainAlert.subName ? mainAlert.subVal > (mainAlert.subMedian * 1.3) : false;

                let diagnosticText = trendText 
                    ? `Identificado pico de consumo. ${trendText} O que representa um desvio de +${formatKw(mainAlert.deviation)}% em relação à média esperada.`
                    : `Identificado pico de consumo. O setor está operando com ${formatKw(mainAlert.val)} kWh no intervalo de 15 minutos, o que representa um desvio de +${formatKw(mainAlert.deviation)}% em relação à média esperada.`;
                
                if (mainAlert.val > 5) {
                   diagnosticText = trendText 
                      ? `Identificado pico crítico de consumo. ${trendText}` 
                      : `Identificado pico crítico de consumo. O setor está operando com ${formatKw(mainAlert.val)} kWh no intervalo de 15 minutos`;
                   
                   // Check if it's the highest in the row
                   if (rowData) {
                      const maxVal = Math.max(...ALL_SECTORS.map(k => Number(rowData[k as keyof typeof rowData]) || 0));
                        
                      if (mainAlert.val >= maxVal) {
                         diagnosticText += ` (representa o maior consumo registrado na planta no momento).`;
                      } else {
                         diagnosticText += `, caracterizando uma anomalia severa no perfil de carga.`;
                      }
                   } else {
                      diagnosticText += `, caracterizando uma anomalia severa no perfil de carga.`;
                   }
                }
                if (isClimaHigh) {
                   diagnosticText += ` O sistema de climatização é o principal responsável, correspondendo a ${(mainAlert.subVal / mainAlert.val * 100).toFixed(0)}% da carga.`;
                }

                let actionText = 'Averiguar maquinário pesado, fornos, estufas ou iluminação não essencial deixados ligados.';
                if (mainAlert.type === 'Imagem') actionText = 'Checar se os equipamentos de grande porte do setor estão operando simultaneamente ou fora do horário planejado. Verificar possíveis falhas técnicas ou fugas de corrente no Chiller/RM.';
                else if (mainAlert.type === 'Crítico') actionText = 'Contatar enfermaria/supervisão local para confirmar o uso extraordinário de equipamentos (suporte à vida). Não desarmar sem validação clínica.';
                else if (isClimaHigh) actionText = 'Verificar limpeza de filtros e setpoint do termostato. Possível congelamento ou sobrecarga do compressor de HVAC local.';

                return (
                  <div key={idx} className="p-5 border border-red-900/30 rounded-lg bg-[#111] relative overflow-hidden mb-6">
                    <div className="absolute top-0 left-0 w-1 h-full bg-red-600"></div>
                    
                    <div className="text-red-400 font-bold mb-4 text-base">
                      🚨 ALERTA DE ANOMALIA - {mainAlert.sectorName.toUpperCase()}
                    </div>
                    
                    <div className="space-y-4">
                      <div>
                        <span className="text-gray-500">Ocorrência:</span> {mainAlert.date} às {mainAlert.time}
                      </div>
                      
                      <div>
                        <span className="text-gray-500">Diagnóstico da IA:</span> {diagnosticText}
                      </div>
                      
                      <div>
                        <span className="text-gray-500">Ação de Campo:</span> {actionText}
                      </div>

                      <div className="pt-2">
                        <button 
                          onClick={() => handleNotify(mainAlert.sectorKey + mainAlert.time, mainAlert.sectorName, diagnosticText, actionText)}
                          disabled={notifying[mainAlert.sectorKey + mainAlert.time]}
                          className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-md border border-blue-500/30 transition-colors text-xs font-medium"
                        >
                          <Send className="w-3 h-3" />
                          {notifying[mainAlert.sectorKey + mainAlert.time] ? 'Enviando Notificação...' : 'Notificar Equipe (WhatsApp/SMS)'}
                        </button>
                      </div>
                      
                      {concurrentAlerts.length > 0 && (
                        <div className="pt-4 border-t border-[#222]">
                          <div className="text-gray-400 mb-2">Resumo de Outros Alertas e Consumos ({mainAlert.time}):</div>
                          <p className="text-gray-500 mb-2">Além do setor {mainAlert.sectorName}, outros setores apresentaram consumos elevados que merecem atenção:</p>
                          <ul className="list-disc list-inside space-y-1 ml-2 text-amber-200/70">
                            {concurrentAlerts.slice(0, 4).map((ca, cIdx) => {
                               let reason = 'Anomalia detectada';
                               if (ca.subName && ca.subVal > (ca.subMedian * 1.3)) reason = 'Pico de climatização';
                               else if (ca.severity === 'Alto') reason = 'Consumo elevado, próximo ao limite crítico';
                               
                               return (
                                 <li key={cIdx}>{ca.sectorKey}: {formatKw(ca.val)} kWh ({reason})</li>
                               );
                            })}
                          </ul>
                        </div>
                      )}
                      
                      {totalPlant > 0 && (
                        <div className="pt-2">
                          <span className="text-gray-500">Consumo Total da Planta (Últimos 15 min):</span> {formatKw(totalPlant)} kWh.
                        </div>
                      )}
                      
                      {normalSectors.length > 0 && (
                        <div className="pt-2 text-green-400/70">
                          Os setores {normalSectors.map(s => `${s.name} (${formatKw(s.val)} kWh)`).join(' e ')} operam dentro da normalidade esperada para este horário.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="chart-container flex flex-col justify-center items-center bg-[#0a0a0c] border border-[#222]">
            <CheckCircle2 className="w-12 h-12 mb-3 text-green-500/50" />
            <p className="text-gray-400 text-sm">Aguardando eventos para gerar relatório de diagnóstico...</p>
          </div>
        )}

        {/* Sugestões de Prompts */}
        <div className="chart-container flex flex-col bg-[#111] border border-[#333]">
          <div className="flex items-center gap-2 mb-4 border-b border-[#222] pb-3">
            <Activity className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold text-lg text-gray-200">Interaja com a IA (Sugestões de Prompts)</h3>
          </div>
          
          <div className="space-y-4 flex-1 max-h-[600px] overflow-y-auto custom-scrollbar text-sm text-gray-300 pr-2">
            <p className="text-xs text-gray-500 mb-2">Com base nos dados disponíveis nas tabelas de telemetria, você pode solicitar as seguintes análises avançadas:</p>
            
            <div className="p-3 border border-purple-900/30 rounded-lg bg-purple-900/10">
              <h4 className="font-semibold text-purple-300 mb-2 text-xs uppercase tracking-wider">1. Análise de Tendências e Gráficos</h4>
              <ul className="space-y-2 list-disc list-inside text-gray-400 text-xs">
                <li><span className="text-gray-300 italic">"Crie um gráfico de linha mostrando a evolução do consumo de energia dos setores DJ1_Lavanderia e DJ7_Oncologia ao longo do tempo usando os dados da Sheet1."</span></li>
                <li><span className="text-gray-300 italic">"Gere um gráfico de barras comparando o Consumo Total de todos os medidores listados na tabela 'Resumo_2026_06_15'."</span></li>
              </ul>
            </div>

            <div className="p-3 border border-purple-900/30 rounded-lg bg-purple-900/10">
              <h4 className="font-semibold text-purple-300 mb-2 text-xs uppercase tracking-wider">2. Identificação de Picos e Médias</h4>
              <ul className="space-y-2 list-disc list-inside text-gray-400 text-xs">
                <li><span className="text-gray-300 italic">"Qual foi o horário de maior consumo total registrado na Sheet1 e quais setores mais contribuíram para esse pico?"</span></li>
                <li><span className="text-gray-300 italic">"Calcule a média de consumo por hora do dia para o setor DJ40_Refeitorio para entender o perfil de uso."</span></li>
              </ul>
            </div>

            <div className="p-3 border border-purple-900/30 rounded-lg bg-purple-900/10">
              <h4 className="font-semibold text-purple-300 mb-2 text-xs uppercase tracking-wider">3. Comparação com Metas (Setpoints)</h4>
              <ul className="space-y-2 list-disc list-inside text-gray-400 text-xs">
                <li><span className="text-gray-300 italic">"Compare os valores de consumo da Sheet1 com os limites definidos na tabela Calc_Setpoints. Algum setor ultrapassou a meta de 2,5 em algum período?"</span></li>
                <li><span className="text-gray-300 italic">"Crie um resumo mostrando quais setores estão operando acima ou abaixo da média esperada conforme as definições de períodos (Madrugada, Café, Almoço, Noite)."</span></li>
              </ul>
            </div>

            <div className="p-3 border border-purple-900/30 rounded-lg bg-purple-900/10">
              <h4 className="font-semibold text-purple-300 mb-2 text-xs uppercase tracking-wider">4. Resumo Executivo</h4>
              <ul className="space-y-2 list-disc list-inside text-gray-400 text-xs">
                <li><span className="text-gray-300 italic">"Faça um diagnóstico geral dos dados: quais são os 3 setores que mais consomem energia e qual a variação percentual entre o consumo máximo e mínimo de cada um?"</span></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


