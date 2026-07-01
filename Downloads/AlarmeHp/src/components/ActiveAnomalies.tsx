import React, { useMemo, useState } from 'react';
import { ProcessedTelemetryData, ALL_SECTORS } from '../types';
import { AlertTriangle, Clock } from 'lucide-react';

interface Props {
  data: ProcessedTelemetryData[];
}

export function ActiveAnomalies({ data }: Props) {
  const [hoursToAnalyze, setHoursToAnalyze] = useState(12);

  const alerts = useMemo(() => {
    if (!data.length) return [];

    // 1. Calculate statistical thresholds for all sectors and hours based on past data
    const histData: Record<string, Record<number, number[]>> = {};
    ALL_SECTORS.forEach(sec => {
      histData[sec] = {};
      for (let i = 0; i < 24; i++) {
        histData[sec][i] = [];
      }
    });

    data.forEach(row => {
      const hour = row.hour;
      ALL_SECTORS.forEach(sec => {
        const val = Number(row[sec]);
        if (!isNaN(val) && val > 0) {
          histData[sec][hour].push(val);
        }
      });
    });

    const sStats: Record<string, Record<number, any>> = {};
    ALL_SECTORS.forEach(sec => {
      sStats[sec] = {};
      for (let i = 0; i < 24; i++) {
        const vals = histData[sec][i];
        if (!vals.length) {
          sStats[sec][i] = { mean: 0, stdDev: 0 };
          continue;
        }
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
        const stdDev = Math.sqrt(variance);
        sStats[sec][i] = { mean, stdDev };
      }
    });

    // 2. Scan the recent data points
    const readingsPerHour = 4;
    const elementsToAnalyze = hoursToAnalyze * readingsPerHour;
    const recentData = data.slice(-elementsToAnalyze);

    const activeAlerts: any[] = [];

    recentData.forEach(row => {
      const hour = row.hour;
      const dateStr = row.timestamp.split(/[T ]/)[0];

      ALL_SECTORS.forEach(sec => {
        const val = Number(row[sec]);
        const s = sStats[sec]?.[hour];
        
        if (!s || s.mean === 0) return;

        // Threshold = Mean + 2 Standard Deviations
        const upperLimit = s.mean + (2 * s.stdDev);

        if (val > upperLimit && val > 5) { // ignoring small fluctuations below 5kWh
          const deviation = ((val - upperLimit) / upperLimit) * 100;
          if (deviation > 5) { // Any deviation above 2 std deviations
            let severity = 'Moderado';
            if (deviation > 50) severity = 'Crítico';
            else if (deviation > 25) severity = 'Alto';

            activeAlerts.push({
              date: dateStr,
              time: row.time,
              hour,
              sectorName: sec.replace('DJ', '').replace('ME_CLIM_', '').replace(/_/g, ' '),
              val,
              expectedMax: upperLimit,
              deviation,
              severity
            });
          }
        }
      });
    });

    // Sort by severity (Critico -> Alto -> Moderado) and then deviation
    const severityWeight: Record<string, number> = {
      'Crítico': 3,
      'Alto': 2,
      'Moderado': 1
    };

    activeAlerts.sort((a, b) => {
      if (severityWeight[b.severity] !== severityWeight[a.severity]) {
        return severityWeight[b.severity] - severityWeight[a.severity];
      }
      return b.deviation - a.deviation;
    });

    // Keep only top 8 priority anomalies
    return activeAlerts.slice(0, 8);
  }, [data, hoursToAnalyze]);

  const lastDate = data.length > 0 ? data[data.length - 1].timestamp.split(/[T ]/)[0] : '';

  if (!alerts.length) {
    return (
      <div className="chart-container flex flex-col border border-green-500/20 bg-green-950/10">
      <div className="chart-title flex items-center justify-between text-green-400">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          Nenhuma anomalia detectada {hoursToAnalyze < 999999 ? `(Últimas ${hoursToAnalyze}h${lastDate ? ` - ${lastDate}` : ''})` : '(Todo o Período)'}
        </div>
        <select 
          className="bg-[#222] text-xs text-white border border-[#444] rounded px-1 py-0.5 outline-none" 
          value={hoursToAnalyze} 
          onChange={(e) => setHoursToAnalyze(Number(e.target.value))}
        >
          <option value={12}>12 Horas</option>
          <option value={24}>24 Horas</option>
          <option value={168}>7 Dias</option>
          <option value={999999}>Todos</option>
        </select>
      </div>
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          Operação normal em todos os setores (abaixo de 2 desvios padrão).
        </div>
      </div>
    );
  }

  return (
    <div className="chart-container flex flex-col border border-red-500/20 bg-red-950/10">
      <div className="chart-title flex items-center justify-between text-red-400">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          Anomalias Ativas Detectadas {hoursToAnalyze < 999999 ? `(Últimas ${hoursToAnalyze}h${lastDate ? ` - ${lastDate}` : ''})` : '(Todo o Período)'}
        </div>
        <select 
          className="bg-[#222] text-xs text-white border border-[#444] rounded px-1 py-0.5 outline-none" 
          value={hoursToAnalyze} 
          onChange={(e) => setHoursToAnalyze(Number(e.target.value))}
        >
          <option value={12}>12 Horas</option>
          <option value={24}>24 Horas</option>
          <option value={168}>7 Dias</option>
          <option value={999999}>Todos</option>
        </select>
      </div>
      
      <div className="flex-1 overflow-y-auto max-h-72 mt-2">
        <div className="space-y-2">
          {alerts.map((al, idx) => (
            <div key={idx} className="p-3 bg-red-900/10 border border-red-500/10 rounded-md text-[11px] font-mono hover:bg-red-900/20 transition-colors">
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-red-300">
                  {al.sectorName.toUpperCase()} 
                  <span className={`ml-2 px-1 rounded text-[9px] uppercase ${
                    al.severity === 'Crítico' ? 'bg-red-500/20 text-red-500 border border-red-500/30' :
                    al.severity === 'Alto' ? 'bg-orange-500/20 text-orange-500 border border-orange-500/30' :
                    'bg-yellow-500/20 text-yellow-500 border border-yellow-500/30'
                  }`}>{al.severity}</span>
                </span>
                <span className="flex items-center gap-1 text-gray-400">
                  <Clock className="w-3 h-3" />
                  {al.date} às {al.time}
                </span>
              </div>
              <div className="text-gray-300">
                Pico anormal no perfil estatístico das <span className="text-white">{al.hour}h às {al.hour + 1}h</span>.
              </div>
              <div className="mt-1 flex gap-4 text-gray-400">
                <div>Medido: <span className="text-red-400 font-bold">{Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(al.val)} kWh</span></div>
                <div>Limite Sup (+2σ): <span>{Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(al.expectedMax)} kWh</span></div>
                <div className="text-red-400">(+{Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(al.deviation)}%)</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

