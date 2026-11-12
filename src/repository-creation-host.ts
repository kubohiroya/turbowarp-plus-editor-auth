import {assertOperationId, normalizeCreationIntent, RepositoryCreationError, sameName, validLogin, validRepositoryName}
    from './repository-creation.js';
import type {CreatedRepository, CreationOwner, CreationSession, RepositoryCreationDraft, RepositoryCreationErrorCode,
    RepositoryCreationInspection, RepositoryCreationIntent}
    from './repository-creation.js';

type CreationAuthority = Pick<CreationSession, 'scope' | 'account' | 'owners'>;
type RefusedCode = Extract<RepositoryCreationErrorCode, 'denied' | 'nameConflict' | 'insufficientPermission' | 'rateLimited' | 'failed'>;

interface CreationAttemptBase {
    readonly intent: RepositoryCreationIntent;
    readonly account: string;
    readonly startedAt: number;
}

type TopicsStatus = 'not-requested' | 'pending' | 'applied' | 'failed';

export type RepositoryCreationAttempt = CreationAttemptBase & (
    | {readonly status: 'unknown'}
    | {readonly status: 'refused'; readonly code: RefusedCode}
    | {readonly status: 'created'; readonly repository: CreatedRepository; readonly topicsStatus: TopicsStatus}
);

export interface RepositoryCreationCandidate extends CreatedRepository {
    readonly createdAt: number;
}

export interface RepositoryCreationHostOptions {
    readonly journal: {
        /** The durable journal serializes this operation across host instances. */
        exclusive<T>(operationId: string, run: () => Promise<T>): Promise<T>;
        read(operationId: string): Promise<RepositoryCreationAttempt | null>;
        write(attempt: RepositoryCreationAttempt): Promise<void>;
    };
    readonly github: {
        /** Resolve as created only for a 201. The adapter checks the GitHub response body. */
        create(type: CreationOwner['type'], draft: RepositoryCreationDraft):
        Promise<{status: 'created'; body: unknown} | {status: 'refused'; code: RefusedCode}>;
        find(owner: string, name: string): Promise<unknown>;
        isEmpty(repository: CreatedRepository): Promise<boolean>;
        /** The port must scope writes to the verified repository ID. */
        setTopics(repository: CreatedRepository, topics: readonly string[]): Promise<void>;
    };
    /** The privileged host obtains user confirmation of the shown candidate ID. */
    readonly confirmAdoption: (candidate: RepositoryCreationCandidate) => Promise<boolean>;
    readonly now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

function verifiedRepository(body: unknown, {owner, name, visibility}: RepositoryCreationDraft): CreatedRepository | null {
    if (!isRecord(body) || typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id < 1 ||
        !isRecord(body.owner) || !validLogin(body.owner.login) || !sameName(owner, body.owner.login) ||
        !validRepositoryName(body.name) || !sameName(name, body.name) || body.private !== (visibility === 'private')) return null;
    return Object.freeze({id: body.id, owner: body.owner.login, name: body.name, visibility,
        remote: `https://github.com/${body.owner.login}/${body.name}.git`});
}

function ownerFor({scope, account, owners}: CreationAuthority, draft: RepositoryCreationDraft): CreationOwner {
    if (scope !== 'repository-creation') throw new RepositoryCreationError('denied');
    const owner = owners.find(item => sameName(item.login, draft.owner) && item.canCreate[draft.visibility] === true);
    if (!validLogin(account.login) || !owner || !validLogin(owner.login) ||
        (owner.type !== 'User' && owner.type !== 'Organization') ||
        (owner.type === 'User' && !sameName(owner.login, account.login))) throw new RepositoryCreationError('insufficientPermission');
    return owner;
}

function finishCreation(attempt: CreationAttemptBase, repository: CreatedRepository): RepositoryCreationAttempt {
    return {...attempt, status: 'created', repository, topicsStatus: attempt.intent.topics.length ? 'pending' : 'not-requested'};
}

/** Privileged adapter. The relay verifies the creation grant and provides the authority and durable journal. */
export function createRepositoryCreationHost({journal, github, confirmAdoption, now = Date.now}: RepositoryCreationHostOptions) {
    async function read(authority: CreationAuthority, operationId: string) {
        const attempt = await journal.read(operationId);
        if (!attempt) return null;
        if (!sameName(attempt.account, authority.account.login)) throw new RepositoryCreationError('denied');
        ownerFor(authority, attempt.intent);
        return attempt;
    }

    async function candidate(attempt: CreationAttemptBase): Promise<RepositoryCreationCandidate | null> {
        const {intent, startedAt} = attempt;
        const value = await github.find(intent.owner, intent.name);
        const repository = verifiedRepository(value, intent);
        const createdAt = isRecord(value) && typeof value.created_at === 'string' ? Date.parse(value.created_at) : NaN;
        // GitHub reports whole seconds. An exact repository ID still needs explicit confirmation.
        if (!repository || !Number.isFinite(createdAt) || createdAt < Math.floor(startedAt / 1000) * 1000 ||
            (await github.isEmpty(repository)) !== true) return null;
        return Object.freeze({...repository, createdAt});
    }

    return {
        async create(authority: CreationAuthority, input: RepositoryCreationIntent): Promise<RepositoryCreationAttempt> {
            const draft = normalizeCreationIntent(input);
            const owner = ownerFor(authority, draft);
            const intent = Object.freeze({...draft, owner: owner.login});
            return journal.exclusive(intent.operationId, async () => {
                const earlier = await read(authority, intent.operationId);
                if (earlier) {
                    const old = earlier.intent;
                    if (!sameName(old.owner, intent.owner) || !sameName(old.name, intent.name) || old.visibility !== intent.visibility ||
                        old.description !== intent.description || old.seedDigest !== intent.seedDigest ||
                        old.topics.join(',') !== intent.topics.join(',')) throw new RepositoryCreationError('invalidRequest');
                    return earlier;
                }
                const startedAt = now();
                const unknown = {intent, account: authority.account.login, startedAt, status: 'unknown'} as const;
                // Persist the uncertain outcome first so a crash or a lost response cannot cause another POST.
                await journal.write(unknown);
                let result;
                try {
                    result = await github.create(owner.type, {owner: intent.owner, name: intent.name,
                        description: intent.description, visibility: intent.visibility});
                } catch {
                    return unknown;
                }
                if (result.status === 'refused') {
                    const refused = {...unknown, status: 'refused', code: result.code} as const;
                    await journal.write(refused);
                    return refused;
                }
                const repository = verifiedRepository(result.body, intent);
                if (!repository) return unknown;
                const created = finishCreation(unknown, repository);
                await journal.write(created);
                return created;
            });
        },
        async inspectUnknown(authority: CreationAuthority, operationId: string): Promise<RepositoryCreationCandidate | null> {
            assertOperationId(operationId);
            const attempt = await read(authority, operationId);
            return attempt?.status === 'unknown' ? candidate(attempt) : null;
        },
        async inspectCreation(authority: CreationAuthority, operationId: string): Promise<RepositoryCreationInspection> {
            assertOperationId(operationId);
            const attempt = await read(authority, operationId);
            if (!attempt) return {status: 'absent'};
            if (attempt.status === 'created') return {status: 'created', repository: attempt.repository};
            if (attempt.status === 'refused') return {status: 'refused', code: attempt.code};
            return {status: 'unknown', candidate: await candidate(attempt)};
        },
        async adoptUnknown(authority: CreationAuthority, operationId: string, expectedId: number):
        Promise<RepositoryCreationAttempt> {
            assertOperationId(operationId);
            if (!Number.isSafeInteger(expectedId) || expectedId < 1) throw new RepositoryCreationError('invalidRequest');
            return journal.exclusive(operationId, async () => {
                const attempt = await read(authority, operationId);
                if (attempt?.status === 'created' && attempt.repository.id === expectedId) return attempt;
                if (!attempt || attempt.status !== 'unknown') throw new RepositoryCreationError('invalidRequest');
                const inspected = await candidate(attempt);
                if (inspected?.id !== expectedId || (await confirmAdoption(inspected)) !== true) return attempt;
                const verified = await candidate(attempt);
                if (verified?.id !== expectedId || verified.createdAt !== inspected.createdAt) return attempt;
                const created = finishCreation(attempt, verified);
                await journal.write(created);
                return created;
            });
        },
        async applyTopics(authority: CreationAuthority, operationId: string, repositoryId: number): Promise<RepositoryCreationAttempt> {
            assertOperationId(operationId);
            return journal.exclusive(operationId, async () => {
                const attempt = await read(authority, operationId);
                if (!attempt || attempt.status !== 'created') throw new RepositoryCreationError('invalidRequest');
                if (attempt.repository.id !== repositoryId) throw new RepositoryCreationError('denied');
                if (attempt.topicsStatus === 'not-requested' || attempt.topicsStatus === 'applied') return attempt;
                let topicsStatus: TopicsStatus = 'failed';
                try {
                    const {intent, repository} = attempt;
                    const current = verifiedRepository(await github.find(intent.owner, intent.name), intent);
                    if (current?.id === repository.id) {
                        await github.setTopics(repository, intent.topics);
                        topicsStatus = 'applied';
                    }
                } catch {
                    // The repository ID remains known if the separate Topics update fails.
                }
                const updated = {...attempt, topicsStatus};
                await journal.write(updated);
                return updated;
            });
        }
    };
}
