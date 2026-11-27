import type {GitAccount, GitConnectionMode} from './index.js';
import {publicGitHubAccount} from './identity.js';

/** Display-only receipts never contain a login ticket, bearer or provider credential. */
export interface GitSignOutState {
    local: 'stopped';
    session: 'pending' | 'revoked';
    github: 'unconfirmed' | 'pending' | 'token-revoked' | 'authorization-revoked';
}
export interface GitSignOutReceipt extends GitSignOutState {
    id: string;
    mode: GitConnectionMode | null;
    account?: GitAccount;
    at: number;
    retryable: boolean;
}
export interface SignOutStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
export const signOutStorageKey = 'tw-plus-pair-signouts-v1';
export function browserSignOutStorage(): SignOutStorage | undefined {
    try {return typeof document === 'object' ? globalThis.localStorage : undefined;} catch {return undefined;}
}
export function loadSignOutReceipts(storage?: SignOutStorage): GitSignOutReceipt[] {
    try {
        const raw: unknown = JSON.parse(storage?.getItem(signOutStorageKey) ?? '[]');
        if (!Array.isArray(raw)) return [];
        return raw.slice(-100).flatMap((item: Partial<GitSignOutReceipt>) => {
            if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(item.id) ||
                !['desktop', 'cloudflare', null].includes(item.mode ?? null) || item.local !== 'stopped' ||
                !['pending', 'revoked'].includes(item.session ?? '') ||
                !['unconfirmed', 'pending', 'token-revoked', 'authorization-revoked'].includes(item.github ?? '') ||
                !Number.isSafeInteger(item.at) || item.at! < 0) return [];
            const account = publicGitHubAccount(item.account);
            return [{id: item.id, mode: item.mode ?? null, local: 'stopped', session: item.session!, github: item.github!,
                at: item.at!, retryable: false,
                ...(account && {account})}];
        });
    } catch {return [];}
}
