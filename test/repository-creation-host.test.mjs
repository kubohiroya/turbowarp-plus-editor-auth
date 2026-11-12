import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRepositoryCreationHost} from '../dist/index.js';

const now = Date.parse('2026-11-13T12:00:00.713Z');
const authority = {scope: 'repository-creation', account: {login: 'octocat'}, owners: [
    {login: 'Team', type: 'Organization', canCreate: {private: true, public: false}}
]};
const intent = {operationId: 'request-1', owner: 'team', name: 'scratch-app', description: 'Project',
    visibility: 'private', topics: ['scratch'], seedDigest: 'a'.repeat(64)};
const body = {id: 1212, owner: {login: 'Team'}, name: 'scratch-app', private: true, created_at: '2026-11-13T12:00:00Z'};

function fixture(options = {}) {
    const entries = new Map();
    const calls = [];
    const locks = new Map();
    const config = {now: () => now,
        journal: {
            async exclusive(id, run) {
                const result = (locks.get(id) ?? Promise.resolve()).then(run);
                locks.set(id, result.catch(() => {}));
                return result;
            },
            async read(id) {return entries.get(id) ?? null;},
            async write(entry) {calls.push(['journal', entry.status]); entries.set(entry.intent.operationId, entry);}
        },
        github: {
            async create(type, draft) {
                calls.push(['create', type, draft]);
                return {status: 'created', body};
            },
            async find(owner, name) {calls.push(['find', owner, name]); return body;},
            async isEmpty(repository) {calls.push(['empty', repository.id]); return true;},
            async setTopics(repository, topics) {calls.push(['topics', repository.id, topics]);},
            ...options.github
        },
        confirmAdoption: options.confirmAdoption ?? (async () => false)
    };
    return {host: createRepositoryCreationHost(config), reload: () => createRepositoryCreationHost(config), entries, calls};
}

test('records the intent before requesting creation and persists the verified identity', async () => {
    const {host, calls, entries, reload} = fixture();
    assert.deepEqual(await host.inspectCreation(authority, intent.operationId), {status: 'absent'});
    const result = await host.create(authority, intent);
    assert.equal(result.status, 'created');
    assert.equal(result.repository.id, 1212);
    assert.equal(result.repository.remote, 'https://github.com/Team/scratch-app.git');
    assert.equal(result.topicsStatus, 'pending');
    assert.deepEqual(calls, [['journal', 'unknown'], ['create', 'Organization', {
        owner: 'Team', name: 'scratch-app', description: 'Project', visibility: 'private'
    }], ['journal', 'created']]);
    assert.equal(entries.get(intent.operationId).status, 'created');
    assert.deepEqual(await reload().inspectCreation(authority, intent.operationId), {status: 'created', repository: result.repository});
    assert.equal((await reload().create(authority, intent)).repository.id, 1212);
    await assert.rejects(reload().create(authority, {...intent, seedDigest: 'b'.repeat(64)}), {code: 'invalidRequest'});
    assert.equal(calls.length, 3);
});

test('serializes concurrent requests for the same operation across host instances', async () => {
    const {host, reload, calls} = fixture();
    const [first, second] = await Promise.all([host.create(authority, intent), reload().create(authority, intent)]);
    assert.equal(first.status, 'created');
    assert.deepEqual(second, first);
    assert.equal(calls.filter(([type]) => type === 'create').length, 1);
});

test('rejects an ungranted owner or public visibility before reserving or contacting GitHub', async () => {
    const {host, calls} = fixture();
    await assert.rejects(host.create({...authority, scope: undefined}, intent), {code: 'denied'});
    await assert.rejects(host.create(authority, {...intent, owner: 'other'}), {code: 'insufficientPermission'});
    await assert.rejects(host.create(authority, {...intent, visibility: 'public'}), {code: 'insufficientPermission'});
    assert.deepEqual(calls, []);
});

test('does not accept an unverified creation reply as a repository receipt', async () => {
    for (const mismatch of [{id: '1212'}, {id: 0}, {owner: {login: 'Other'}}, {name: 'wrong'}, {private: false}]) {
        const {host, entries} = fixture({github: {async create() {return {status: 'created', body: {...body, ...mismatch}};}}});
        const result = await host.create(authority, intent);
        assert.equal(result.status, 'unknown');
        assert.equal('repository' in entries.get(intent.operationId), false);
    }
});

test('reconciles a lost creation response without repeating the POST or adopting a candidate by name', async () => {
    let attempts = 0;
    let confirmation = 'decline';
    let foundId = body.id;
    let empty = true;
    const confirmations = [];
    const {host, reload} = fixture({
        github: {
            async create() {attempts++; throw new Error('connection lost');},
            async find() {return {...body, id: foundId};},
            async isEmpty() {return empty;}
        },
        async confirmAdoption(candidate) {
            confirmations.push(candidate.id);
            if (confirmation === 'replace') foundId = 3434;
            return confirmation !== 'decline';
        }
    });
    assert.equal((await host.create(authority, intent)).status, 'unknown');
    const resumed = reload();
    assert.equal((await resumed.create(authority, intent)).status, 'unknown');
    assert.equal(attempts, 1);
    assert.equal((await resumed.inspectUnknown(authority, intent.operationId)).id, 1212);
    assert.deepEqual(confirmations, []);
    await assert.rejects(resumed.adoptUnknown(authority, intent.operationId, undefined), {code: 'invalidRequest'});
    assert.equal((await resumed.adoptUnknown(authority, intent.operationId, 1)).status, 'unknown');
    assert.deepEqual(confirmations, []);
    assert.equal((await resumed.adoptUnknown(authority, intent.operationId, 1212)).status, 'unknown');
    confirmation = 'replace';
    assert.equal((await resumed.adoptUnknown(authority, intent.operationId, 1212)).status, 'unknown');
    empty = false;
    assert.equal(await resumed.inspectUnknown(authority, intent.operationId), null);
    empty = true;
    confirmation = 'accept';
    const result = await resumed.adoptUnknown(authority, intent.operationId, 3434);
    assert.equal(result.status, 'created');
    assert.equal(result.repository.id, 3434);
    assert.equal((await resumed.adoptUnknown(authority, intent.operationId, 3434)).repository.id, 3434);
    assert.deepEqual(confirmations, [1212, 1212, 3434]);
    assert.equal(attempts, 1);
});

test('keeps successful creation when Topics fail and retries against the same repository ID', async () => {
    let foundId = body.id;
    let updates = 0;
    const {host, reload, calls} = fixture({github: {
        async find() {return {...body, id: foundId};},
        async setTopics(repository, topics) {
            assert.equal(repository.id, 1212);
            assert.deepEqual(topics, ['scratch']);
            if (++updates === 1) throw new Error('rate limited');
        }
    }});
    await host.create(authority, intent);
    await assert.rejects(host.applyTopics(authority, intent.operationId, 3434), {code: 'denied'});
    const first = await host.applyTopics(authority, intent.operationId, 1212);
    assert.equal(first.status, 'created');
    assert.equal(first.repository.id, 1212);
    assert.equal(first.topicsStatus, 'failed');
    foundId = 3434;
    assert.equal((await reload().applyTopics(authority, intent.operationId, 1212)).topicsStatus, 'failed');
    assert.equal(updates, 1);
    foundId = body.id;
    assert.equal((await reload().applyTopics(authority, intent.operationId, 1212)).topicsStatus, 'applied');
    assert.equal((await reload().applyTopics(authority, intent.operationId, 1212)).topicsStatus, 'applied');
    assert.equal(updates, 2);
    assert.equal(calls.filter(([type]) => type === 'create').length, 1);
});
