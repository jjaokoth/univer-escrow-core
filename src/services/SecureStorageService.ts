export type SessionVerificationToken = string;

type KeychainModule = {
  setGenericPassword: (
    service: string,
    password: string,
    options?: { service?: string }
  ) => Promise<void>;
  getGenericPassword: (options: { service: string }) => Promise<{ password?: string } | null>;
  resetGenericPassword: (options: { service: string }) => Promise<void>;
};

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertKeychainLoaded(value: unknown): asserts value is KeychainModule {
  if (!value || typeof value !== "object") {
    throw new Error("react-native-keychain is not available in this runtime");
  }
}

async function loadKeychain(): Promise<KeychainModule> {
  const mod = await import("react-native-keychain");
  assertKeychainLoaded(mod);
  return mod as unknown as KeychainModule;
}

export class SecureStorageService {
  constructor(private readonly accountId: string = "univer-escrow-session") {
    assertNonEmptyString(accountId, "accountId");
  }

  async lock(token: SessionVerificationToken): Promise<void> {
    assertNonEmptyString(token, "token");

    const Keychain = await loadKeychain();
    await Keychain.setGenericPassword(this.accountId, token, {
      service: this.accountId
    });
  }

  async retrieve(): Promise<SessionVerificationToken | null> {
    const Keychain = await loadKeychain();
    const result = await Keychain.getGenericPassword({ service: this.accountId });

    if (!result) return null;
    if (typeof result.password !== "string" || result.password.trim().length === 0) return null;

    return result.password;
  }

  async wipe(): Promise<void> {
    const Keychain = await loadKeychain();
    await Keychain.resetGenericPassword({ service: this.accountId });
  }
}

