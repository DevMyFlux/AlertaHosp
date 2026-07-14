import React, { useState, useEffect } from 'react';
import { Settings, Save, Phone, Key, FileText, Plus, X, FlaskConical } from 'lucide-react';

export function SettingsView() {
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>(['5511949102183']);
  const [newPhoneInput, setNewPhoneInput] = useState('');
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [whatsappFrom, setWhatsappFrom] = useState('556298792013');
  const [testingLab, setTestingLab] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('notify_phone_number');
    if (saved) {
      const list = saved.split(',').map(p => p.trim()).filter(Boolean);
      if (list.length) setPhoneNumbers(list);
    }

    const savedAppId = localStorage.getItem('vonage_app_id');
    if (savedAppId) setAppId(savedAppId);

    const savedKey = localStorage.getItem('vonage_private_key');
    if (savedKey) setPrivateKey(savedKey);

    const savedFrom = localStorage.getItem('vonage_whatsapp_from');
    if (savedFrom) setWhatsappFrom(savedFrom);
  }, []);

  const handleAddPhone = () => {
    const cleaned = newPhoneInput.replace(/\D/g, '');
    if (!cleaned || phoneNumbers.includes(cleaned)) {
      setNewPhoneInput('');
      return;
    }
    setPhoneNumbers(prev => [...prev, cleaned]);
    setNewPhoneInput('');
  };

  const handleRemovePhone = (num: string) => {
    setPhoneNumbers(prev => prev.filter(p => p !== num));
  };

  const handleSave = () => {
    localStorage.setItem('notify_phone_number', phoneNumbers.join(','));
    localStorage.setItem('vonage_app_id', appId);
    localStorage.setItem('vonage_private_key', privateKey);
    localStorage.setItem('vonage_whatsapp_from', whatsappFrom);
    alert('Configurações salvas com sucesso!');
  };

  // Diagnóstico temporário: dispara um envio real de teste direto pro
  // template setor_laboratorio_alerta_energia2 (valores fictícios,
  // claramente marcados como TESTE) e mostra o erro exato devolvido pela
  // Vonage/Meta na tela, sem precisar esperar uma anomalia real nem vasculhar
  // os Logs da Vercel. Remover este bloco depois que o template estiver
  // confirmado entregando.
  const handleTestLabTemplate = async () => {
    setTestingLab(true);
    setTestResult(null);
    try {
      const phone = phoneNumbers.join(',') || localStorage.getItem('notify_phone_number') || '5511949102183';
      const response = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sector: 'LABORATÓRIO (TESTE)',
          message: 'Mensagem de teste de diagnóstico do template do Laboratório — pode ignorar.',
          valor: '0,1',
          phone,
          appId,
          privateKey,
          whatsappFrom,
          templateOverride: 'setor_laboratorio_alerta_energia2',
          templateParams: ['LABORATÓRIO - TESTE', '0,1'],
        }),
      });
      const data = await response.json();
      setTestResult(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setTestResult(`Erro de rede ao chamar /api/notify: ${e?.message || e}`);
    } finally {
      setTestingLab(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          <Settings className="text-blue-500 w-6 h-6" />
          Configurações do Sistema
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="chart-container">
          <h3 className="text-lg font-medium text-gray-200 mb-4 flex items-center gap-2">
            <Phone className="w-5 h-5 text-gray-400" />
            Notificações (Destinatário)
          </h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Números de Destino (com DDI e DDD)
              </label>

              <div className="space-y-2 mb-3">
                {phoneNumbers.map((num) => (
                  <div key={num} className="flex items-center justify-between bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2">
                    <span className="text-white font-mono text-sm">{num}</span>
                    <button
                      onClick={() => handleRemovePhone(num)}
                      className="text-gray-500 hover:text-red-400 transition-colors"
                      title="Remover destinatário"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {phoneNumbers.length === 0 && (
                  <p className="text-xs text-amber-500">Nenhum destinatário cadastrado — os alertas não terão para onde ir.</p>
                )}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPhoneInput}
                  onChange={(e) => setNewPhoneInput(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddPhone(); } }}
                  placeholder="Ex: 5511949102183"
                  className="flex-1 bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleAddPhone}
                  className="flex items-center gap-1 px-3 py-2 bg-[#1A1A1A] border border-[#333] hover:border-blue-500 text-gray-300 rounded-md text-sm transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Adicionar
                </button>
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Todos os números acima recebem os alertas gerados pela IA via WhatsApp ou SMS (fallback).
              </p>
            </div>

            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium transition-colors"
            >
              <Save className="w-4 h-4" />
              Salvar Configurações
            </button>
          </div>
        </div>

        <div className="chart-container border-blue-500/20">
          <h3 className="text-lg font-medium text-gray-200 mb-4 flex items-center gap-2">
            <Key className="w-5 h-5 text-blue-400" />
            Credenciais WhatsApp (Vonage)
          </h3>
          
          <div className="space-y-4">
            <div className="p-3 bg-blue-900/20 border border-blue-800/30 rounded-md text-sm text-blue-200 mb-4">
              A API de Mensagens (WhatsApp) da Vonage exige <strong>Application ID</strong> e <strong>Private Key</strong> para funcionar. Caso não sejam preenchidos, o sistema enviará apenas via SMS.
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Application ID
              </label>
              <input
                type="text"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="Ex: 5eaf2088-e756-4eac-988b-6c66d75e22cd"
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                WhatsApp Sender Number (From)
              </label>
              <input
                type="text"
                value={whatsappFrom}
                onChange={(e) => setWhatsappFrom(e.target.value.replace(/\D/g, ''))}
                placeholder="Ex: 556298792013"
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Private Key
              </label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                rows={5}
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white font-mono text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Diagnóstico temporário — remover quando o template do Laboratório
          estiver confirmado entregando. */}
      <div className="chart-container border-amber-500/30 bg-amber-950/10">
        <h3 className="text-lg font-medium text-gray-200 mb-2 flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-amber-400" />
          Diagnóstico (temporário): template do Laboratório
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          Dispara um envio de teste real (valores fictícios, marcados como TESTE) direto pro template
          <code className="mx-1 text-amber-300">setor_laboratorio_alerta_energia2</code>
          pros números cadastrados acima, e mostra a resposta completa da API — incluindo o erro exato
          da Vonage/Meta se falhar. Esse bloco é só pra investigação e será removido depois.
        </p>
        <button
          onClick={handleTestLabTemplate}
          disabled={testingLab}
          className="flex items-center gap-2 px-4 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 rounded-md border border-amber-500/30 font-medium transition-colors text-sm disabled:opacity-50"
        >
          <FlaskConical className="w-4 h-4" />
          {testingLab ? 'Enviando teste...' : 'Testar template Laboratório'}
        </button>
        {testResult && (
          <pre className="mt-4 p-3 bg-[#0a0a0c] border border-[#333] rounded-md text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap">
            {testResult}
          </pre>
        )}
      </div>
    </div>
  );
}
