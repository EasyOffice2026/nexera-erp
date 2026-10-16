import { type AccessTokenClaims, accessTokenClaimsSchema } from '@nexera/shared';
import { createHash, randomBytes } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { Config } from '../config';
import { errors } from './http-errors';

const ISSUER = 'nexera-api';

export interface TokenService {
  signAccessToken(claims: AccessTokenClaims): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

export function createTokenService(config: Config): TokenService {
  const key = new TextEncoder().encode(config.accessToken.secret);

  return {
    signAccessToken({ sub, ...claims }) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${config.accessToken.ttlSeconds}s`)
        .sign(key);
    },

    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
        return accessTokenClaimsSchema.parse(payload);
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) throw errors.tokenExpired();
        throw errors.unauthenticated();
      }
    },
  };
}

// Refresh tokens are random, and only their hash is stored, so a copy of the database
// does not give anyone a working token.
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
