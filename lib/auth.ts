import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import type { User } from './types';

const SECRET_KEY = process.env.AUTH_SECRET || 'upgraide-secret-key-change-in-production';
const key = new TextEncoder().encode(SECRET_KEY);

export async function encrypt(payload: User): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(key);
}

export async function decrypt(token: string): Promise<User | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    return payload as User;
  } catch {
    return null;
  }
}

export async function createSession(username: string): Promise<void> {
  const user: User = { username };
  const token = await encrypt(user);
  const cookieStore = await cookies();
  cookieStore.set('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    path: '/',
  });
}

export async function getSession(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('session')?.value;
  if (!token) return null;
  return decrypt(token);
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete('session');
}

export function validateCredentials(username: string, password: string): boolean {
  return username === 'admin' && password === 'portline2024';
}
