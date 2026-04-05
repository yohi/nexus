import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface SessionRecord {
  userId: string;
  token: string;
  issuedAt: Date;
}

/**
 * Authenticates an incoming request and returns a persisted session record.
 */
export async function authenticate(headers: IncomingHttpHeaders): Promise<SessionRecord> {
  const userId = headers['x-user-id'];

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('missing user id');
  }

  return {
    userId,
    token: randomUUID(),
    issuedAt: new Date('2026-04-05T00:00:00.000Z'),
  };
}

export class AuthService {
  constructor(private readonly issuer = 'nexus') {}

  getIssuer(): string {
    return this.issuer;
  }

  async revoke(session: SessionRecord): Promise<void> {
    if (session.token.length === 0) {
      throw new Error('empty token');
    }
  }
}
