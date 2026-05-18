import crypto from 'crypto';
import type { IPaymentProvider } from '../core/IPaymentProvider';
import { EscrowStatus } from '../core/EscrowState';

// Firestore Admin SDK is required for production. The scaffold keeps imports
// local-safe for compilation.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const admin = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // @ts-ignore
    return require('firebase-admin');
  } catch {
    return null;
  }
})();

type Firestore = any;

type AuditTrailEntry = {
  createdAt: Date;

  oldState: EscrowStatus;
  newState: EscrowStatus;
  integrityHash: string;
  mutationReason?: string;
};

export type UpdateStatusInput = {
  escrowId: string;
  nextStatus: EscrowStatus;
  provider: IPaymentProvider;
  mutationReason?: string;
  transactionId?: string;
};

function getMasterKey(): string {
  const k = process.env.ENV_MASTER_KEY ?? process.env.MASTER_INTEGRITY_KEY;
  if (!k) throw new Error('ENV_MASTER_KEY_MISSING');
  return k;
}

function computeMutationIntegrityHash(args: {
  escrowId: string;
  oldState: EscrowStatus;
  newState: EscrowStatus;
  timestamp: string;
  masterKey: string;
}): string {
  const payload = `${args.escrowId}:${args.oldState}:${args.newState}:${args.timestamp}`;
  return crypto.createHmac('sha256', args.masterKey).update(payload).digest('hex');
}

function isTerminalStatus(status: EscrowStatus) {
  return status === EscrowStatus.RELEASED || status === EscrowStatus.REFUNDED;
}

function assertStateRules(args: { oldState: EscrowStatus; nextStatus: EscrowStatus }) {
  const { oldState, nextStatus } = args;

  // Terminal locking: no transitions out of terminal states.
  if (isTerminalStatus(oldState)) {
    throw new Error(`INVALID_STATE_TRANSITION_${oldState}_TO_${nextStatus}`);
  }

  // Enforce LOCKED rule: only allow transition to LOCKED if cryptographically verified.
  // (Verification is done in updateStatus by calling provider.verifyTransaction.)
  // Therefore, this assertion only checks that LOCKED isn't reached directly from an invalid old state.
  if (nextStatus === EscrowStatus.LOCKED) {
    if (oldState !== EscrowStatus.PENDING) {
      throw new Error(`INVALID_STATE_TRANSITION_${oldState}_TO_LOCKED`);
    }
  }
}

function initFirestore(): Firestore {
  if (!admin) {
    throw new Error('FIREBASE_ADMIN_MISSING');
  }

  const appOptions: any = {};
  if (process.env.FIREBASE_PROJECT_ID) {
    appOptions.projectId = process.env.FIREBASE_PROJECT_ID;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    appOptions.credential = admin.credential.applicationDefault();
  }

  if (!admin.apps.length) {
    admin.initializeApp(appOptions);
  }

  return admin.firestore() as Firestore;
}

export class EscrowService {
  constructor(private paymentProviderResolver: (providerType: string) => IPaymentProvider) {}

  // Public API mandated by WebhookController
  async updateStatus(input: UpdateStatusInput): Promise<void> {
    // Strict state engine implementation
    return this.updateStatusAtomic(input);
  }

  // Minimal phase-1 orchestration stub kept for compatibility.
  async initiate(params: {


    providerType: string;
    amount: number;
    currency: string;
    metadata: any;
  }): Promise<{ status: EscrowStatus; payment: any }> {
    const provider = this.paymentProviderResolver(params.providerType);
    const payment = await provider.initializePayment(params.amount, params.currency, params.metadata);
    const status = payment?.status === 'SUCCESS' ? EscrowStatus.RELEASED : EscrowStatus.LOCKED;
    return { status, payment };
  }

  /**
   * updateStatusAtomic - strict state engine with atomic Firestore transactions
   * and an immutable audit trail.
   */
  private async updateStatusAtomic(input: UpdateStatusInput): Promise<void> {

    const firestore = initFirestore();
    const { escrowId, nextStatus, provider, mutationReason, transactionId } = input;
    const masterKey = getMasterKey();

    const escrowRef = firestore.collection('escrows').doc(escrowId);
    const auditRef = escrowRef.collection('audit_trail');

    await firestore.runTransaction(async (tx: any) => {
      const snap = await tx.get(escrowRef);
      if (!snap.exists) {
        throw new Error('ESCROW_NOT_FOUND');
      }

      const data = snap.data() as any;
      const oldState = data.status as EscrowStatus;

      assertStateRules({ oldState, nextStatus });

      // LOCKED cryptographic verification rule.
      if (nextStatus === EscrowStatus.LOCKED) {
        const token = transactionId ?? data.transactionId;
        if (!token) {
          throw new Error('NO_TRANSACTION_ID_FOR_LOCKED');
        }
        const verified = await provider.verifyTransaction(token);
        if (!verified) {
          throw new Error('LOCKED_REQUIRES_VERIFIED_PAYMENT');
        }
      }

      // Terminal rule already enforced by assertStateRules.
      // Perform update.
      const now = new Date();
      const timestamp = now.toISOString();

      const integrityHash = computeMutationIntegrityHash({
        escrowId,
        oldState,
        newState: nextStatus,
        timestamp,
        masterKey,
      });

      // Update parent document.
      const updatePayload: Record<string, any> = {
        status: nextStatus,
        updatedAt: now,
        ...(nextStatus === EscrowStatus.LOCKED ? { lockedAt: now } : {}),
        ...(nextStatus === EscrowStatus.DISPUTED ? { disputeReason: mutationReason ?? 'DISPUTED' } : {}),
        ...(nextStatus === EscrowStatus.RELEASED ? { releasedAt: now } : {}),
        ...(nextStatus === EscrowStatus.REFUNDED ? { refundedAt: now } : {}),
        ...(transactionId ? { transactionId } : {}),
      };

      tx.update(escrowRef, updatePayload);

      const audit: AuditTrailEntry = {
        createdAt: now,
        oldState,
        newState: nextStatus,
        integrityHash,
        mutationReason,
      };

      // Immutable audit record.
      const auditDoc = auditRef.doc();
      tx.set(auditDoc, audit as any);
    });
  }
}


