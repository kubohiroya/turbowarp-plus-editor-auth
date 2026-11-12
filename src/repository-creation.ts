import type {GitAccount, GitProxyConnection} from './index.js';

export type RepositoryVisibility = 'private' | 'public';

export interface CreationOwner {
    readonly login: string;
    readonly type: 'User' | 'Organization';
    readonly canCreate: Readonly<Record<RepositoryVisibility, boolean>>;
}

/** Only the account-level creation relay can issue or accept this bearer. */
export interface CreationGrant {
    readonly scope: 'repository-creation';
    readonly connection: GitProxyConnection;
    readonly account: GitAccount;
    readonly bearer: string;
    readonly expiresAt: number;
}

export interface CreationSession extends CreationGrant {
    readonly owners: readonly CreationOwner[];
}

export interface RepositoryCreationDraft {
    readonly owner: string;
    readonly name: string;
    readonly description: string;
    readonly visibility: RepositoryVisibility;
}

export interface RepositoryCreationIntent extends RepositoryCreationDraft {
    readonly operationId: string;
    readonly seedDigest: string;
    readonly topics: readonly string[];
}

export interface CreatedRepository extends Omit<RepositoryCreationDraft, 'description'> {
    readonly id: number;
    readonly remote: string;
}

export type RepositoryCreationInspection = {status: 'absent'} |
    {status: 'unknown'; candidate: CreatedRepository | null} |
    {status: 'created'; repository: CreatedRepository} |
    {status: 'refused'; code: string};

export interface RepositoryCreationClientOptions {
    readonly connection: GitProxyConnection;
    /** The host completes account-level authorization. OAuth credentials stay with the host. */
    readonly authorize: (signal?: AbortSignal) => Promise<CreationGrant | null>;
    readonly fetch?: typeof fetch;
}

export type RepositoryCreationErrorCode = 'denied' | 'nameConflict' | 'insufficientPermission' | 'rateLimited' |
    'unknown' | 'failed' | 'invalidConfiguration' | 'invalidRequest';

export class RepositoryCreationError extends Error {
    constructor(readonly code: RepositoryCreationErrorCode) {
        super(code);
        this.name = 'RepositoryCreationError';
    }
}

const scope = 'repository-creation';
const basePath = '/v1/github-create';
const creationBearer = {
    desktop: /^create\.[A-Za-z0-9_-]{43}$/u,
    cloudflare: /^create\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u
};
const loginPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/u;
const topicPattern = /^[a-z0-9][a-z0-9-]{0,49}$/u;
const operationIdPattern = /^[A-Za-z0-9_-]{1,100}$/u;
const seedDigestPattern = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
export const validLogin = (value: unknown): value is string => typeof value === 'string' && loginPattern.test(value);
export const validRepositoryName = (name: unknown): name is string => typeof name === 'string' && repositoryPattern.test(name) &&
    name !== '.' && name !== '..' && !/\.git$/iu.test(name);
const validVisibility = (value: unknown): value is RepositoryVisibility => value === 'private' || value === 'public';
export const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function normalizeCreationDraft(value: unknown): RepositoryCreationDraft {
    if (!isRecord(value) || !validLogin(value.owner) || !validRepositoryName(value.name) || !validVisibility(value.visibility) ||
        typeof value.description !== 'string' || value.description.length > 350 || /[\u0000-\u001f]/u.test(value.description)) {
        throw new RepositoryCreationError('invalidRequest');
    }
    return {owner: value.owner, name: value.name, description: value.description, visibility: value.visibility};
}

function normalizeRepositoryTopics(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length > 20 || [...value].some(topic => typeof topic !== 'string' || !topicPattern.test(topic))) {
        throw new RepositoryCreationError('invalidRequest');
    }
    return [...new Set<string>(value)];
}

export function assertOperationId(operationId: unknown): asserts operationId is string {
    if (typeof operationId !== 'string' || !operationIdPattern.test(operationId)) {
        throw new RepositoryCreationError('invalidRequest');
    }
}

export function normalizeCreationIntent(value: RepositoryCreationIntent): RepositoryCreationIntent {
    const draft = normalizeCreationDraft(value);
    assertOperationId(value.operationId);
    if (typeof value.seedDigest !== 'string' || !seedDigestPattern.test(value.seedDigest)) {
        throw new RepositoryCreationError('invalidRequest');
    }
    return {...draft, operationId: value.operationId, seedDigest: value.seedDigest,
        topics: Object.freeze(normalizeRepositoryTopics(value.topics))};
}

function validConnection({mode, proxyOrigin}: GitProxyConnection) {
    const origin = URL.parse(proxyOrigin);
    if (!origin || origin.origin !== proxyOrigin) return false;
    return mode === 'desktop' ? /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(proxyOrigin) :
        mode === 'cloudflare' && origin.protocol === 'https:';
}

export function readGrant(value: CreationGrant, connection: GitProxyConnection): CreationGrant {
    if (value.scope !== scope || value.connection?.mode !== connection.mode ||
        value.connection?.proxyOrigin !== connection.proxyOrigin || !validLogin(value.account?.login) ||
        typeof value.bearer !== 'string' || !creationBearer[connection.mode].test(value.bearer) ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
        throw new RepositoryCreationError('denied');
    }
    return {scope, connection, account: Object.freeze({login: value.account.login}), bearer: value.bearer,
        expiresAt: value.expiresAt};
}

function readOwners(value: unknown, account: GitAccount): readonly CreationOwner[] {
    if (!isRecord(value) || !Array.isArray(value.owners)) throw new RepositoryCreationError('failed');
    const seen = new Set<string>();
    const owners = value.owners.map((owner: unknown): CreationOwner => {
        if (!isRecord(owner) || !validLogin(owner.login) || (owner.type !== 'User' && owner.type !== 'Organization') ||
            (owner.type === 'User' && !sameName(owner.login, account.login)) || !isRecord(owner.canCreate) ||
            typeof owner.canCreate.private !== 'boolean' || typeof owner.canCreate.public !== 'boolean' ||
            seen.has(owner.login.toLowerCase())) throw new RepositoryCreationError('failed');
        seen.add(owner.login.toLowerCase());
        return Object.freeze({login: owner.login, type: owner.type,
            canCreate: Object.freeze({private: owner.canCreate.private, public: owner.canCreate.public})});
    });
    return Object.freeze(owners);
}

type CreationRoute = '/owners' | '/repos' | `/repos/${number}/topics` |
    `/operations/${string}` | `/operations/${string}/reconcile`;

function readRepository(value: unknown): CreatedRepository {
    if (!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 ||
        !validLogin(value.owner) || !validRepositoryName(value.name) || !validVisibility(value.visibility))
        throw new RepositoryCreationError('unknown');
    const {id, owner, name, visibility} = value;
    return Object.freeze({id, owner, name, visibility, remote: `https://github.com/${owner}/${name}.git`});
}

export function createRepositoryCreationClient({connection: requested, authorize, fetch: send = fetch}:
RepositoryCreationClientOptions) {
    if (!validConnection(requested)) throw new RepositoryCreationError('invalidConfiguration');
    const connection = Object.freeze({mode: requested.mode, proxyOrigin: requested.proxyOrigin});
    const sessions = new WeakSet<CreationSession>();
    const receipts = new WeakMap<CreatedRepository, {account: string; operationId: string}>();

    async function request(session: CreationGrant, route: CreationRoute, method: 'GET' | 'POST' | 'PUT',
        signal?: AbortSignal, body?: object) {
        signal?.throwIfAborted();
        if (session.expiresAt <= Date.now()) throw new RepositoryCreationError('denied');
        try {
            return await send(connection.proxyOrigin + basePath + route, {
                method, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
                headers: {Authorization: `Bearer ${session.bearer}`, Accept: 'application/json',
                    ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch {
            // A lost POST response can mean that the repository exists. Reconcile before retrying.
            if (method === 'POST') throw new RepositoryCreationError('unknown');
            signal?.throwIfAborted();
            throw new RepositoryCreationError('failed');
        }
    }

    async function expect(response: Response, status: number, creating = false) {
        if (response.status === status) return;
        if (response.status === 401) throw new RepositoryCreationError('denied');
        if (response.status === 429) throw new RepositoryCreationError('rateLimited');
        if (response.status === 403) throw new RepositoryCreationError('insufficientPermission');
        if (creating && (response.status === 409 || response.status === 422)) {
            const value: unknown = await response.json().catch(() => null);
            if (isRecord(value) && value.code === 'nameConflict') throw new RepositoryCreationError('nameConflict');
            if (isRecord(value) && (value.code === 'unknown' || value.code === 'inProgress'))
                throw new RepositoryCreationError('unknown');
        }
        if (creating && (response.ok || response.status >= 500)) throw new RepositoryCreationError('unknown');
        throw new RepositoryCreationError('failed');
    }

    function requireOwner(session: CreationSession, owner: string, visibility: RepositoryVisibility) {
        if (!sessions.has(session) || session.expiresAt <= Date.now()) throw new RepositoryCreationError('denied');
        if (!validLogin(owner) || !validVisibility(visibility)) throw new RepositoryCreationError('invalidRequest');
        const grant = session.owners.find(item => sameName(item.login, owner));
        if (!grant?.canCreate[visibility]) throw new RepositoryCreationError('insufficientPermission');
        return grant.login;
    }

    async function registerReceipt(response: Response, session: CreationSession, intent: RepositoryCreationIntent,
        owner: string, expectedId?: number) {
        await expect(response, 201, true);
        const repository = readRepository(await response.json().catch(() => null));
        if (!sameName(repository.owner, owner) || !sameName(repository.name, intent.name) ||
            repository.visibility !== intent.visibility || expectedId !== undefined && repository.id !== expectedId)
            throw new RepositoryCreationError('unknown');
        receipts.set(repository, {account: session.account.login, operationId: intent.operationId});
        return repository;
    }

    async function inspectCreation(session: CreationSession, operationId: string, signal?: AbortSignal):
    Promise<RepositoryCreationInspection> {
        assertOperationId(operationId);
        if (connection.mode !== 'cloudflare' || !sessions.has(session)) throw new RepositoryCreationError('denied');
        const response = await request(session, `/operations/${operationId}`, 'GET', signal);
        if (response.status === 404) {
            const result: unknown = await response.json().catch(() => null);
            if (isRecord(result) && result.code === 'invalidRequest') return {status: 'absent'};
        }
        await expect(response, 200);
        const result: unknown = await response.json().catch(() => null);
        if (!isRecord(result)) throw new RepositoryCreationError('unknown');
        if (result.status === 'refused' && typeof result.code === 'string') return {status: 'refused', code: result.code};
        if (result.status === 'unknown' && result.candidate === null) return {status: 'unknown', candidate: null};
        if (result.status !== 'unknown' && result.status !== 'created') throw new RepositoryCreationError('unknown');
        const repository = readRepository(result.status === 'created' ? result.repository : result.candidate);
        requireOwner(session, repository.owner, repository.visibility);
        return result.status === 'created' ? {status: 'created', repository} : {status: 'unknown', candidate: repository};
    }

    return {
        inspectCreation,
        async connectForCreation(signal?: AbortSignal): Promise<CreationSession | null> {
            signal?.throwIfAborted();
            const authorized = await authorize(signal);
            signal?.throwIfAborted();
            if (!authorized) return null;
            const grant = readGrant(authorized, connection);
            const response = await request(grant, '/owners', 'GET', signal);
            await expect(response, 200);
            const owners = readOwners(await response.json().catch(() => null), grant.account);
            signal?.throwIfAborted();
            if (grant.expiresAt <= Date.now()) throw new RepositoryCreationError('denied');
            const session = Object.freeze({...grant, owners});
            sessions.add(session);
            return session;
        },
        async createRepository(session: CreationSession, input: RepositoryCreationIntent, signal?: AbortSignal):
        Promise<CreatedRepository> {
            const intent = normalizeCreationIntent(input);
            const owner = requireOwner(session, intent.owner, intent.visibility);
            const response = await request(session, '/repos', 'POST', signal, {...intent, owner});
            return registerReceipt(response, session, intent, owner);
        },
        /** Finds the Cloudflare journal's candidate or previously recorded receipt. */
        async inspectUnknown(session: CreationSession, operationId: string, signal?: AbortSignal): Promise<CreatedRepository | null> {
            const result = await inspectCreation(session, operationId, signal);
            if (result.status === 'created') return result.repository;
            if (result.status === 'unknown') return result.candidate;
            if (result.status === 'refused') {
                if (result.code === 'nameConflict' || result.code === 'insufficientPermission')
                    throw new RepositoryCreationError(result.code);
                throw new RepositoryCreationError('failed');
            }
            return null;
        },
        /** Records the candidate after the user confirms the exact ID and the original draft. */
        async adoptUnknown(session: CreationSession, input: RepositoryCreationIntent, repositoryId: number, signal?: AbortSignal) {
            const intent = normalizeCreationIntent(input);
            if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new RepositoryCreationError('invalidRequest');
            if (connection.mode !== 'cloudflare') throw new RepositoryCreationError('denied');
            const owner = requireOwner(session, intent.owner, intent.visibility);
            const response = await request(session, `/operations/${intent.operationId}/reconcile`, 'POST', signal, {repositoryId});
            return registerReceipt(response, session, intent, owner, repositoryId);
        },
        /** The relay must also check its creation journal before changing this repository ID. */
        async setRepositoryTopics(session: CreationSession, repository: CreatedRepository, signal?: AbortSignal) {
            requireOwner(session, repository.owner, repository.visibility);
            const receipt = receipts.get(repository);
            if (!receipt || !sameName(receipt.account, session.account.login)) throw new RepositoryCreationError('denied');
            const response = await request(session, `/repos/${repository.id}/topics`, 'PUT', signal,
                {operationId: receipt.operationId});
            await expect(response, 204);
        }
    };
}
