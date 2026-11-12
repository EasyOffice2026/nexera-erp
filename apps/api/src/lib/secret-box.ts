import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Keeps a secret the ERP must send on (an integration key of another system) encrypted at rest
// with AES-256-GCM. The text is "v1.<iv>.<tag>.<ciphertext>", each part base64url.
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error('The encryption key must be 32 bytes.');
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), body]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.');
    },
    open(sealed) {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1' || !iv || !tag || !body) throw new Error('Not a sealed secret.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
