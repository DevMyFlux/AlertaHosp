import React, { useState, useEffect } from 'react';
import { Settings, Save, Phone, Key, FileText, Plus, X } from 'lucide-react';

export function SettingsView() {
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>(['5511949102183']);
  const [newPhoneInput, setNewPhoneInput] = useState('');
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [whatsappFrom, setWhatsappFrom] = useState('556298792013');

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
    </div>
  );
}
