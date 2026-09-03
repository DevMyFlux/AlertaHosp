import React from 'react';
import { ProcessedTelemetryData } from '../types';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';
import { aggregateByPeriod } from '../data/processor';
import { useHospital } from '../config/HospitalContext';

interface Props {
  data: ProcessedTelemetryData[];
}

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

export function HVACView({ data }: Props) {
  const { hospital } = useHospital();
  if (data.length === 0) return null;

  const hvacDataPeriod = aggregateByPeriod(data, hospital.sectors.HVAC);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        
        {/* Gráfico de Área Empilhada */}
        <div className="chart-container col-span-1 lg:col-span-2">
          <div className="chart-title">Consumo de Climatização (HVAC) por Setor</div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
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
                {hospital.sectors.HVAC.map((sector, idx) => (
                  <Area 
                    key={sector} 
                    type="step" 
                    dataKey={sector} 
                    name={sector.replace('.ME_CLIM_', '').replace('ME_CLIM_', '')} 
                    stackId="1" 
                    stroke={COLORS[idx % COLORS.length]} 
                    fill={COLORS[idx % COLORS.length]} 
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Gráfico de Correlação de Perfil */}
        <div className="chart-container col-span-1 lg:col-span-2">
          <div className="chart-title">Perfil de Uso HVAC por Turno</div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hvacDataPeriod}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="name" stroke="#888" tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} />
                <YAxis 
                  stroke="#888" 
                  tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} 
                  tickFormatter={(val) => Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(val)}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--line)', borderRadius: '4px', color: 'var(--ink)' }}
                  cursor={{fill: 'rgba(255,255,255,0.05)'}}
                  formatter={(value: number, name: string) => [Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value) + ' kWh', name]}
                />
                <Legend wrapperStyle={{ fontSize: '10px' }} />
                {hospital.sectors.HVAC.map((sector, idx) => (
                  <Bar 
                    key={sector}
                    dataKey={sector} 
                    name={sector.replace('.ME_CLIM_', '').replace('ME_CLIM_', '')} 
                    stackId="a" 
                    fill={COLORS[idx % COLORS.length]} 
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  );
}
