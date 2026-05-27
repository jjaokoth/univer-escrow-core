import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface AuditPayload {
  tenantId: string;
  action: 'LOCK' | 'RELEASE';
  amount?: number;
  transactionId?: string;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
}
export class AuditLogger {
  private static logPath = path.join(__dirname, '../../logs/audit/gateway-events.jsonl');
  public static async logEvent(payload: AuditPayload): Promise<string> {
    const timestamp = new Date().toISOString();
    const hashInput = `${timestamp}|${payload.tenantId}|${payload.action}|${payload.status}`;
    const blockHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    const canonicalRecord = {
      ts: timestamp,
      ...payload,
      integritySignature: blockHash
    };
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(this.logPath, JSON.stringify(canonicalRecord) + '\n', 'utf8');
    return blockHash;
  }
}