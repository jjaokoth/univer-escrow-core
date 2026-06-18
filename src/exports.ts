/**
 * Universal Trust Layer - Public API Surface
 */

import { bootstrap, shutdown, type BootstrapConfig, type BootstrapState } from './index.js';
import { DatabaseService, type EscrowRecord, type EscrowStatus } from './services/DatabaseService.js';
import { LedgerAuditor } from './services/LedgerAuditor.js';
import { EnclaveMerkleAccumulator } from './services/merkle/EnclaveMerkleAccumulator.js';
import { ZkInclusionVerifier } from './services/merkle/ZkInclusionVerifier.js';
import { EnclaveBftVerifyEngine, type StateTransitionProposal, type VerificationShare, type ThresholdMultiSigPayload, type NodeId } from './services/consensus/EnclaveBftVerifyEngine.js';
import { EnclaveRaftEngine } from './services/consensus/EnclaveRaftEngine.js';
import { EnclaveClusterService } from './services/consensus/EnclaveClusterService.js';
import { EnclaveSnapshotManager } from './services/consensus/EnclaveSnapshotManager.js';
import { EnclaveReconciliationEngine } from './services/consensus/EnclaveReconciliationEngine.js';
import { EnclaveTimeAnchorService, type MedianTimeAnchor } from './services/consensus/EnclaveTimeAnchorService.js';
import { EnclaveSealingEngine, type EncryptedSealedBlob, type SealingPolicy } from './services/cryptography/EnclaveSealingEngine.js';
import { EnclaveKeyRotator } from './services/cryptography/EnclaveKeyRotator.js';
import { EnclaveRecoveryEngine } from './services/cryptography/EnclaveRecoveryEngine.js';
import { EnclaveLogShield, type RedactedToken } from './services/security/EnclaveLogShield.js';
import { ConfidentialBaseError, getConfidentialErrorPayload, type ConfidentialErrorPayload } from './services/security/EnclaveErrors.js';
import { EnclaveClientPuzzleEngine, type EnclaveClientPuzzleChallenge, type EnclavePuzzleSolution } from './services/security/EnclaveClientPuzzleEngine.js';
import { AttestationFactory } from './services/infrastructure/AttestationFactory.js';
import { EnclaveProvisioner } from './services/infrastructure/EnclaveProvisioner.js';
import { EnclaveBridgeService } from './services/EnclaveBridgeService.js';
import { antiDosChallengeMiddleware } from './middleware/AntiDosMiddleware.js';
import { logShieldErrorInterceptor } from './middleware/LogShieldMiddleware.js';

// Re-export all
export { bootstrap, shutdown, type BootstrapConfig };
export type { BootstrapState };
export { DatabaseService, type EscrowRecord, type EscrowStatus };
export { LedgerAuditor };
export { EnclaveMerkleAccumulator };
export { ZkInclusionVerifier };
export { EnclaveBftVerifyEngine, type StateTransitionProposal, type VerificationShare, type ThresholdMultiSigPayload, type NodeId };
export { EnclaveRaftEngine };
export { EnclaveClusterService };
export { EnclaveSnapshotManager };
export { EnclaveReconciliationEngine };
export { EnclaveTimeAnchorService, type MedianTimeAnchor };
export { EnclaveSealingEngine, type EncryptedSealedBlob, type SealingPolicy };
export { EnclaveKeyRotator };
export { EnclaveRecoveryEngine };
export { EnclaveLogShield, type RedactedToken };
export { ConfidentialBaseError, getConfidentialErrorPayload, type ConfidentialErrorPayload };
export { EnclaveClientPuzzleEngine, type EnclaveClientPuzzleChallenge, type EnclavePuzzleSolution };
export { AttestationFactory };
export { EnclaveProvisioner };
export { EnclaveBridgeService };
export { antiDosChallengeMiddleware };
export { logShieldErrorInterceptor };

// Public Types
export interface TrustClusterConfig {
  nodeId: string;
  clusterSize: number;
  sealing: { cpuMasterSecret: string; mrsigner: string; mrenclave: string };
  port: number;
  antiDosDifficulty: number;
}

export interface CommitResult {
  success: boolean;
  transactionId: string;
  rootHash: string;
  quorum: number;
  consensusTerm: number;
}

export interface QueryResult {
  record: EscrowRecord | null;
  merkleProof?: { leafHash: string; proof: string[]; rootHash: string };
}

export interface HealthStatus {
  status: 'UP' | 'DEGRADED' | 'DOWN';
  state: BootstrapState;
  merkleRoot?: string;
  timestamp: string;
}
