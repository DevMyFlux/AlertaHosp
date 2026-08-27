import React, { useState, useEffect } from 'react';
import { generateMockData } from './data/mockData';
import { processCumulativeData } from './data/processor';
import { ProcessedTelemetryData } from './types';
import { SHEET_URL } from './config/sheet';
import { ExecutiveView } from './components/ExecutiveView';
import { HVACView } from './components/HVACView';
import { ImagingView } from './components/ImagingView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { SectorView } from './components/SectorView';
import { AiChatView } from './components/AiChatView';
import { LiveMonitorView } from './components/LiveMonitorView';
import { SettingsView } from './components/SettingsView';
import { HistoryView } from './components/HistoryView';
import Papa from 'papaparse';
import { Activity, Wind, Radio, Database, UploadCloud, Bot, BarChart2, Clock, Settings, FileSpreadsheet } from 'lucide-react';
import clsx from 'clsx';

export default function App() {
  const [activeTab, setActiveTab] = useState<'executive' | 'hvac' | 'imaging' | 'diagnostics' | 'sector' | 'live' | 'settings' | 'chat' | 'history'>('executive');
  const [data, setData] = useState<ProcessedTelemetryData[]>([]);
  const [isSimulated, setIsSimulated] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(
    localStorage.getItem('auto_check_enabled') !== 'false'
  );
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
  const [theme, setTheme] = useState<'dark' | 'light'>(localStorage.getItem('app_theme') as any || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('app_theme', theme);
  }, [theme]);

  useEffect(() => {
    const saved = localStorage.getItem('hidden_tabs');
    if (saved) {
      try { setHiddenTabs(JSON.parse(saved)); } catch (e) {}
    }
  }, []);

  const toggleTabVisibility = (tabId: string) => {
    setHiddenTabs(prev => {
       const next = prev.includes(tabId) ? prev.filter(t => t !== tabId) : [...prev, tabId];
       localStorage.setItem('hidden_tabs', JSON.stringify(next));
       return next;
    });
  };

  const fetchData = () => {
    fetch(SHEET_URL)
      .then(response => {
        if (!response.ok) throw new Error("Network response was not ok");
        return response.text();
      })
      .then(csvText => {
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            try {
              if (results.data && results.data.length > 0) {
                const raw = results.data as any[];
                const processed = processCumulativeData(raw);
                setData(processed);
                setIsSimulated(false);
                setLastUpdate(new Date());
              } else {
                throw new Error("No data found");
              }
            } catch (error) {
              console.warn("Parse error:", error);
              const mock = generateMockData();
              const processedMock = processCumulativeData(mock);
              setData(processedMock);
              setIsSimulated(true);
              setLastUpdate(new Date());
            }
          }
        });
      })
      .catch(err => {
        console.warn("Fetch error:", err);
        const mock = generateMockData();
        const processedMock = processCumulativeData(mock);
        setData(processedMock);
        setIsSimulated(true);
        setLastUpdate(new Date());
      });
  };

  // Load Sim Data on mount and refresh every 15 minutes (900000 ms) if enabled
  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    localStorage.setItem('auto_check_enabled', String(autoCheckEnabled));
    let interval: NodeJS.Timeout | undefined;
    if (autoCheckEnabled) {
      interval = setInterval(fetchData, 900000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoCheckEnabled]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const raw = results.data as any[];
          const processed = processCumulativeData(raw);
          setData(processed);
          setIsSimulated(false);
        } catch (error) {
          console.warn("Parse error:", error);
          alert("Erro ao processar arquivo. Verifique se o formato atende à arquitetura esperada.");
        }
      }
    });
  };

  return (
    <div className="dashboard-grid">
      
      {/* Header */}
      <header className="header-bar">
        <div>
          <span style={{ fontWeight: 900, letterSpacing: '2px', color: 'var(--accent-blue)' }}>MyFlux</span>
          <span style={{ marginLeft: '15px', fontSize: '12px', opacity: 0.6 }}>TELEMETRIA ENERGÉTICA</span>
        </div>
        <div style={{ display: 'flex', gap: '20px', fontSize: '11px', alignItems: 'center' }}>
            <button 
              onClick={() => setAutoCheckEnabled(!autoCheckEnabled)} 
              className={clsx("px-2 py-1 border rounded text-[10px] flex items-center gap-1 transition-colors cursor-pointer", autoCheckEnabled ? "border-[var(--accent-green)] text-[var(--accent-green)]" : "border-gray-500 text-gray-500")}
              title="Ativar/Desativar verificação automática de 15 em 15 minutos"
            >
              <Clock className="w-3 h-3" />
              AUTO-CHECK: {autoCheckEnabled ? "ON (15m)" : "OFF"}
            </button>
            <div className="flex items-center">
              <Database className="w-3 h-3 mr-1 text-gray-400" />
              FONTE: <span className="ml-1" style={{ color: isSimulated ? 'var(--accent-amber)' : 'var(--accent-green)' }}>{isSimulated ? 'MOCK' : 'CSV'}</span>
            </div>
            <div>STATUS: <span className="status-dot status-good"></span>OPERACIONAL</div>
        </div>
      </header>

      {/* Sidebar */}
      <aside className="sidebar">
        
        <div className="filter-group">
          <label>Visões</label>
          <div className="space-y-2">
            {!hiddenTabs.includes('executive') && <TabButton active={activeTab === 'executive'} onClick={() => setActiveTab('executive')} icon={<Activity className="w-4 h-4" />}>Visão Executiva</TabButton>}
            {!hiddenTabs.includes('live') && <TabButton active={activeTab === 'live'} onClick={() => setActiveTab('live')} icon={<Clock className="w-4 h-4" />}>Monitoramento 15m</TabButton>}
            {!hiddenTabs.includes('history') && <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')} icon={<FileSpreadsheet className="w-4 h-4" />}>Histórico de Alertas</TabButton>}
            {!hiddenTabs.includes('sector') && <TabButton active={activeTab === 'sector'} onClick={() => setActiveTab('sector')} icon={<BarChart2 className="w-4 h-4" />}>Análise Setorial (15m)</TabButton>}
            {!hiddenTabs.includes('hvac') && <TabButton active={activeTab === 'hvac'} onClick={() => setActiveTab('hvac')} icon={<Wind className="w-4 h-4" />}>Operação e HVAC</TabButton>}
            {!hiddenTabs.includes('imaging') && <TabButton active={activeTab === 'imaging'} onClick={() => setActiveTab('imaging')} icon={<Radio className="w-4 h-4" />}>Diag. Imagem</TabButton>}
            {!hiddenTabs.includes('diagnostics') && <TabButton active={activeTab === 'diagnostics'} onClick={() => setActiveTab('diagnostics')} icon={<Bot className="w-4 h-4" />}>AI Diagnostics</TabButton>}
            {!hiddenTabs.includes('chat') && <TabButton active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} icon={<Bot className="w-4 h-4" />}>AI Assistant</TabButton>}
            <TabButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings className="w-4 h-4" />}>Configurações</TabButton>
          </div>
        </div>

        <div className="filter-group mt-4">
          <label>Controle de Dados</label>
          <label className="btn-tab text-center justify-center">
            <UploadCloud className="w-4 h-4" />
            Carregar CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>

        <div className="math-hint">
          Cálculo: Δ kWh = P(t) - P(t-1) <br/>
          Filtro: Quality == 192
        </div>
        <div style={{ marginTop: 'auto', fontSize: '10px', opacity: 0.4 }}>
          Senior BI Engineer System<br/>Utilities Monitoring
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
          {activeTab === 'executive' && <ExecutiveView data={data} />}
          {activeTab === 'live' && <LiveMonitorView data={data} lastUpdate={lastUpdate} onRefresh={fetchData} />}
          {activeTab === 'sector' && <SectorView data={data} />}
          {activeTab === 'hvac' && <HVACView data={data} />}
          {activeTab === 'imaging' && <ImagingView data={data} />}
          {activeTab === 'diagnostics' && <DiagnosticsView data={data} />}
          {activeTab === 'chat' && <AiChatView data={data} />}
          {activeTab === 'history' && <HistoryView data={data} />}
          {activeTab === 'settings' && <SettingsView hiddenTabs={hiddenTabs} toggleTabVisibility={toggleTabVisibility} theme={theme} setTheme={setTheme} />}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean, onClick: () => void, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx("btn-tab", active && "active")}
    >
      <span className={clsx("transition-colors", active ? "text-[var(--accent-blue)]" : "text-gray-500")}>
        {icon}
      </span>
      {children}
    </button>
  );
}
