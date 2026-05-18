import { useState } from 'react';

interface HandshakeFormProps {
  apiUrl: string;
}

export function MerchantHandshakeForm({ apiUrl }: HandshakeFormProps) {
  const [route, setRoute] = useState('MPESA');
  const [amountKES, setAmountKES] = useState('0');
  const [amountUSDC, setAmountUSDC] = useState('0');
  const [exchangeRate, setExchangeRate] = useState('0');
  const [metadata, setMetadata] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('Submitting...');

    const payload = {
      route,
      amountKESCents: amountKES,
      amountUSDCents: amountUSDC,
      exchangeRateKESPerUSDC: exchangeRate,
      handshakeMetadata: {
        itemDescription: metadata,
      },
    };

    const response = await fetch(`${apiUrl}/v1/handshakes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const json = await response.json();
      setStatus(`Handshake created: ${json.handshakeId}`);
    } else {
      setStatus('Failed to create handshake');
    }
  };

  return (
    <div className="max-w-xl mx-auto p-4 bg-white shadow rounded-lg">
      <h2 className="text-xl font-semibold mb-4">Create New Handshake</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Route</span>
          <select
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
          >
            <option value="MPESA">MPESA</option>
            <option value="BANK">BANK</option>
            <option value="USDC">USDC</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Amount KES (cents)</span>
          <input
            type="text"
            value={amountKES}
            onChange={(e) => setAmountKES(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Amount USDC (cents)</span>
          <input
            type="text"
            value={amountUSDC}
            onChange={(e) => setAmountUSDC(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Exchange Rate KES per USDC</span>
          <input
            type="text"
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Item / Metadata</span>
          <textarea
            value={metadata}
            onChange={(e) => setMetadata(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          />
        </label>

        <button
          type="submit"
          className="w-full rounded-md bg-slate-900 text-white py-2 hover:bg-slate-700"
        >
          Create Handshake
        </button>
      </form>
      {status && <p className="mt-4 text-sm text-slate-600">{status}</p>}
    </div>
  );
}
