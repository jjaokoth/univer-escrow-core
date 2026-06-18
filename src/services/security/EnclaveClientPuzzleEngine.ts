import crypto from 'crypto';

export interface EnclaveClientPuzzleChallenge {
  clientId: string;
  serverSeed: string;
  timestampMs: number;
  expiresAtMs: number;
  difficultyMask: string;
  challengeHash: string;
}

export interface EnclavePuzzleSolution {
  clientId: string;
  serverSeed: string;
  timestampMs: number;
  expiresAtMs: number;
  difficultyMask: string;
  challengeHash: string;
  nonce: string;
}

export class EnclaveClientPuzzleEngine {
  private static instance: EnclaveClientPuzzleEngine | null = null;

  private readonly windowMs: number;
  private readonly maxRequestsPerWindow: number;
  private readonly challengeTtlMs: number;
  private readonly difficultyMaskValue: number;

  private currentWindowStartMs: number;
  private totalRequestsThisWindow: number;
  private readonly windowCounts: Map<string, number>;
  private readonly activeChallenges: Map<string, EnclaveClientPuzzleChallenge>;

  private constructor() {
    this.windowMs = Number(process.env.ENCLAVE_PUZZLE_WINDOW_MS ?? 10_000);
    this.maxRequestsPerWindow = Number(process.env.ENCLAVE_PUZZLE_REQUEST_THRESHOLD ?? 6);
    this.challengeTtlMs = Number(process.env.ENCLAVE_PUZZLE_TTL_MS ?? 30_000);
    this.difficultyMaskValue = Number(process.env.ENCLAVE_PUZZLE_DIFFICULTY_MASK ?? 0x0000ffff);

    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) {
      this.windowMs = 10_000;
    }

    if (!Number.isFinite(this.maxRequestsPerWindow) || this.maxRequestsPerWindow <= 0) {
      this.maxRequestsPerWindow = 6;
    }

    if (!Number.isFinite(this.challengeTtlMs) || this.challengeTtlMs <= 0) {
      this.challengeTtlMs = 30_000;
    }

    if (!Number.isFinite(this.difficultyMaskValue) || this.difficultyMaskValue < 0) {
      this.difficultyMaskValue = 0x0000ffff;
    }

    this.currentWindowStartMs = Date.now();
    this.totalRequestsThisWindow = 0;
    this.windowCounts = new Map<string, number>();
    this.activeChallenges = new Map<string, EnclaveClientPuzzleChallenge>();
  }

  public static createNewEngine(difficulty: number): EnclaveClientPuzzleEngine {
    const instance = new EnclaveClientPuzzleEngine();
    (instance as any).difficultyMaskValue = difficulty;
    return instance;
  }

  public static getInstance(): EnclaveClientPuzzleEngine {
    if (!EnclaveClientPuzzleEngine.instance) {
      EnclaveClientPuzzleEngine.instance = new EnclaveClientPuzzleEngine();
    }
    return EnclaveClientPuzzleEngine.instance;
  }

  public recordRequest(clientId: string): boolean {
    const normalizedClientId = this.normalizeClientId(clientId);
    this.advanceWindowIfNeeded();

    this.totalRequestsThisWindow += 1;
    const currentCount = this.windowCounts.get(normalizedClientId) ?? 0;
    this.windowCounts.set(normalizedClientId, currentCount + 1);

    return this.isUnderPressure(normalizedClientId);
  }

  public isUnderPressure(clientId: string): boolean {
    const normalizedClientId = this.normalizeClientId(clientId);
    const clientCount = this.windowCounts.get(normalizedClientId) ?? 0;
    const globalThreshold = this.maxRequestsPerWindow * 3;
    return clientCount > this.maxRequestsPerWindow || this.totalRequestsThisWindow > globalThreshold;
  }

  public generateChallenge(clientId: string): EnclaveClientPuzzleChallenge { return this.getOrCreateChallenge(clientId); }

  public getOrCreateChallenge(clientId: string): EnclaveClientPuzzleChallenge {
    const normalizedClientId = this.normalizeClientId(clientId);
    const existing = this.activeChallenges.get(normalizedClientId);

    if (existing && existing.expiresAtMs > Date.now()) {
      return existing;
    }

    const challenge = this.createChallenge(normalizedClientId);
    this.activeChallenges.set(normalizedClientId, challenge);
    return challenge;
  }

  public verifyPuzzleSolution(solution: EnclavePuzzleSolution): boolean {
    if (!this.isValidPuzzleSolution(solution)) {
      return false;
    }

    const normalizedClientId = this.normalizeClientId(solution.clientId);
    const storedChallenge = this.activeChallenges.get(normalizedClientId);
    if (!storedChallenge) {
      return false;
    }

    if (
      storedChallenge.challengeHash !== solution.challengeHash ||
      storedChallenge.serverSeed !== solution.serverSeed ||
      storedChallenge.timestampMs !== solution.timestampMs ||
      storedChallenge.expiresAtMs !== solution.expiresAtMs ||
      storedChallenge.difficultyMask !== solution.difficultyMask
    ) {
      return false;
    }

    if (Date.now() > storedChallenge.expiresAtMs || Date.now() > solution.expiresAtMs) {
      this.activeChallenges.delete(normalizedClientId);
      return false;
    }

    const digest = crypto.createHash('sha256')
      .update(`${storedChallenge.challengeHash}${solution.nonce}`, 'utf8')
      .digest();

    const leadingBits = digest.readUInt32BE(0);
    const valid = (leadingBits & this.difficultyMaskValue) === 0;

    if (valid) {
      this.activeChallenges.delete(normalizedClientId);
    }

    return valid;
  }

  private createChallenge(clientId: string): EnclaveClientPuzzleChallenge {
    const timestampMs = Date.now();
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const challengeHash = crypto.createHash('sha256')
      .update(`${serverSeed}${clientId}${String(timestampMs)}`, 'utf8')
      .digest('hex');

    return {
      clientId,
      serverSeed,
      timestampMs,
      expiresAtMs: timestampMs + this.challengeTtlMs,
      difficultyMask: this.difficultyMaskHex,
      challengeHash
    };
  }

  private advanceWindowIfNeeded(): void {
    const now = Date.now();
    if (now - this.currentWindowStartMs < this.windowMs) {
      return;
    }

    this.currentWindowStartMs = now;
    this.totalRequestsThisWindow = 0;
    this.windowCounts.clear();
    this.activeChallenges.clear();
  }

  private normalizeClientId(clientId: string | undefined | null): string {
    const candidate = String(clientId ?? 'anonymous').trim();
    return candidate.length > 0 ? candidate : 'anonymous';
  }

  private get difficultyMaskHex(): string {
    return `0x${this.difficultyMaskValue.toString(16).padStart(8, '0')}`;
  }

  private isValidPuzzleSolution(value: unknown): value is EnclavePuzzleSolution {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as EnclavePuzzleSolution;
    return (
      typeof candidate.clientId === 'string' &&
      typeof candidate.serverSeed === 'string' &&
      typeof candidate.timestampMs === 'number' &&
      typeof candidate.expiresAtMs === 'number' &&
      typeof candidate.difficultyMask === 'string' &&
      typeof candidate.challengeHash === 'string' &&
      typeof candidate.nonce === 'string'
    );
  }
}
