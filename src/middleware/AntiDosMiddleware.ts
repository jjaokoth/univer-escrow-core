import type { NextFunction, Request, Response } from 'express';
import { EnclaveClientPuzzleEngine, type EnclavePuzzleSolution } from '../services/security/EnclaveClientPuzzleEngine.js';

export interface AntiDosConfig {
  difficulty: number;
  challengeExpiryMs: number;
  maxTokensPerClient: number;
}

function resolveClientId(req: Request): string {
  const body = req.body as Record<string, unknown> | undefined;
  const explicitClientId =
    String(req.get('x-client-id') ?? '') ||
    (typeof body?.tenantId === 'string' ? body.tenantId : '') ||
    (typeof body?.nodeId === 'string' ? body.nodeId : '') ||
    (typeof body?.leaderId === 'string' ? body.leaderId : '');

  if (explicitClientId && explicitClientId.trim().length > 0) {
    return explicitClientId.trim();
  }

  if (req.ip && typeof req.ip === 'string' && req.ip.trim().length > 0) {
    return req.ip;
  }

  return 'anonymous';
}

function parsePuzzleSolution(req: Request): EnclavePuzzleSolution | null {
  const raw = req.get('x-puzzle-solution') ?? req.body?.puzzleSolution;
  if (!raw) {
    return null;
  }

  if (typeof raw !== 'string') {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return payload as EnclavePuzzleSolution;
  } catch {
    return null;
  }
}

// Factory function that takes config and returns middleware
export function antiDosChallengeMiddleware(config: AntiDosConfig) {
  return function(req: Request, res: Response, next: NextFunction): void {
    const engine = EnclaveClientPuzzleEngine.getInstance();
    const clientId = resolveClientId(req);
    const requiresPuzzle = engine.recordRequest(clientId);

    if (!requiresPuzzle) {
      next();
      return;
    }

    const solution = parsePuzzleSolution(req);
    if (solution && engine.verifyPuzzleSolution(solution)) {
      next();
      return;
    }

    const challenge = engine.getOrCreateChallenge(clientId);
    res.status(429).json({
      status: 'RATE_LIMITED',
      error: 'PUZZLE_REQUIRED',
      challenge: {
        clientId: challenge.clientId,
        serverSeed: challenge.serverSeed,
        timestampMs: challenge.timestampMs,
        expiresAtMs: challenge.expiresAtMs,
        difficultyMask: challenge.difficultyMask,
        challengeHash: challenge.challengeHash
      }
    });
  };
}
