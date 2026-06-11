import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from '../Store.js';

type UserRow = { username: string; password_hash: string };

const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const SCRYPT_KEYLEN = 64;

export class AdminStore extends Store {
  getUserByUsername(username: string): UserRow | undefined {
    return Store.db
      .prepare(`SELECT username, password_hash FROM users WHERE username = ?`)
      .get(username) as UserRow | undefined;
  }

  createUser(username: string, password: string): void {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
    Store.db
      .prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`)
      .run(username, `${salt.toString('hex')}:${hash}`);
  }

  static verifyPassword(password: string, storedHash: string): boolean {
    const [saltHex, hash] = storedHash.split(':');
    if (!saltHex || !hash) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return timingSafeEqual(hashBuf, derived);
  }
}
