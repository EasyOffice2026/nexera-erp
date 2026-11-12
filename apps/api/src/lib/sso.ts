import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, importPKCS8, type JWK, SignJWT } from 'jose';

// Single sign-on into the other parts of the platform (the POS): a ticket signed with the ERP's
// Ed25519 key, good for one minute, that the other system checks against /api/v1/sso/jwks.json.
export interface SsoSigner {
  jwks(): Promise<{ keys: JWK[] }>;
  ticket(input: { email: string; audience: string }): Promise<string>;
}

const KID = 'nexera-sso-1';

// Without a configured key (development and tests) a new key is made at start.
export function createSsoSigner(options: { issuer: string; privateKeyPem: string | undefined }) {
  const keys = (async () => {
    if (options.privateKeyPem) {
      const privateKey = await importPKCS8(options.privateKeyPem, 'EdDSA', { extractable: true });
      const jwk = await exportJWK(privateKey);
      return { privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JWK };
    }
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  })();

  const signer: SsoSigner = {
    async jwks() {
      const { publicJwk } = await keys;
      return { keys: [{ ...publicJwk, kid: KID, alg: 'EdDSA', use: 'sig' }] };
    },
    async ticket({ email, audience }) {
      const { privateKey } = await keys;
      return new SignJWT({ email })
        .setProtectedHeader({ alg: 'EdDSA', kid: KID })
        .setIssuer(options.issuer)
        .setAudience(audience)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime('60s')
        .sign(privateKey);
    },
  };
  return signer;
}
