import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Passwords and PINs are hashed with scrypt, which is built into Node. It needs no native
// package and runs off the main thread. "standard" follows the OWASP recommendation
// (N=2^15, r=8, p=3, about 32 MiB per hash). "fast" is for tests only.
export interface HashProfile {
  logN: number;
  r: number;
  p: number;
}

export const hashProfiles = {
  standard: { logN: 15, r: 8, p: 3 },
  fast: { logN: 10, r: 8, p: 1 },
} as const satisfies Record<string, HashProfile>;

export type HashProfileName = keyof typeof hashProfiles;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(secret: string, salt: Buffer, { logN, r, p }: HashProfile): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    // NFKC makes the same text from different keyboards (for example Arabic) hash the same.
    scrypt(
      secret.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N, r, p, maxmem: 256 * N * r },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

// Stored form: scrypt$<logN>$<r>$<p>$<salt base64>$<key base64>. The parameters travel with the
// hash, so old hashes keep working after the profile changes.
function parse(stored: string): { profile: HashProfile; salt: Buffer; key: Buffer } | null {
  const [scheme, logN, r, p, salt, key, ...rest] = stored.split('$');
  if (scheme !== 'scrypt' || !key || rest.length > 0) return null;

  const profile = { logN: Number(logN), r: Number(r), p: Number(p) };
  const valid =
    Number.isInteger(profile.logN) &&
    profile.logN >= 8 &&
    profile.logN <= 20 &&
    Number.isInteger(profile.r) &&
    profile.r >= 1 &&
    profile.r <= 32 &&
    Number.isInteger(profile.p) &&
    profile.p >= 1 &&
    profile.p <= 16;
  if (!valid) return null;

  return { profile, salt: Buffer.from(salt ?? '', 'base64'), key: Buffer.from(key, 'base64') };
}

export interface PasswordHasher {
  hash(secret: string): Promise<string>;
  verify(secret: string, storedHash: string): Promise<boolean>;
  // Spends the time of a real check, so an unknown account cannot be told apart by timing.
  verifyDummy(secret: string): Promise<void>;
}

export function createPasswordHasher(profile: HashProfile): PasswordHasher {
  let dummyHash: Promise<string> | undefined;

  const hasher: PasswordHasher = {
    async hash(secret) {
      const salt = randomBytes(SALT_LENGTH);
      const key = await derive(secret, salt, profile);
      return `scrypt$${profile.logN}$${profile.r}$${profile.p}$${salt.toString('base64')}$${key.toString('base64')}`;
    },

    async verify(secret, storedHash) {
      const parsed = parse(storedHash);
      if (!parsed || parsed.key.length !== KEY_LENGTH) return false;

      const key = await derive(secret, parsed.salt, parsed.profile);
      return timingSafeEqual(key, parsed.key);
    },

    async verifyDummy(secret) {
      dummyHash ??= hasher.hash('timing-equalizer');
      await hasher.verify(secret, await dummyHash);
    },
  };

  return hasher;
}
