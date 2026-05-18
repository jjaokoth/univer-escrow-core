Univer-Escrow ApiKeyService

- Stores only salted+hashed secret keys.
- Never stores raw secret keys in Firestore.
- Returns raw secretKey to caller once at provisioning time.

