import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_DATABASE_FILENAMES = ['ticket-ssu.sqlite', 'temp.sqlite'];
export const isDefaultDatabasePath = (root, file) => DEFAULT_DATABASE_FILENAMES.some(name =>
  resolve(file).toLowerCase() === resolve(root, 'data', name).toLowerCase());
export function defaultDatabasePath(root) {
  const paths = DEFAULT_DATABASE_FILENAMES.map(name => resolve(root, 'data', name));
  // Existing installations must never silently open a fresh database on rename.
  return paths.find(file => existsSync(file)) ?? paths[0];
}

// Old identifiers remain only for safe migration and public-demo rejection.
export const LEGACY_DEMO_ACCOUNTS = [
  { email: 'demo@temp.local', password: 'TempDemo123!', name: '김템프', role: 'user',
    nextEmail: 'demo@ticket-ssu.local', nextPassword: 'TicketSsuDemo123!', nextName: '티켓회원' },
  { email: 'admin@temp.local', password: 'TempAdmin123!', name: '운영자', role: 'admin',
    nextEmail: 'admin@ticket-ssu.local', nextPassword: 'TicketSsuAdmin123!', nextName: '운영자' }
];
export const PUBLIC_DEMO_EMAILS = LEGACY_DEMO_ACCOUNTS.flatMap(account => [account.email, account.nextEmail]);
export const LEGACY_VENUE_NAMES = [
  ['Temp 아레나 · 서울', 'ticket-ssu 아레나 · 서울'],
  ['Temp 아레나 · 인천', 'ticket-ssu 아레나 · 인천']
];
