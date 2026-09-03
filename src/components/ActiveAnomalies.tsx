import React, { useMemo, useState } from 'react';
import { ProcessedTelemetryData } from '../types';
import { buildSectorBandStats, detectSectorAnomalies, SectorAnomaly } from '../lib/anomalyDetection';
import { AlertTriangle, Clock } from 'lucide-react';
import { useHospital } from '../config/HospitalContext';

interface Props {
  data: ProcessedTelemetryData[];
}

const severityWeight: Record<string, number> = {
  'Crítico': 3,
  'Alto': 2,
  'Moderado': 1,
};

export function ActiveAnomalies({ data }: Props) {
  const { hospital } = useHospital();
  const [hoursToAnalyze, setHoursToAnalyze] = useState(12);

  const alerts = useMemo(() => {
    if (!data.length) return [];

    // Mesma base estatística usada no Monitoramento 15m e no AI Diagnostics
    // (média/mediana/moda auto-selecionada por setor+turno, ver
    // src/lib/anomalyDetection.ts e src/lib/statistics.ts). Até a Etapa 1
    // desta refatoração, a Visão Executiva calculava sua própria estatística
    // à parte (média + 2σ por hora cheia), o que fazia esta tela divergir
    // das demais para o mesmo instante — era uma das três implementações
    // duplicadas encontradas no sistema (as outras eram anomalyDetection.ts
    // e ImagingView.tsx). Unificado aqui.
    const sStats = buildSectorBandStats(data, hospital.allSectors);

    const readingsPerHour = 4;
    const elementsToAnalyze = hoursToAnalyze * readingsPerHour;
    const recentData = data.slice(-elementsToAnalyze);
    const offset = data.length - recentData.length;

    const activeAlerts: SectorAnomaly[] = [];
    recentData.forEach((row, i) => {
      const absoluteIndex = offset + i;
      // Últimas leituras até este ponto — usadas pro cálculo de tendência
      // (Etapa 5), sem olhar pro futuro em relação à linha analisada.
      const trendSlice = data.slice(Math.max(0, absoluteIndex - 7), absoluteIndex + 1);
      activeAlerts.push(...detectSectorAnomalies(row, sStats, trendSlice, undefined, hospital.sectorMapping, hospital.allSectors));
    });

    activeAlerts.sort((a, b) => {
      if (severityWeight[b.severity] !== severityWeight[a.severity]) {
        return severityWeight[b.severity] - severityWeight[a.severity];
      }
      return b.deviation - a.deviation;
    });

    // Mantém só as 8 anomalias mais prioritárias
    return activeAlerts.slice(0, 8);
  }, [data, hoursToAnalyze, hospital.id]);

  const lastDate = data.length > 0 ? data[data.length - 1].timestamp.split(/[T ]/)[0] : '';
  const fmt = (v: number) => Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(v);

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
          Operação normal em todos os setores (dentro do padrão esperado por setor/turno).
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
                Pico anormal no perfil estatístico do turno <span className="text-white">{al.band}</span>.
              </div>
              <div className="mt-1 flex gap-4 text-gray-400">
                <div>Medido: <span className="text-red-400 font-bold">{fmt(al.val)} kWh</span></div>
                <div>Padrão esperado: <span>{fmt(al.centralValue)} kWh</span></div>
                <div className="text-red-400">(+{fmt(al.deviation)}%)</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
