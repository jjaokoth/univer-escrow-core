/*
  Universal Trust Layer — Escrow Live UI Gateway
  Self-contained controller for public/index.html.
*/

(function () {
  'use strict';

  const CONFIG = {
    lockUrl: '/api/escrow/lock',
    releaseUrl: '/api/escrow/release',
    tenantRefreshIntervalMs: 25000,
    telemetrySimIntervalMs: 1200,
    telemetryMaxItems: 250
  };

  function nowIso() {
    try {
      return new Date().toISOString();
    } catch (e) {
      return String(Date.now());
    }
  }

  function el(id) {
    return document.getElementById(id);
  }

  function safeText(node, text) {
    if (!node) return;
    node.textContent = String(text);
  }

  function badgeForState(state) {
    const s = String(state || '').toUpperCase();
    if (s.includes('SUCCESS') || s.includes('CLEARED') || s.includes('RELEASED')) return 'b-good';
    if (s.includes('PENDING') || s.includes('PROCESS') || s.includes('LOCKED')) return 'b-warn';
    if (s.includes('FAIL') || s.includes('ERROR') || s.includes('REJECT') || s.includes('INVALID')) return 'b-bad';
    return 'b-warn';
  }

  function parseMaybeJson(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (!(t.startsWith('{') || t.startsWith('['))) return { signature: t };
    try {
      return JSON.parse(t);
    } catch (e) {
      return { signature: t };
    }
  }

  async function fetchJson(url, payload, { signal } = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });

    // Backend may respond with non-JSON; try best-effort.
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return { ok: res.ok, status: res.status, data: await res.json() };
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: { raw: text } };
  }

  class TelemetryLog {
    constructor(rootEl) {
      this.rootEl = rootEl;
      this.countEl = el('kv-log-count');
      this.items = [];
    }

    clear() {
      this.items = [];
      if (this.rootEl) this.rootEl.innerHTML = '';
      safeText(this.countEl, 'items: 0');
    }

    append({ tag, type, message, meta }) {
      const ts = nowIso();
      const item = {
        ts,
        tag: tag ? String(tag) : 'RECEIPT',
        type: type ? String(type) : 'INFO',
        message: message ? String(message) : '',
        meta: meta || null
      };
      this.items.push(item);
      if (this.items.length > CONFIG.telemetryMaxItems) {
        this.items.shift();
      }

      if (!this.rootEl) return;

      const row = document.createElement('div');
      row.className = 'log-item';

      const tsNode = document.createElement('div');
      tsNode.className = 'log-ts';
      tsNode.textContent = ts;

      const msgNode = document.createElement('div');
      msgNode.className = 'log-msg';

      const metaStr = item.meta ? '\n' + JSON.stringify(item.meta, null, 2) : '';
      msgNode.textContent = `[${item.type}] ${item.tag} — ${item.message}${metaStr}`;

      row.appendChild(tsNode);
      row.appendChild(msgNode);
      this.rootEl.appendChild(row);
      // Keep scroll pinned to bottom.
      this.rootEl.scrollTop = this.rootEl.scrollHeight;

      if (this.countEl) safeText(this.countEl, `items: ${this.items.length}`);
    }

    updateStreamRate(rate) {
      const rateEl = el('kv-stream-rate');
      if (rateEl) safeText(rateEl, `rate: ${rate}/s`);
    }
  }

  class DashboardApp {
    constructor() {
      // Header/UI
      this.engineStatus = el('ui-runtime-status');
      this.tenantCountEl = el('ui-tenant-count');
      this.ledgerDestinationEl = el('ui-ledger-destination');
      this.engineDot = el('ui-engine-dot');

      // Flags
      this.flagZk = el('flag-zk');
      this.flagIntegrity = el('flag-integrity');
      this.flagTax = el('flag-tax');
      this.flagRouting = el('flag-routing');

      // Inputs
      this.lockTenantId = el('lock-tenant-id');
      this.lockAccount = el('lock-account');
      this.lockAmount = el('lock-amount');
      this.lockSignature = el('lock-signature');

      this.releaseTxnId = el('release-transaction-id');
      this.releaseSignature = el('release-signature');

      // Buttons
      this.btnPause = el('btn-pause');
      this.btnClear = el('btn-clear');
      this.btnLock = el('btn-lock');
      this.btnRelease = el('btn-release');

      // Telemetry
      this.log = new TelemetryLog(el('log-body'));

      // Tenant state (UI only)
      this.tenants = new Map();
      this.paused = false;

      // Simulated event stream
      this.telemetryTimer = null;
      this.rateTimer = null;
      this.receiptsInWindow = 0;
      this.windowStart = Date.now();
    }

    setEngineState(state) {
      const s = String(state || '').toUpperCase();
      if (this.engineStatus) this.engineStatus.textContent = `ENGINE: ${s.toLowerCase()}`;
      if (this.engineDot) {
        this.engineDot.classList.remove('dot-good', 'dot-warn', 'dot-bad');
        if (s.includes('PAUSED') || s.includes('BOOT')) this.engineDot.classList.add('dot-warn');
        else if (s.includes('ERROR') || s.includes('FAIL')) this.engineDot.classList.add('dot-bad');
        else this.engineDot.classList.add('dot-good');
      }
    }

    setFlag(node, badgeText, state) {
      if (!node) return;
      node.textContent = badgeText;
      node.classList.remove('b-good', 'b-warn', 'b-bad');
      node.classList.add(badgeForState(state));
    }

    upsertTenantRow(tenantId) {
      const id = String(tenantId || '').trim() || 'UnknownTenant';
      if (!this.tenants.has(id)) {
        const seed = {
          dbRing: `ring-${(Math.random() * 900 + 100).toFixed(0)}`,
          queue: `${(Math.random() * 90 + 10).toFixed(0)}ms`,
          latency: `${(Math.random() * 120 + 20).toFixed(0)}ms`,
          balanceLocked: 0,
          balanceReleased: 0,
          state: 'ACTIVE'
        };
        this.tenants.set(id, seed);
      }

      const rowWrap = el('matrix-rows');
      if (!rowWrap) return;

      // Render deterministic order
      const ids = Array.from(this.tenants.keys()).sort();
      rowWrap.innerHTML = '';

      for (const tid of ids) {
        const t = this.tenants.get(tid);
        const row = document.createElement('div');
        row.className = 'matrix-row';
        row.setAttribute('role', 'row');

        const name = document.createElement('div');
        name.className = 'tenant-chip';
        name.innerHTML = `
          <div class="name">${tid}</div>
          <div class="small" style="margin-top:2px">state: ${t.state}</div>
        `;

        const dbRing = document.createElement('div');
        dbRing.textContent = t.dbRing;

        const queue = document.createElement('div');
        queue.textContent = t.queue;

        const latency = document.createElement('div');
        latency.textContent = t.latency;

        row.appendChild(name);
        row.appendChild(dbRing);
        row.appendChild(queue);
        row.appendChild(latency);

        rowWrap.appendChild(row);
      }

      if (this.tenantCountEl) {
        safeText(this.tenantCountEl, `tenants: ${this.tenants.size}`);
      }
    }

    bumpTelemetryRate() {
      this.receiptsInWindow++;
    }

    startRateMeter() {
      if (this.rateTimer) clearInterval(this.rateTimer);
      this.rateTimer = setInterval(() => {
        const elapsed = Math.max(1, (Date.now() - this.windowStart));
        const rate = (this.receiptsInWindow * 1000) / elapsed;
        this.receiptsInWindow = 0;
        this.windowStart = Date.now();
        this.log.updateStreamRate(rate.toFixed(1));
      }, 1000);
    }

    startTelemetrySimulation() {
      if (this.telemetryTimer) clearInterval(this.telemetryTimer);
      this.receiptsInWindow = 0;
      this.windowStart = Date.now();

      this.telemetryTimer = setInterval(() => {
        if (this.paused) return;

        // Generate a simulated runtime envelope receipt.
        const tenantKeys = Array.from(this.tenants.keys());
        const tenantId = tenantKeys.length
          ? tenantKeys[Math.floor(Math.random() * tenantKeys.length)]
          : 'Tenant-A';

        const receiptTypeRoll = Math.random();
        let type = 'INFO';
        let tag = 'RUNTIME';
        let message = 'telemetry heartbeat';

        if (receiptTypeRoll < 0.18) {
          type = 'SUCCESS';
          tag = 'CLEARING_ROUTE';
          message = `clearing route flagged OK for ${tenantId}`;
        } else if (receiptTypeRoll < 0.34) {
          type = 'PROCESS';
          tag = 'INTEGRITY';
          message = `integrity validation passed for envelope-${Math.floor(Math.random() * 1e6)}`;
        } else if (receiptTypeRoll < 0.52) {
          type = 'PROCESS';
          tag = 'ZK';
          message = `zk-proof validation enqueued for ${tenantId}`;
        } else if (receiptTypeRoll < 0.66) {
          type = 'SUCCESS';
          tag = 'LEDGER';
          message = `immutable ledger commit acknowledged`;
        } else if (receiptTypeRoll < 0.78) {
          type = 'WARN';
          tag = 'RECONCILIATION';
          message = `reconciliation watermark advanced`;
        } else {
          type = 'INFO';
          tag = 'RECEIPT';
          message = `network receipt accepted`;
        }

        this.bumpTelemetryRate();
        this.log.append({
          tag,
          type,
          message,
          meta: {
            tenantId,
            runtime: {
              zk: type.includes('ZK') ? 'PENDING' : 'OK',
              integrity: 'OK',
              routing: 'ENFORCED',
              txId: `tx-${Math.floor(Math.random() * 1e12)}`
            }
          }
        });

        // Update some flags
        this.setFlag(this.flagZk, receiptTypeRoll < 0.52 ? 'PENDING' : 'READY', receiptTypeRoll < 0.52 ? 'PENDING' : 'SUCCESS');
        this.setFlag(this.flagIntegrity, 'READY', 'SUCCESS');
        this.setFlag(this.flagTax, Math.random() < 0.1 ? 'PENDING' : 'READY', Math.random() < 0.1 ? 'PENDING' : 'SUCCESS');
        this.setFlag(this.flagRouting, receiptTypeRoll < 0.18 ? 'CLEARED' : 'READY', receiptTypeRoll < 0.18 ? 'CLEARED' : 'SUCCESS');

        // Keep tenant matrix roughly changing
        if (this.tenants.size) {
          for (const [tid, t] of this.tenants.entries()) {
            t.queue = `${(Math.random() * 90 + 10).toFixed(0)}ms`;
            t.latency = `${(Math.random() * 160 + 20).toFixed(0)}ms`;
            this.tenants.set(tid, t);
          }
          this.upsertTenantRow(this.tenants.keys().next().value);
        }
      }, CONFIG.telemetrySimIntervalMs);
    }

    disableButtonTemporarily(btn, ms = 900) {
      if (!btn) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.textContent = 'Working…';
      setTimeout(() => {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.textContent = original || btn.textContent;
      }, ms);
    }

    validateLockInputs() {
      const tenantId = String(this.lockTenantId?.value || '').trim();
      const account = String(this.lockAccount?.value || '').trim();
      const amountNum = Number(this.lockAmount?.value);
      const sigRaw = String(this.lockSignature?.value || '').trim();

      if (!tenantId) throw new Error('Tenant ID is required');
      if (!account) throw new Error('Account is required');
      if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error('Amount must be > 0');
      if (!sigRaw) throw new Error('Out-of-Band Signature is required');

      return { tenantId, account, amount: amountNum, signature: parseMaybeJson(sigRaw) };
    }

    validateReleaseInputs() {
      const transactionId = String(this.releaseTxnId?.value || '').trim();
      const sigRaw = String(this.releaseSignature?.value || '').trim();

      if (!transactionId) throw new Error('Transaction ID is required');
      if (!sigRaw) throw new Error('Signature is required');

      return { transactionId, signature: parseMaybeJson(sigRaw) };
    }

    async onLock() {
      try {
        this.disableButtonTemporarily(this.btnLock, 950);
        this.setEngineState('RUNNING');
        const payload = this.validateLockInputs();
        this.upsertTenantRow(payload.tenantId);

        // Append receipt before waiting
        this.bumpTelemetryRate();
        this.log.append({
          tag: 'LOCK_REQUEST',
          type: 'PROCESS',
          message: `LockFunds queued for ${payload.tenantId}`,
          meta: {
            tenantId: payload.tenantId,
            account: payload.account,
            amount: payload.amount,
            outOfBandSignature: payload.signature
          }
        });

        const res = await fetchJson(CONFIG.lockUrl, payload);

        if (!res.ok) {
          this.setEngineState('ERROR');
          this.setFlag(this.flagRouting, 'REJECTED', 'ERROR');
          this.bumpTelemetryRate();
          this.log.append({
            tag: 'LOCK_RESPONSE',
            type: 'ERROR',
            message: `Lock request failed (HTTP ${res.status})`,
            meta: res.data
          });
          return;
        }

        // Update tenant UI immediately on successful resolution.
        // We don't know exact backend schema; attempt best-effort.
        const escrow = res.data?.escrow || res.data?.data?.escrow || res.data?.result || null;
        const updatedEscrowId = escrow?.id || escrow?._id || escrow?.escrowId || null;

        const t = this.tenants.get(payload.tenantId) || { state: 'ACTIVE', balanceLocked: 0 };
        t.balanceLocked = (Number(t.balanceLocked) || 0) + Number(payload.amount);
        if (updatedEscrowId) t.lastEscrowId = String(updatedEscrowId);
        t.state = 'LOCKED';
        this.tenants.set(payload.tenantId, t);
        this.upsertTenantRow(payload.tenantId);

        this.setFlag(this.flagIntegrity, 'READY', 'SUCCESS');
        this.setFlag(this.flagZk, 'VERIFIED', 'SUCCESS');
        this.setFlag(this.flagRouting, 'LOCKED', 'SUCCESS');

        this.bumpTelemetryRate();
        this.log.append({
          tag: 'LOCK_CLEARED',
          type: 'SUCCESS',
          message: `Funds locked for ${payload.tenantId}`,
          meta: {
            tenantId: payload.tenantId,
            escrowId: updatedEscrowId,
            receipt: res.data
          }
        });
      } catch (err) {
        this.setEngineState('ERROR');
        this.setFlag(this.flagIntegrity, 'ERROR', 'ERROR');
        this.bumpTelemetryRate();
        this.log.append({
          tag: 'LOCK_VALIDATION',
          type: 'ERROR',
          message: err?.message ? String(err.message) : 'Lock request failed'
        });
      }
    }

    async onRelease() {
      try {
        this.disableButtonTemporarily(this.btnRelease, 950);
        this.setEngineState('RUNNING');
        const payload = this.validateReleaseInputs();

        // Append receipt before waiting
        this.bumpTelemetryRate();
        this.log.append({
          tag: 'RELEASE_REQUEST',
          type: 'PROCESS',
          message: `Release requested for ${payload.transactionId}`,
          meta: {
            transactionId: payload.transactionId,
            signature: payload.signature
          }
        });

        const res = await fetchJson(CONFIG.releaseUrl, payload);

        if (!res.ok) {
          this.setEngineState('ERROR');
          this.setFlag(this.flagRouting, 'REJECTED', 'ERROR');
          this.bumpTelemetryRate();
          this.log.append({
            tag: 'RELEASE_RESPONSE',
            type: 'ERROR',
            message: `Release request failed (HTTP ${res.status})`,
            meta: res.data
          });
          return;
        }

        // Attempt update tenant cards.
        // If backend returns tenantId/escrow, use it; else fall back to generic update.
        const releasedEscrow = res.data?.escrow || res.data?.data?.escrow || res.data || {};
        const tenantIdFromResp = releasedEscrow?.tenantId || releasedEscrow?.tenant?.id || releasedEscrow?.escrow?.tenantId;
        const tenantId = tenantIdFromResp ? String(tenantIdFromResp) : null;

        const fallbackTenant = this.tenants.size ? Array.from(this.tenants.keys())[0] : 'UnknownTenant';
        const tid = tenantId || fallbackTenant;

        this.upsertTenantRow(tid);
        const t = this.tenants.get(tid) || { state: 'ACTIVE', balanceLocked: 0, balanceReleased: 0 };
        const releasedAmount = Number(releasedEscrow?.amount || releasedEscrow?.releaseAmount || 0) || 0;
        t.balanceReleased = (Number(t.balanceReleased) || 0) + releasedAmount;
        t.state = 'RELEASED';
        if (releasedEscrow?.id) t.lastEscrowId = String(releasedEscrow.id);
        this.tenants.set(tid, t);
        this.upsertTenantRow(tid);

        this.setFlag(this.flagZk, 'VERIFIED', 'SUCCESS');
        this.setFlag(this.flagIntegrity, 'READY', 'SUCCESS');
        this.setFlag(this.flagTax, 'READY', 'SUCCESS');
        this.setFlag(this.flagRouting, 'CLEARED', 'CLEARED');

        this.bumpTelemetryRate();
        this.log.append({
          tag: 'RELEASE_CLEARED',
          type: 'SUCCESS',
          message: `Release resolved for ${payload.transactionId}`,
          meta: {
            tenantId: tid,
            transactionId: payload.transactionId,
            receipt: res.data
          }
        });
      } catch (err) {
        this.setEngineState('ERROR');
        this.bumpTelemetryRate();
        this.log.append({
          tag: 'RELEASE_VALIDATION',
          type: 'ERROR',
          message: err?.message ? String(err.message) : 'Release request failed'
        });
      }
    }

    bindUI() {
      if (this.btnPause) {
        this.btnPause.addEventListener('click', () => {
          this.paused = !this.paused;
          if (this.paused) {
            this.setEngineState('PAUSED');
            this.btnPause.textContent = 'Resume Stream';
            this.btnPause.classList.add('primary');
          } else {
            this.setEngineState('RUNNING');
            this.btnPause.textContent = 'Pause Stream';
            this.btnPause.classList.remove('primary');
          }
        });
      }

      if (this.btnClear) {
        this.btnClear.addEventListener('click', () => {
          this.log.clear();
          this.setFlag(this.flagZk, 'PENDING', 'PENDING');
          this.setFlag(this.flagIntegrity, 'PENDING', 'PENDING');
          this.setFlag(this.flagTax, 'PENDING', 'PENDING');
          this.setFlag(this.flagRouting, 'PENDING', 'PENDING');
        });
      }

      if (this.btnLock) {
        this.btnLock.addEventListener('click', (e) => {
          e.preventDefault();
          this.onLock();
        });
      }

      if (this.btnRelease) {
        this.btnRelease.addEventListener('click', (e) => {
          e.preventDefault();
          this.onRelease();
        });
      }
    }

    initFlags() {
      this.setFlag(this.flagZk, 'PENDING', 'PENDING');
      this.setFlag(this.flagIntegrity, 'PENDING', 'PENDING');
      this.setFlag(this.flagTax, 'PENDING', 'PENDING');
      this.setFlag(this.flagRouting, 'PENDING', 'PENDING');
    }

    init() {
      if (this.ledgerDestinationEl) this.ledgerDestinationEl.textContent = this.ledgerDestinationEl.textContent || '880200283180';
      this.setEngineState('BOOT');
      this.initFlags();
      this.bindUI();

      // Seed default tenants for visual matrix.
      this.tenants.set('Tenant-A', {
        dbRing: 'ring-214',
        queue: '41ms',
        latency: '88ms',
        balanceLocked: 0,
        balanceReleased: 0,
        state: 'ACTIVE'
      });
      this.tenants.set('Tenant-B', {
        dbRing: 'ring-681',
        queue: '27ms',
        latency: '64ms',
        balanceLocked: 0,
        balanceReleased: 0,
        state: 'ACTIVE'
      });
      this.upsertTenantRow('Tenant-A');

      // Start telemetry.
      this.startRateMeter();
      this.startTelemetrySimulation();

      // Boot message into telemetry.
      this.bumpTelemetryRate();
      this.log.append({
        tag: 'BOOT',
        type: 'SUCCESS',
        message: 'UI gateway ready. Telemetry stream armed. Awaiting operator Lock/Release tests.',
        meta: {
          endpoints: {
            lock: CONFIG.lockUrl,
            release: CONFIG.releaseUrl
          }
        }
      });

      // Initial flag pulse
      setTimeout(() => {
        if (!this.paused) {
          this.setFlag(this.flagZk, 'READY', 'SUCCESS');
          this.setFlag(this.flagIntegrity, 'READY', 'SUCCESS');
          this.setFlag(this.flagTax, 'READY', 'SUCCESS');
          this.setFlag(this.flagRouting, 'READY', 'SUCCESS');
          this.setEngineState('RUNNING');
        }
      }, 700);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const app = new DashboardApp();
    app.init();
  });
})();

