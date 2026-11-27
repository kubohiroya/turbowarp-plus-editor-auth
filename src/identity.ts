import type {GitAccount} from './index.js';

export const isGitHubUserId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export function publicGitHubAccount(value: unknown): GitAccount | null {
    if (!value || typeof value !== 'object') return null;
    const {id, login} = value as Partial<GitAccount>;
    if (typeof login !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(login) ||
        id !== undefined && !isGitHubUserId(id)) return null;
    return Object.freeze({login, ...(id !== undefined && {id})});
}
