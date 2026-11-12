import {readGrant, RepositoryCreationError} from './repository-creation.js';
import type {CreationGrant} from './repository-creation.js';

const ticketPattern = /^login\.([A-Za-z0-9_-]{43})\.[A-Za-z0-9_-]{43}$/u;
const pollWindow = 10 * 60_000;

function delay(ms: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const abort = () => {clearTimeout(timer); reject(signal?.reason);};
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, {once: true});
    });
}

/** Account-level PKCE login. Only a creation grant crosses into the Editor. */
export function createCloudflareRepositoryCreationAuthorization({bffOrigin, openAuthorization, fetch: send = fetch, wait = delay}: {
    bffOrigin: string;
    /** The host reserves a browser window during the initiating click, then navigates it here. */
    openAuthorization(url: string): void;
    fetch?: typeof fetch;
    wait?: typeof delay;
}) {
    const origin = URL.parse(bffOrigin);
    if (!origin || origin.protocol !== 'https:' || origin.origin !== bffOrigin)
        throw new RepositoryCreationError('invalidConfiguration');
    const connection = Object.freeze({mode: 'cloudflare' as const, proxyOrigin: bffOrigin});
    let ticket: string | null = null;
    let current: CreationGrant | null = null;
    let active: Promise<CreationGrant | null> | null = null;
    let controller: AbortController | null = null;

    function request(path: '/start' | '/session', method: 'POST' | 'GET' | 'DELETE', bearer?: string, signal?: AbortSignal) {
        const options: RequestInit = {method, signal, credentials: 'omit', redirect: 'error', cache: 'no-store'};
        if (bearer) options.headers = {Authorization: 'Bearer ' + bearer};
        if (method === 'POST') {
            options.headers = {'Content-Type': 'application/json'};
            options.body = '{}';
        }
        return send(bffOrigin + '/v1/github-create' + path, options);
    }

    async function revoke(bearer: string) {
        const response = await request('/session', 'DELETE', bearer, AbortSignal.timeout(10_000));
        if (response.status !== 204 && response.status !== 401) throw new RepositoryCreationError('failed');
    }

    async function authorize(signal: AbortSignal): Promise<CreationGrant | null> {
        const deadline = Date.now() + pollWindow;
        const timeout = AbortSignal.timeout(pollWindow);
        const lifetime = AbortSignal.any([signal, timeout]);
        let created: string | null = null;
        try {
            const start = await request('/start', 'POST', undefined, lifetime);
            if (start.status === 403 || start.status === 404) throw new RepositoryCreationError('denied');
            if (start.status === 429) throw new RepositoryCreationError('rateLimited');
            if (!start.ok) throw new RepositoryCreationError('failed');
            const payload: {ticket?: unknown; authorizationUrl?: unknown} | null = await start.json().catch(() => null);
            const match = typeof payload?.ticket === 'string' && ticketPattern.exec(payload.ticket);
            if (!match) throw new RepositoryCreationError('failed');
            created = match[0];
            const url = typeof payload?.authorizationUrl === 'string' ? URL.parse(payload.authorizationUrl) : null;
            if (!url || url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize' ||
                url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 ||
                url.searchParams.get('state') !== match[1] || url.searchParams.get('code_challenge_method') !== 'S256' ||
                url.searchParams.get('redirect_uri') !== bffOrigin + '/v1/github-create/callback') {
                throw new RepositoryCreationError('failed');
            }
            lifetime.throwIfAborted();
            ticket = created;
            openAuthorization(url.href);
            while (Date.now() < deadline) {
                lifetime.throwIfAborted();
                const response = await request('/session', 'GET', created, lifetime);
                if (response.status === 202) {
                    await wait(1500, lifetime);
                    continue;
                }
                if (response.status === 401) return null;
                if (response.status === 429) throw new RepositoryCreationError('rateLimited');
                if (!response.ok) throw new RepositoryCreationError('failed');
                const value = await response.json().catch(() => null);
                if (!value || typeof value !== 'object') throw new RepositoryCreationError('failed');
                lifetime.throwIfAborted();
                const grant = readGrant(value as CreationGrant, connection);
                if (!grant.bearer.startsWith('create.' + match[1] + '.')) throw new RepositoryCreationError('denied');
                current = grant;
                return current;
            }
            return null;
        } catch (error) {
            if (signal.aborted || timeout.aborted) return null;
            throw error instanceof RepositoryCreationError ? error : new RepositoryCreationError('failed');
        } finally {
            if (created && !current) {
                if (ticket === created) ticket = null;
                await revoke(created).catch(() => {});
            }
        }
    }

    return {
        connection,
        authorize(signal?: AbortSignal) {
            if (signal?.aborted) return Promise.resolve(null);
            if (current && current.expiresAt > Date.now()) return Promise.resolve(current);
            if (active) return active;
            current = null;
            controller = new AbortController();
            const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            active = authorize(lifetime).finally(() => {active = null; controller = null;});
            return active;
        },
        async disconnect() {
            controller?.abort();
            const previous = ticket;
            ticket = null;
            current = null;
            if (previous) await revoke(previous);
        }
    };
}
