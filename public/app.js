/* Universal Trust Layer — Admin Console Execution Engine (Vanilla JS, no deps) */

const DESTINATION_POOL_ACCOUNT = '880200283180';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hashLike(input) {
  let h = 2166136261;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function computeSovereignTax(principal, jurisdictionCode) {
  const base = clamp(Number(principal) || 0, 0, 1e12);
  const code = String(jurisdictionCode || 'ZK');
  const pseudo = parseInt(hashLike(code + ':' + principal).slice(0, 4), 16);
  const rateBps = 30 + (pseudo % 220); // 0.30% - 2.49%
  const tax = Math.round((base * rateBps) / 10000);
  return {
    jurisdictionCode: code,
    rateBps,
    tax,
    net: Math.max(0, base - tax)
  };
}

function statusBadge(el, status) {
  el.classList.remove('b-good', 'b-warn', 'b-bad');
  if (status === 'GOOD') {
    el.classList.add('b-good');
    el.textContent = 'OK';
  } else if (status === 'WARN') {
    el.classList.add('b-warn');
    el.textContent = 'WARN';
  } else {
    el.classList.add('b-bad');
    el.textContent = 'FAIL';
  }
}

function makeTenant(id) {
  return {
    id,
    ring: {
      min: 0,
      max: 0,
      fill: 0
    },
    queueDepth: 0,
    latencyMs: 0
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildMockEnvelope(tenant, idx) {
  const principal = Math.round(1000 + Math.random() * 90000);
  const jurisdiction = pick(['KE', 'UG', 'TZ', 'MW', 'RWA', 'SD', 'ZA']);
  const envelopeId = `env_${tenant}_${idx}_${hashLike(tenant + ':' + idx + ':' + principal)}`;
  const integritySig = `sig_${hashLike(envelopeId + ':integrity')}`;
  const proof = `proof_${hashLike(envelopeId + ':zk')}`;

  return {
    envelopeId,
    tenantId: tenant,
    receivedAt: nowIso(),
    principalAmount: principal,
    jurisdictionCode: jurisdiction,
    integrity: {
      signature: integritySig,
      expectedSignatureHash: hashLike(envelopeId + ':integrity')
    },
    zk: {
      proof,
      proofHash: hashLike(envelopeId + ':zk')
    },
    routing: {
      intendedClearingPoolAccount: DESTINATION_POOL_ACCOUNT
    }
  };
}

function verifyEnvelope(envelope) {
  // Mock: cryptographic checks are simulated deterministically.
  const sigOk = envelope.integrity.signature === `sig_${envelope.integrity.expectedSignatureHash}`;
  const proofOk = envelope.zk.proof === `proof_${envelope.zk.proofHash}`;

  const zkStatus = proofOk ? 'GOOD' : 'BAD';
  const integrityStatus = sigOk ? 'GOOD' : 'BAD';

  return {
    zkStatus,
    integrityStatus,
    zkOk: proofOk,
    integrityOk: sigOk
  };
}

function simulateRoutingAndSettlement(envelope) {
  const tax = computeSovereignTax(envelope.principalAmount, envelope.jurisdictionCode);

  const settlement = {
    destinationPoolAccount: DESTINATION_POOL_ACCOUNT,
    principal: envelope.principalAmount,
    taxSplit: {
      jurisdiction: tax.jurisdictionCode,
      rateBps: tax.rateBps,
      taxAmount: tax.tax
    },
    netSettlement: tax.net
  };

  return settlement;
}

function renderMatrix(tenants, rowsEl) {
  rowsEl.innerHTML = '';

  tenants.forEach((t) => {
    const ringFill = clamp(t.ring.fill, 0, 100);

    const r = document.createElement('div');
    r.className = 'r';
    r.setAttribute('role', 'row');

    const cTenant = document.createElement('div');
    cTenant.className = 'tenant-name mono';
    cTenant.textContent = t.id;

    const cRing = document.createElement('div');
    const spark = document.createElement('div');
    spark.className = 'spark';
    const i = document.createElement('i');
    i.style.width = `${ringFill}%`;
    spark.appendChild(i);
    cRing.appendChild(spark);

    const cQueue = document.createElement('div');
    cQueue.className = 'mono';
    cQueue.textContent = `${t.queueDepth}`;

    const cLat = document.createElement('div');
    cLat.className = 'mono';
    cLat.textContent = `${t.latencyMs}ms`;

    r.appendChild(cTenant);
    r.appendChild(cRing);
    r.appendChild(cQueue);
    r.appendChild(cLat);
    rowsEl.appendChild(r);
  });
}

function appendLog(item) {
  const body = $('#log-body');
  const logCount = $('#kv-log-count');

  const row = document.createElement('div');
  row.className = 'log-item';

  const ts = document.createElement('div');
  ts.className = 'log-ts';
  ts.textContent = item.ts;

  const msg = document.createElement('div');
  msg.className = 'log-msg';
  msg.textContent = item.message;

  row.appendChild(ts);
  row.appendChild(msg);

  body.prepend(row);

  // Keep bounded log
  const max = 80;
  const all = $$('.log-item', body);
  if (all.length > max) {
    all.slice(max).forEach((n) => n.remove());
  }

  const count = $$('.log-item', body).length;
  if (logCount) logCount.textContent = `items: ${count}`;
}

function setEngineStatus(text) {
  const el = $('#ui-runtime-status');
  if (el) el.textContent = text;
}

function updateFlags(flags) {
  const flagZk = $('#flag-zk');
  const flagIntegrity = $('#flag-integrity');
  const flagTax = $('#flag-tax');
  const flagRouting = $('#flag-routing');

  if (flagZk) statusBadge(flagZk, flags.zkStatus);
  if (flagIntegrity) statusBadge(flagIntegrity, flags.integrityStatus);
  if (flagTax) statusBadge(flagTax, flags.taxStatus);
  if (flagRouting) statusBadge(flagRouting, flags.routingStatus);
}

function setKv(envelope, settlement, verification) {
  const kvEnv = $('#kv-envelope');
  const kvTs = $('#kv-ts');

  if (kvEnv) {
    kvEnv.textContent = `envelope=${envelope.envelopeId} principal=${envelope.principalAmount} integrity=${verification.integrityOk ? 'OK' : 'FAIL'} zk=${verification.zkOk ? 'OK' : 'FAIL'}`;
  }
  if (kvTs) {
    kvTs.textContent = settlement.lastVerifiedAt || nowIso();
  }
}

function createTenants() {
  // Multi-tenant set (mock)
  const tenantIds = ['tenant_alpha', 'tenant_beta', 'tenant_gamma', 'tenant_delta'];
  return tenantIds.map(makeTenant);
}

(function mount() {
  // UI init
  const ledgerEl = $('#ledger-destination');
  if (ledgerEl) ledgerEl.textContent = DESTINATION_POOL_ACCOUNT;

  const matrixRows = $('#matrix-rows');
  const tenantCount = $('#kv-tenant-count');

  let tenants = createTenants();
  if (tenantCount) tenantCount.textContent = `tenants: ${tenants.length}`;
  renderMatrix(tenants, matrixRows);

  const btnToggle = $('#btn-toggle');
  const btnClear = $('#btn-clear');

  let running = true;
  let tick = 0;
  let lastRateTs = Date.now();
  let eventsInWindow = 0;

  // Initial flags
  updateFlags({
    zkStatus: 'WARN',
    integrityStatus: 'WARN',
    taxStatus: 'WARN',
    routingStatus: 'WARN'
  });

  setEngineStatus('ENGINE: ready');

  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      running = !running;
      btnToggle.textContent = running ? 'Pause' : 'Resume';
      setEngineStatus(`ENGINE: ${running ? 'running' : 'paused'}`);
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      const body = $('#log-body');
      body.innerHTML = '';
      const logCount = $('#kv-log-count');
      if (logCount) logCount.textContent = 'items: 0';
    });
  }

  function updateTenantsDynamics() {
    tenants = tenants.map((t) => {
      const ringDelta = (Math.random() - 0.45) * 18;
      const fill = clamp(t.ring.fill + ringDelta, 6, 98);
      const queueDepth = Math.round(fill * 1.4 + Math.random() * 18);
      const latencyMs = Math.round(18 + (100 - fill) * 0.9 + Math.random() * 14);

      return {
        ...t,
        ring: { min: 0, max: 100, fill },
        queueDepth,
        latencyMs
      };
    });

    renderMatrix(tenants, matrixRows);
  }

  function dispatchOneEvent() {
    tick += 1;
    const tenant = pick(tenants.map((t) => t.id));
    const envelope = buildMockEnvelope(tenant, tick);

    // Verify cryptographic checks (simulated)
    const verification = verifyEnvelope(envelope);

    // Tax splitting
    const settlement = simulateRoutingAndSettlement(envelope);

    // Routing enforcement
    const routingOk = settlement.destinationPoolAccount === DESTINATION_POOL_ACCOUNT && envelope.routing.intendedClearingPoolAccount === DESTINATION_POOL_ACCOUNT;

    const taxStatus = verification.integrityOk && verification.zkOk ? 'GOOD' : 'WARN';
    const routingStatus = routingOk && verification.integrityOk && verification.zkOk ? 'GOOD' : 'BAD';

    updateFlags({
      zkStatus: verification.zkOk ? 'GOOD' : 'BAD',
      integrityStatus: verification.integrityOk ? 'GOOD' : 'BAD',
      taxStatus,
      routingStatus
    });

    settlement.lastVerifiedAt = nowIso();
    setKv(envelope, settlement, verification);

    // Log: explicitly describe envelope structure + computations.
    appendLog({
      ts: new Date().toLocaleTimeString(),
      message: `tx=${envelope.envelopeId} tenant=${envelope.tenantId} envelopeCheck={integrity:${verification.integrityOk?'OK':'FAIL'}, zk:${verification.zkOk?'OK':'FAIL'}} taxSplit={jurisdiction:${settlement.taxSplit.jurisdiction}, rateBps:${settlement.taxSplit.rateBps}, tax:${settlement.taxSplit.taxAmount}} netSettlement=${settlement.netSettlement} -> destination=${settlement.destinationPoolAccount}`
    });

    eventsInWindow += 1;
  }

  async function startLoop() {
    // Polling loop (setInterval)
    const intervalMs = 900;

    setEngineStatus('ENGINE: running');

    setInterval(() => {
      if (!running) return;

      dispatchOneEvent();
      updateTenantsDynamics();

      const now = Date.now();
      if (now - lastRateTs >= 1500) {
        const rate = Math.round((eventsInWindow / ((now - lastRateTs) / 1000)) * 10) / 10;
        const el = $('#kv-stream-rate');
        if (el) el.textContent = `rate: ${rate}/s`;
        lastRateTs = now;
        eventsInWindow = 0;
      }
    }, intervalMs);
  }

  // Start after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startLoop);
  } else {
    startLoop();
  }
})();

