import React from 'react';
import { ProcessedTelemetryData } from '../types';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { Activity, Zap, ShieldAlert, Cpu } from 'lucide-react';
import { ActiveAnomalies } from './ActiveAnomalies';
import { useHospital } from '../config/HospitalContext';

interface Props {
  data: ProcessedTelemetryData[];
}

export function ExecutiveView({ data }: Props) {
  const { hospital } = useHospital();
  if (data.length === 0) return null;

  // KPIs
  const totalConsumption = data.reduce((acc, row) => acc + (Number(row.Total_Consumption) || 0), 0);
  const maxDemandRow = [...data].sort((a, b) => (Number(b.Total_Consumption) || 0) - (Number(a.Total_Consumption) || 0))[0];
  const maxDemand = maxDemandRow ? Number(maxDemandRow.Total_Consumption) || 0 : 0;
  const maxDemandTime = maxDemandRow ? maxDemandRow.time : '--:--';
  const avgHourly = totalConsumption / 24; // Approximation based on 24hr data
  
  const avgIntegrity = data.length > 0 ? data.reduce((acc, row) => acc + (Number(row.Data_Integrity) || 0), 0) / data.length : 0;

  // Pareto Chart Data (Top Consumers)
  const sectorConsumption: Record<string, number> = {};
  data.forEach(row => {
    hospital.allSectors.forEach(sector => {
      sectorConsumption[sector] = (sectorConsumption[sector] || 0) + (row[sector] as number);
    });
  });

  const paretoData = Object.keys(sectorConsumption)
    .map(key => ({ name: key.replace('DJ', '').replace('ME_CLIM_', ''), value: sectorConsumption[key] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10); // Top 10

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="kpi-card">
          <div className="kpi-label">Consumo Total (kWh)</div>
          <div className="kpi-value white">{Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(totalConsumption)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pico de Demanda (15m)</div>
          <div className="kpi-value amber">{Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(maxDemand)} <span style={{fontSize: '11px', fontWeight: 'normal', color: '#888'}}>às {maxDemandTime}</span></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Média por Hora (kWh)</div>
          <div className="kpi-value blue">{Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(avgHourly)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Integridade da Rede</div>
          <div className={avgIntegrity > 0.98 ? "kpi-value green" : "kpi-value amber"}>{(avgIntegrity * 100).toFixed(2)}%</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Main Line Chart */}
        <div className="chart-container lg:col-span-2">
          <div className="chart-title">Evolução do Consumo Total vs Pico</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="time" stroke="#888" tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} />
                <YAxis 
                  stroke="#888" 
                  tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} 
                  tickFormatter={(val) => Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(val)}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--line)', borderRadius: '4px', color: 'var(--ink)' }}
                  itemStyle={{ color: 'var(--accent-blue)' }}
                  formatter={(value: number) => [Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value) + ' kWh', 'Consumo Total']}
                  labelFormatter={(label) => `Horário: ${label}`}
                />
                <Line type="step" dataKey="Total_Consumption" name="Consumo Total" stroke="var(--accent-blue)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Active Anomalies (Self-calculating urgency widget) */}
        <ActiveAnomalies data={data} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pareto / Top Consumers */}
        <div className="chart-container">
          <div className="chart-title">Top 10 Consumidores (Pareto)</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={paretoData} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={true} vertical={false} />
                <XAxis 
                  type="number" 
                  stroke="#888" 
                  tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} 
                  tickFormatter={(val) => Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(val)}
                />
                <YAxis dataKey="name" type="category" stroke="#888" tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} width={100} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--line)', borderRadius: '4px', color: 'var(--ink)' }}
                  cursor={{fill: 'rgba(255,255,255,0.05)'}}
                  formatter={(value: number) => [Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value) + ' kWh', 'Consumo']}
                />
                <Bar dataKey="value" name="Consumo (kWh)" fill="var(--accent-green)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
