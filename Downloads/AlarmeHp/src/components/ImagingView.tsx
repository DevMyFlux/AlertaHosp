import React, { useMemo } from 'react';
import { ProcessedTelemetryData, SECTORS } from '../types';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { AlertTriangle } from 'lucide-react';

interface Props {
  data: ProcessedTelemetryData[];
}

const IMAGING_COLORS = {
  'DJ14_Radiologia': '#3B82F6', // Blue
  'DJ60_RM': '#F59E0B',         // Amber
  'DJ61_Tomografia': '#10B981', // Emerald
  'DJ58_RX1': '#8B5CF6',
  'DJ59_RX2': '#EC4899',
};

export function ImagingView({ data }: Props) {
  
  // Calculate median for anomaly table
  const anomalies = useMemo(() => {
    if (!data.length) return [];
    
    const stats: Record<string, { total: number, count: number, values: number[], median: number }> = {};
    SECTORS.IMAGING.forEach(sector => {
      stats[sector] = { total: 0, count: 0, values: [], median: 0 };
    });

    data.forEach(row => {
      SECTORS.IMAGING.forEach(sector => {
        const val = row[sector] as number;
        if (val > 0) {
          stats[sector].values.push(val);
        }
      });
    });

    // Calc median
    SECTORS.IMAGING.forEach(sector => {
      const vals = stats[sector].values.sort((a, b) => a - b);
      if (vals.length > 0) {
        const mid = Math.floor(vals.length / 2);
        stats[sector].median = vals.length % 2 !== 0 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      }
    });

    // Find anomalies (> 150% of median and val > 10)
    const foundAlerts: any[] = [];
    data.forEach(row => {
      SECTORS.IMAGING.forEach(sector => {
        const val = row[sector] as number;
        const med = stats[sector].median;
        if (val > 10 && med > 0 && val > med * 1.5) {
          foundAlerts.push({
            time: row.time,
            sector: sector.replace('DJ', ''),
            value: val,
            median: med,
            deviation: ((val / med) * 100 - 100).toFixed(0)
          });
        }
      });
    });

    return foundAlerts.sort((a, b) => b.value - a.value).slice(0, 10); // top 10

  }, [data]);


  if (data.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Gráfico de Linhas - Comparativo Simultâneo */}
        <div className="chart-container col-span-1 lg:col-span-2">
          <div className="chart-title">Cargas Críticas: Imagem (Simultaneidade)</div>
          <div className="h-80">
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
                  formatter={(value: number, name: string) => [Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value) + ' kWh', name]}
                  labelFormatter={(label) => `Horário: ${label}`}
                />
                <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                
                {SECTORS.IMAGING.map(sector => (
                  <Line 
                    key={sector} 
                    type="monotone" 
                    dataKey={sector} 
                    name={sector.replace('DJ', '').replace('_', '')} 
                    stroke={IMAGING_COLORS[sector as keyof typeof IMAGING_COLORS] || '#fff'} 
                    strokeWidth={2}
                    dot={false}
                  />
                ))}

              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Matriz de Alerta */}
        <div className="chart-container lg:col-span-1 flex flex-col">
          <div className="chart-title" style={{ borderColor: 'var(--accent-amber)' }}>Alertas de Anomalia (Picos)</div>
          
          <div className="overflow-y-auto flex-1">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Setor</th>
                  <th style={{textAlign: 'right'}}>Desvio</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((alert, i) => (
                  <tr key={i}>
                    <td>{alert.time}</td>
                    <td style={{ opacity: 0.8 }}>{alert.sector.replace('_', ' ')}</td>
                    <td style={{textAlign: 'right'}}>
                      <span className="tag-192" style={{ color: 'var(--accent-amber)' }}>
                        +{alert.deviation}%
                      </span>
                    </td>
                  </tr>
                ))}
                {anomalies.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{textAlign: 'center', padding: '20px 0', color: '#555'}}>Nenhum pico atípico registrado</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
