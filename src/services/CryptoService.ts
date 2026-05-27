import crypto from 'crypto';

export class CryptoService {
  /**
   * Verifies a SHA256 hex signature against a provided PUBLIC KEY PEM string.
   * Returns true iff the hex signature is cryptographically valid.
   */
  public static verifySignature(
    data: string,
    signatureHex: string,
    publicKeyPem: string
  ): boolean {
    if (!data || !signatureHex || !publicKeyPem) return false;

    try {
      // Strict validation of hex signature input.
      if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
        return false;
      }

      const signatureBytes = Buffer.from(signatureHex, 'hex');
      if (signatureBytes.length === 0) return false;

      // Establish a verification "stream" using sha256.
      const verifier = crypto.createVerify('sha256');
      verifier.update(Buffer.from(data, 'utf8'));
      verifier.end();

      // verify() returns boolean and throws on malformed PEM/keys.
      return verifier.verify(publicKeyPem, signatureBytes);
    } catch {
      return false;
    }
  }
}

