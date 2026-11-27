import type {GitAuthProvider, GitAuthState, GitProxySession} from './index.js';
import type {GitSignOutState} from './signout.js';
import {isGitHubRemote} from './github-remote.js';
import {publicGitHubAccount} from './identity.js';

export interface CloudflareGitAuthOptions {
    readonly selectAccount?: boolean;
    readonly bffOrigin: string;
    readonly proxyOrigin: string;
    readonly remote: string;
    /** Required for the first push to a just-created repository. */
    readonly repositoryId?: number;
    readonly write: boolean;
    /** Requests the separate grant to submit pull request reviews. Omitted means no review grant. */
    readonly review?: boolean;
    readonly openAuthorization: (url: string) => void;
    readonly fetch?: typeof fetch;
}

type ErrorCode = 'INVALID_CONFIGURATION' | 'INVALID_RESPONSE' | 'REQUEST_FAILED' |
    'FORBIDDEN' | 'RATE_LIMITED' | 'REVOCATION_PENDING';

export class CloudflareGitAuthError extends Error {
    constructor(readonly code: ErrorCode) {
        super(code);
        this.name = 'CloudflareGitAuthError';
    }
}

const credentialPattern = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u;

function isHttpsOrigin(value: string) {
    const url = URL.parse(value);
    return url?.protocol === 'https:' && url.origin === value;
}

async function responseJson(response: Response) {
    const value: unknown = await response.json().catch(() => null);
    if (typeof value !== 'object' || !value) throw new CloudflareGitAuthError('INVALID_RESPONSE');
    return value;
}

export function createCloudflareGitAuth(options: CloudflareGitAuthOptions): GitAuthProvider {
    const {bffOrigin, proxyOrigin, remote, repositoryId, write, review = false, openAuthorization, fetch: send = fetch} = options;
    if (!isHttpsOrigin(bffOrigin) || !isHttpsOrigin(proxyOrigin) || !isGitHubRemote(remote) ||
        typeof review !== 'boolean' || repositoryId !== undefined && (!Number.isSafeInteger(repositoryId) || repositoryId < 1)) {
        throw new CloudflareGitAuthError('INVALID_CONFIGURATION');
    }

    const connection = Object.freeze({mode: 'cloudflare' as const, proxyOrigin});
    let ticket: string | null = null;
    let pendingRevocation: string | null = null;
    let state: GitAuthState = {status: 'disconnected'};
    let revision = 0;
    let starting: Promise<void> | undefined;
    let unknownStart = false;
    let signOut: GitSignOutState = {local: 'stopped', session: 'pending', github: 'unconfirmed'};

    async function request(path: '/start' | '/session', init: RequestInit) {
        let response;
        try {
            response = await send(bffOrigin + '/v1/git-auth' + path, {
                ...init, credentials: 'omit', redirect: 'error', cache: 'no-store'
            });
        } catch {
            init.signal?.throwIfAborted();
            throw new CloudflareGitAuthError('REQUEST_FAILED');
        }
        if (response.status === 403) throw new CloudflareGitAuthError('FORBIDDEN');
        if (response.status === 429) throw new CloudflareGitAuthError('RATE_LIMITED');
        return response;
    }

    async function revoke(value: string) {
        pendingRevocation = value;
        const response = await request('/session', {
            method: 'DELETE', headers: {Authorization: 'Bearer ' + value},
            signal: AbortSignal.timeout(15_000), keepalive: true
        });
        if (response.status === 202) {
            signOut = {local: 'stopped', session: 'revoked', github: 'pending'};
            throw new CloudflareGitAuthError('REVOCATION_PENDING');
        }
        if (response.status !== 204 && response.status !== 401)
            throw new CloudflareGitAuthError('REQUEST_FAILED');
        const scope = response.headers.get('X-GitHub-Revocation');
        signOut = {local: 'stopped', session: 'revoked',
            github: response.status === 204 && scope === 'token' ? 'token-revoked' :
                response.status === 204 && scope === 'authorization' ? 'authorization-revoked' : 'unconfirmed'};
        if (pendingRevocation === value) pendingRevocation = null;
    }

    async function getSession(): Promise<GitProxySession | null> {
        const current = ticket;
        if (!current) return null;
        const active = revision;
        const response = await request('/session', {
            method: 'GET', headers: {Authorization: 'Bearer ' + current}
        });
        if (revision !== active) return null;
        if (response.status === 202) return null;
        if (response.status === 401) {
            revision++;
            ticket = null;
            state = {status: 'reauth-required'};
            return null;
        }
        if (response.status !== 200) throw new CloudflareGitAuthError('REQUEST_FAILED');
        const value = await responseJson(response) as Partial<GitProxySession>;
        if (revision !== active) return null;
        const {bearer, expiresAt, account} = value;
        const displayAccount = publicGitHubAccount(account);
        if (value.connection?.mode !== connection.mode || value.connection.proxyOrigin !== proxyOrigin ||
            typeof bearer !== 'string' || !credentialPattern.test(bearer) || bearer === current ||
            !displayAccount ||
            typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
            repositoryId !== undefined && value.repositoryId !== repositoryId) {
            throw new CloudflareGitAuthError('INVALID_RESPONSE');
        }
        state = {status: 'connected', account: displayAccount, expiresAt};
        return {connection, account: displayAccount, bearer, expiresAt, ...(repositoryId !== undefined && {repositoryId})};
    }

    return {
        connection,
        connect(signal) {
            return starting ??= (async () => {
            signal?.throwIfAborted();
            if (pendingRevocation) throw new CloudflareGitAuthError('REVOCATION_PENDING');
            if (state.status === 'connecting' || ticket) return;
            const active = ++revision;
            state = {status: 'connecting'};
            let created: string | null = null;
            try {
                unknownStart = true;
                const response = await request('/start', {
                    method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({remote, write, ...(review && {review}), ...(repositoryId !== undefined && {repositoryId})})
                });
                if (response.status !== 200) throw new CloudflareGitAuthError('REQUEST_FAILED');
                const value = await responseJson(response) as {ticket?: unknown; authorizationUrl?: unknown};
                if (typeof value.ticket !== 'string' || !credentialPattern.test(value.ticket))
                    throw new CloudflareGitAuthError('INVALID_RESPONSE');
                created = value.ticket;
                unknownStart = false;
                const url = typeof value.authorizationUrl === 'string' ? URL.parse(value.authorizationUrl) : null;
                if (!url || !url.href.startsWith('https://github.com/login/oauth/authorize?') || url.hash ||
                    url.searchParams.get('state') !== created.split('.')[0])
                    throw new CloudflareGitAuthError('INVALID_RESPONSE');
                if (revision !== active) {
                    await revoke(created);
                    return;
                }
                signal?.throwIfAborted();
                ticket = created;
                if (options.selectAccount) url.searchParams.set('prompt', 'select_account');
                openAuthorization(url.href);
            } catch (error) {
                if (revision === active) {
                    ticket = null;
                    state = {status: 'disconnected'};
                    if (created) await revoke(created).catch(() => {});
                }
                throw error;
            }
            })().finally(() => {starting = undefined;});
        },
        async getState() {
            if (ticket) await getSession();
            return state;
        },
        getSession,
        getSignOutState: () => ({...signOut}),
        async disconnect() {
            revision++;
            const current = ticket;
            ticket = null;
            state = {status: 'disconnected'};
            if (current) pendingRevocation = current;
            if (starting) await starting.catch(() => {});
            if (pendingRevocation) await revoke(pendingRevocation);
            else if (unknownStart) throw new CloudflareGitAuthError('REQUEST_FAILED');
            else if (signOut.session !== 'revoked') signOut = {...signOut, session: 'revoked'};
        }
    };
}
