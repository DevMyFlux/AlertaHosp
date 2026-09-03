import React, { useState, useMemo, useEffect } from 'react';
import { ProcessedTelemetryData } from '../types';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { useHospital } from '../config/HospitalContext';

interface Props {
  data: ProcessedTelemetryData[];
}

export function SectorView({ data }: Props) {
  const { hospital } = useHospital();
  const availableDates = useMemo(() => {
    const dates = new Set<string>();
    data.forEach(d => {
      const ts = String(d.timestamp);
      const dDate = ts.split(/[T ]/)[0];
      dates.add(dDate);
    });
    return Array.from(dates);
  }, [data]);

  // '' quando o hospital ainda não tem setor configurado (ex: HMB) — os
  // usos abaixo (Number(d[''])) degradam pra 0 sem quebrar a tela.
  const [selectedSector, setSelectedSector] = useState<string>(hospital.allSectors[0] || '');
  // Troca o setor selecionado ao trocar de hospital, senão fica preso ao
  // setor do hospital anterior (que pode nem existir no novo).
  useEffect(() => {
    setSelectedSector(hospital.allSectors[0] || '');
  }, [hospital.id]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [startTimestamp, setStartTimestamp] = useState<string>('');
  const [endTimestamp, setEndTimestamp] = useState<string>('');

  React.useEffect(() => {
    if (availableDates.length > 0 && !selectedDate) {
      setSelectedDate(availableDates[0]);
    }
  }, [availableDates, selectedDate]);

  const availableTimes = useMemo(() => {
    if (!selectedDate) return [];
    return data
      .filter(d => {
        const ts = String(d.timestamp);
        const dDate = ts.split(/[T ]/)[0];
        return dDate === selectedDate;
      })
      .map(d => ({
        id: String(d.timestamp),
        time: d.time,
        timestamp: d.timestamp
      }));
  }, [data, selectedDate]);

  React.useEffect(() => {
    if (availableTimes.length > 0) {
      const startExists = availableTimes.find(t => t.id === startTimestamp);
      const endExists = availableTimes.find(t => t.id === endTimestamp);
      
      if (!startExists) setStartTimestamp(availableTimes[0].id);
      if (!endExists) setEndTimestamp(availableTimes[availableTimes.length - 1].id);
    }
  }, [availableTimes, startTimestamp, endTimestamp]);

  const sectorData = useMemo(() => {
    let startIdx = data.findIndex(d => String(d.timestamp) === startTimestamp);
    let endIdx = data.findIndex(d => String(d.timestamp) === endTimestamp);

    if (startIdx === -1) startIdx = 0;
    if (endIdx === -1) endIdx = data.length - 1;

    const actualStart = Math.min(startIdx, endIdx);
    const actualEnd = Math.max(startIdx, endIdx);

    return data
      .slice(actualStart, actualEnd + 1)
      .map(d => {
        const ts = String(d.timestamp);
        const dDate = ts.split(/[T ]/)[0];
        return {
          time: d.time,
          displayTime: d.time,
          timestamp: d.timestamp,
          value: Number(d[selectedSector]) || 0
        };
      });
  }, [data, selectedSector, startTimestamp, endTimestamp]);

  if (data.length === 0) return null;

  const total = sectorData.reduce((acc, curr) => acc + curr.value, 0);
  const maxRow = [...sectorData].sort((a, b) => b.value - a.value)[0];
  const avg = sectorData.length > 0 ? total / sectorData.length : 0;

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      
      <div className="chart-container flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold" style={{color: 'var(--accent-blue)'}}>Análise Individual (15 min)</h2>
          <p className="text-xs text-gray-400">Desmembramento do consumo por medidores setoriais</p>
        </div>
        
        <div className="flex items-center gap-2 flex-wrap">
          <div className="filter-group" style={{ minWidth: '120px' }}>
            <select 
              className="btn-tab bg-[#222] text-xs px-2 py-1" 
              value={selectedDate} 
              onChange={(e) => setSelectedDate(e.target.value)}
            >
              <option value="" disabled>Data:</option>
              {availableDates.map(d => (
                <option key={`date-${d}`} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="w-[1px] h-6 bg-[var(--line)] mx-1"></div>
          <div className="filter-group" style={{ minWidth: '100px' }}>
            <select 
              className="btn-tab bg-[#222] text-xs px-2 py-1" 
              value={startTimestamp} 
              onChange={(e) => setStartTimestamp(e.target.value)}
            >
              <option value="" disabled>De:</option>
              {availableTimes.map(t => (
                <option key={`start-${t.id}`} value={t.id}>
                  {t.time}
                </option>
              ))}
            </select>
          </div>
          <span className="text-gray-500 text-xs text-center w-4 inline-block">a</span>
          <div className="filter-group" style={{ minWidth: '100px' }}>
             <select 
              className="btn-tab bg-[#222] text-xs px-2 py-1" 
              value={endTimestamp} 
              onChange={(e) => setEndTimestamp(e.target.value)}
            >
              <option value="" disabled>Até:</option>
              {availableTimes.map(t => (
                <option key={`end-${t.id}`} value={t.id}>
                  {t.time}
                </option>
              ))}
            </select>
          </div>
          <div className="w-[1px] h-6 bg-[var(--line)] mx-2"></div>
          <div className="filter-group" style={{ minWidth: '200px' }}>
            <select 
              className="btn-tab bg-[#222]" 
              value={selectedSector} 
              onChange={(e) => setSelectedSector(e.target.value)}
            >
              {hospital.allSectors.map(sec => (
                <option key={sec} value={sec}>
                  {sec.replace('DJ', '').replace('.ME_CLIM_', 'CLIM ').replace('ME_CLIM_', 'CLIM ')}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="kpi-card">
          <div className="kpi-label">Consumo Total do Setor (kWh)</div>
          <div className="kpi-value white">{Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(total)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pico de Demanda (15m)</div>
          <div className="kpi-value amber">{Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(maxRow?.value || 0)} <span style={{fontSize: '11px', fontWeight: 'normal', color: '#888'}}>às {maxRow?.time ?? '--:--'}</span></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Média por Período (15m)</div>
          <div className="kpi-value blue">{Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(avg || 0)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main Line Chart */}
        <div className="chart-container lg:col-span-2">
          <div className="chart-title">Curva de Carga 15min: {selectedSector}</div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sectorData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="displayTime" stroke="#888" tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} minTickGap={30} />
                <YAxis 
                  stroke="#888" 
                  tick={{fontSize: 10, fontFamily: 'var(--f-mono)'}} 
                  tickFormatter={(val) => Intl.NumberFormat('pt-BR', { notation: "compact", maximumFractionDigits: 1 }).format(val)}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--line)', borderRadius: '4px', color: 'var(--ink)' }}
                  itemStyle={{ color: 'var(--accent-blue)' }}
                  cursor={{fill: 'rgba(255,255,255,0.05)'}}
                  formatter={(value: number) => [Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value) + ' kWh', 'Consumo']}
                  labelFormatter={(label) => `Horário: ${label}`}
                />
                <Bar dataKey="value" name="Consumo (kWh)" fill="var(--accent-blue)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Tabelão */}
        <div className="chart-container lg:col-span-1 flex flex-col">
          <div className="chart-title">Registros Detalhados (15 min)</div>
          
          <div className="overflow-y-auto flex-1" style={{ maxHeight: '320px' }}>
            <table className="grid-table">
              <thead style={{position: 'sticky', top: 0, background: 'var(--card-bg)'}}>
                <tr>
                  <th style={{textAlign: 'left'}}>Data / Hora</th>
                  <th style={{textAlign: 'right'}}>Consumo (kWh)</th>
                </tr>
              </thead>
              <tbody>
                {sectorData.map((row, i) => (
                  <tr key={i}>
                    <td>{row.displayTime}</td>
                    <td style={{textAlign: 'right', color: row.value > avg * 1.5 ? 'var(--accent-amber)' : 'var(--ink)'}}>
                      {row.value.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  );
}
