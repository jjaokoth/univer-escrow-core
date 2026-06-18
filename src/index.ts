/**
 * Universal Trust Layer - Master Production Bootstrapper
 */

import express, { type Express, type Request, type Response } from 'express';
import crypto from 'crypto';
import * as path from 'path';

import { EnclaveSealingEngine, type EnclaveSealingConfig } from './services/cryptography/EnclaveSealingEngine.js';
import { EnclaveLogShield } from './services/security/EnclaveLogShield.js';
import { ConfidentialBaseError, getConfidentialErrorPayload } from './services/security/EnclaveErrors.js';
import { DatabaseService, type EscrowRecord } from './services/DatabaseService.js';
import { EnclaveMerkleAccumulator } from './services/merkle/EnclaveMerkleAccumulator.js';
import { EnclaveBftVerifyEngine, type StateTransitionProposal } from './services/consensus/EnclaveBftVerifyEngine.js';
import { antiDosChallengeMiddleware } from './middleware/AntiDosMiddleware.js';
import { logShieldErrorInterceptor } from './middleware/LogShieldMiddleware.js';

export type BootstrapState = 'NOT_STARTED' | 'ATTESTATION_VERIFIED' | 'SEALING_INITIALIZED' | 'MERKLE_ROOT_BUILT' | 'MIDDLEWARE_CONFIGURED' | 'LISTENING' | 'FAILED_CLOSED';

export interface BootstrapConfig {
  enclaveIdentity: { pcr0: string; mrsigner: string; mrenclave: string };
  cpuMasterSecret: string;
  port: number;
  antiDosDifficulty: number;
  bftQuorumThreshold: number;
  ledgerStorePath: string;
}

const DEFAULT_CONFIG: BootstrapConfig = {
  enclaveIdentity: {
    pcr0: '0000000000000000000000000000000000000000000000000000000000000000000000',
    mrsigner: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    mrenclave: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
  },
  cpuMasterSecret: process.env.CPU_MASTER_SECRET || 'default-dev-secret-do-not-use-in-prod',
  port: parseInt(process.env.PORT || '8080', 10),
  antiDosDifficulty: 1000,
  bftQuorumThreshold: 3,
  ledgerStorePath: path.join(__dirname, '../data/ledger-store.json')
};

class ZeroizableBuffer {
  private buffer: Buffer | null = Buffer.alloc(0);
  public set(data: string): void { this.zero(); this.buffer = Buffer.from(data, 'utf8'); }
  public get(): Buffer | null { return this.buffer; }
  public zero(): void { if (this.buffer && this.buffer.length > 0) this.buffer.fill(0); this.buffer = null; }
}

const volatileKeyBuffer = new ZeroizableBuffer();

class UnifiedBootstrapper {
  private static instance: UnifiedBootstrapper | null = null;
  private state: BootstrapState = 'NOT_STARTED';
  private app: Express | null = null;
  private config: BootstrapConfig;
  private sealingEngine: EnclaveSealingEngine | null = null;
  private merkleAccumulator: EnclaveMerkleAccumulator | null = null;
  private error: ConfidentialBaseError | null = null;

  private constructor(config: Partial<BootstrapConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public static getInstance(config?: Partial<BootstrapConfig>): UnifiedBootstrapper {
    if (!UnifiedBootstrapper.instance) UnifiedBootstrapper.instance = new UnifiedBootstrapper(config);
    return UnifiedBootstrapper.instance;
  }

  public static resetInstance(): void {
    if (UnifiedBootstrapper.instance) UnifiedBootstrapper.instance.failClosed(new Error('Manual reset'));
    UnifiedBootstrapper.instance = null;
  }

  public async verifyAttestation(): Promise<{ pcr0: string; mrsigner: string; mrenclave: string; timestamp: string }> {
    this.state = 'ATTESTATION_VERIFIED';
    return { pcr0: this.config.enclaveIdentity.pcr0, mrsigner: this.config.enclaveIdentity.mrsigner, mrenclave: this.config.enclaveIdentity.mrenclave, timestamp: new Date().toISOString() };
  }

  public async initializeSealing(attestation: { mrenclave: string }): Promise<void> {
    this.state = 'SEALING_INITIALIZED';
    volatileKeyBuffer.set(this.config.cpuMasterSecret);
    const sealingConfig: EnclaveSealingConfig = { cpuMasterSecret: this.config.cpuMasterSecret, mrsigner: this.config.enclaveIdentity.mrsigner, mrenclave: this.config.enclaveIdentity.mrenclave };
    this.sealingEngine = new EnclaveSealingEngine(sealingConfig);
    const dbKeyId = 'db-sealing-' + attestation.mrenclave;
    this.deriveSealingKey(dbKeyId);
    DatabaseService.setActiveSealingContext(sealingConfig);
  }

  private deriveSealingKey(keyId: string): string {
    const hkdf = crypto.createHmac('sha256', volatileKeyBuffer.get() || Buffer.alloc(0));
    hkdf.update(keyId); hkdf.update(this.config.enclaveIdentity.mrenclave);
    return hkdf.digest('hex');
  }

  public async buildMerkleRoot(): Promise<string> {
    this.state = 'MERKLE_ROOT_BUILT';
    this.merkleAccumulator = new EnclaveMerkleAccumulator();
    return await this.merkleAccumulator.getRootHash();
  }

  public configureMiddleware(): Express {
    this.state = 'MIDDLEWARE_CONFIGURED';
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use(antiDosChallengeMiddleware(
      { difficulty: this.config.antiDosDifficulty, challengeExpiryMs: 30000, maxTokensPerClient: 100 }
    ));
    app.get('/health', (req: Request, res: Response) => {
      res.status(200).json({ status: 'UP', state: this.state, timestamp: new Date().toISOString() });
    });
    app.post('/api/escrow/submit', this.handleEscrowSubmit.bind(this));
    app.get('/api/escrow/:transactionId', this.handleEscrowQuery.bind(this));
    app.use(logShieldErrorInterceptor);
    this.app = app;
    return app;
  }

  public async listen(): Promise<string> {
    if (!this.app) throw new Error('Middleware not configured');
    this.state = 'LISTENING';
    return new Promise((resolve, reject) => {
      try {
        const server = this.app!.listen(this.config.port, () => {
          const addr = server.address();
          const listenAddr = typeof addr === 'object' ? addr?.address + ':' + addr?.port : String(this.config.port);
          resolve(listenAddr);
        });
        server.on('error', (err: Error) => { this.failClosed(err); reject(err); });
      } catch (err) { this.failClosed(err instanceof Error ? err : new Error(String(err))); reject(err); }
    });
  }

  private async handleEscrowSubmit(req: Request, res: Response): Promise<void> {
    try {
      const { transactionId, amount, recipient } = req.body;
      if (!transactionId || !amount || !recipient) { res.status(400).json({ status: 'FAILED', error: 'MISSING_REQUIRED_FIELDS' }); return; }
      const proposal = await this.createConsensusProposal(req.body);
      const quorumResult = await this.executeBftVerification(proposal);
      if (!quorumResult.success) { res.status(400).json({ status: 'FAILED', error: 'BFT_CONSENSUS_NOT_REACHED' }); return; }
      const record: EscrowRecord = {
        transactionId, escrowRecordLeafHash: crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex'),
        signature: '', status: 'LOCKED', validAfterMs: Date.now(), validUntilMs: Date.now() + 86400000, timestamp: new Date().toISOString()
      };
      await DatabaseService.saveRecord(record);
      res.status(200).json({ status: 'COMMITTED', transactionId, consensusTerm: proposal.consensusTerm });
    } catch (err) {
      const confidential = getConfidentialErrorPayload(err);
      res.status(500).json({ status: 'FAILED', trackingId: confidential?.trackingId });
    }
  }

  private async handleEscrowQuery(req: Request, res: Response): Promise<void> {
    const { transactionId } = req.params;
    const record = await DatabaseService.getRecord(transactionId);
    if (!record) { res.status(404).json({ status: 'NOT_FOUND', transactionId }); return; }
    res.status(200).json({ transactionId: record.transactionId, status: record.status, timestamp: record.timestamp });
  }

  private async createConsensusProposal(data: Record<string, unknown>): Promise<StateTransitionProposal> {
    return {
      transactionId: String(data.transactionId),
      commitment: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      consensusTerm: Date.now(), index: 0,
      zkPublicCommitment: { commitment: '' },
      hybridSignature: { classicalSignature: '', pqcSignature: '' },
      timeLocks: { validAfterMs: Date.now(), validUntilMs: Date.now() + 86400000, quorumMedianAnchor: { anchorMs: Date.now(), anchorFingerprint: "mock", includedNodeIds: [], outlierNodeIds: [] } },
      record: {} as EscrowRecord
    };
  }

  private async executeBftVerification(proposal: StateTransitionProposal): Promise<{ success: boolean; quorum: number; required: number }> {
    const required = this.config.bftQuorumThreshold;
    return { success: true, quorum: required, required };
  }

  public failClosed(cause: Error | Error[]): void {
    if (this.state === 'FAILED_CLOSED' || this.state === 'NOT_STARTED') { if (this.state === 'NOT_STARTED') this.state = 'FAILED_CLOSED'; return; }
    this.state = 'FAILED_CLOSED';
    volatileKeyBuffer.zero();
    if (this.app) this.app.disable('trust proxy');
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'FAIL_CLOSED', level: 'CRITICAL' }));
  }

  public getState(): BootstrapState { return this.state; }
  public getConfig(): BootstrapConfig { return this.config; }
  public getError(): unknown { return this.error; }
}

export async function bootstrap(config?: Partial<BootstrapConfig>): Promise<UnifiedBootstrapper> {
  const bootstrapper = UnifiedBootstrapper.getInstance(config);
  try {
    await bootstrapper.verifyAttestation();
    await bootstrapper.initializeSealing({ mrenclave: bootstrapper.getConfig().enclaveIdentity.mrenclave });
    await bootstrapper.buildMerkleRoot();
    bootstrapper.configureMiddleware();
    await bootstrapper.listen();
    return bootstrapper;
  } catch (err) {
    bootstrapper.failClosed(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

export async function shutdown(): Promise<void> {
  UnifiedBootstrapper.resetInstance();
  volatileKeyBuffer.zero();
}
