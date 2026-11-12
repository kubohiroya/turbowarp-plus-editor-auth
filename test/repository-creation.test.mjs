import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRepositoryCreationClient} from '../dist/index.js';

const cloudflare = {mode: 'cloudflare', proxyOrigin: 'https://git.example.test'};
const desktop = {mode: 'desktop', proxyOrigin: 'http://127.0.0.1:54321'};
const org = {login: 'Team', type: 'Organization', canCreate: {private: true, public: false}};
const draft = {owner: 'team', name: 'game', description: 'Project', visibility: 'private',
    operationId: 'request-1', seedDigest: 'a'.repeat(64), topics: ['scratch', 'game-1', 'scratch']};
const created = {id: 1312, owner: 'Team', name: 'game', visibility: 'private'};

function grant(connection = cloudflare, login = 'octocat') {
    const token = 'a'.repeat(43);
    return {scope: 'repository-creation', connection, account: {login},
        bearer: `create.${token}${connection.mode === 'cloudflare' ? '.' + 'b'.repeat(43) : ''}`,
        expiresAt: Date.now() + 60000};
}

function fixture({connection = cloudflare, authorize = async () => grant(connection), replies = []} = {}) {
    const calls = [];
    const client = createRepositoryCreationClient({connection, authorize, async fetch(url, init) {
        calls.push([url, init]);
        const reply = replies.shift();
        assert.ok(reply, `Unexpected request ${init.method} ${url}`);
        if (reply instanceof Error) throw reply;
        return reply;
    }});
    return {client, calls};
}

const owners = (...items) => Response.json({owners: items});
const createdReply = (value = created) => Response.json(value, {status: 201});

test('uses only the creation routes at the selected origin', async () => {
    const {client, calls} = fixture({connection: desktop, replies: [owners(org), createdReply(), new Response(null, {status: 204})]});
    const session = await client.connectForCreation();
    assert.deepEqual(session.owners, [org]);
    assert.equal(session.account.login, 'octocat');
    assert.ok(Object.isFrozen(session) && Object.isFrozen(session.owners[0].canCreate));
    const repository = await client.createRepository(session, draft);
    assert.deepEqual(repository, {...created, remote: 'https://github.com/Team/game.git'});
    await client.setRepositoryTopics(session, repository);
    assert.deepEqual(calls.map(([url, request]) => [url, request.method, request.body && JSON.parse(request.body)]), [
        [desktop.proxyOrigin + '/v1/github-create/owners', 'GET', undefined],
        [desktop.proxyOrigin + '/v1/github-create/repos', 'POST', {...draft, owner: 'Team', topics: ['scratch', 'game-1']}],
        [desktop.proxyOrigin + '/v1/github-create/repos/1312/topics', 'PUT', {operationId: 'request-1'}]
    ]);
    for (const [, request] of calls) {
        assert.equal(request.headers.Authorization, 'Bearer ' + grant(desktop).bearer);
        assert.equal(request.credentials, 'omit');
        assert.equal(request.redirect, 'error');
        assert.equal(request.cache, 'no-store');
    }
});

test('rejects repository-specific credentials, foreign origins, expiration and forged sessions', async () => {
    for (const wrong of [
        {...grant(), scope: undefined},
        {...grant(), bearer: grant().bearer.slice('create.'.length)},
        {...grant(), connection: {...cloudflare, proxyOrigin: 'https://other.test'}},
        {...grant(), bearer: grant().bearer + '\n'},
        {...grant(), expiresAt: Date.now() - 1}
    ]) {
        const {client, calls} = fixture({authorize: async () => wrong});
        await assert.rejects(client.connectForCreation(), {code: 'denied'});
        assert.equal(calls.length, 0);
    }
    for (const connection of [
        {...cloudflare, proxyOrigin: 'https://other.test/path'}, {...cloudflare, proxyOrigin: 'http://other.test'},
        {...desktop, proxyOrigin: 'http://localhost:54321'}, {...desktop, proxyOrigin: 'http://127.0.0.1:54321?x'}
    ]) assert.throws(() => fixture({connection}), {code: 'invalidConfiguration'});
    const {client, calls} = fixture({replies: [owners(org)]});
    const session = await client.connectForCreation();
    await assert.rejects(client.createRepository({...session}, draft), {code: 'denied'});
    await assert.rejects(client.createRepository(session, {...draft, visibility: 'public'}), {code: 'insufficientPermission'});
    await assert.rejects(client.createRepository(session, {...draft, owner: 'other'}), {code: 'insufficientPermission'});
    await assert.rejects(client.createRepository(session, {...draft, name: '../other'}), {code: 'invalidRequest'});
    await assert.rejects(client.createRepository(session, {...draft, topics: ['Uppercase']}), {code: 'invalidRequest'});
    await assert.rejects(client.createRepository(session, {...draft, topics: new Array(1)}), {code: 'invalidRequest'});
    assert.equal(calls.length, 1);
});

test('checks owner response and preserves cancelled authorization', async () => {
    const cancelled = fixture({authorize: async () => null});
    assert.equal(await cancelled.client.connectForCreation(), null);
    assert.equal(cancelled.calls.length, 0);
    for (const reply of [owners(org, {...org, login: 'team'}), owners({...org, type: 'User'}),
        owners({...org, canCreate: {private: 'true', public: false}})]) {
        const {client} = fixture({replies: [reply]});
        await assert.rejects(client.connectForCreation(), {code: 'failed'});
    }
});

test('reports a lost or unverified POST result without retrying the creation', async () => {
    for (const [response, code] of [
        [new Error('Network disconnected'), 'unknown'], [Response.json({}, {status: 502}), 'unknown'],
        [createdReply({...created, owner: 'elsewhere'}), 'unknown'],
        [createdReply({...created, visibility: 'public'}), 'unknown'],
        [Response.json({code: 'nameConflict'}, {status: 422}), 'nameConflict'],
        [Response.json({}, {status: 403}), 'insufficientPermission'],
        [Response.json({}, {status: 429}), 'rateLimited']
    ]) {
        const {client, calls} = fixture({replies: [owners(org), response]});
        const session = await client.connectForCreation();
        await assert.rejects(client.createRepository(session, draft), {code});
        assert.equal(calls.length, 2);
    }
});

test('Topics can only use a repository created for the authorized account by this client', async () => {
    let login = 'octocat';
    const {client, calls} = fixture({authorize: async () => grant(cloudflare, login),
        replies: [owners(org), createdReply(), owners(org)]});
    const session = await client.connectForCreation();
    const repository = await client.createRepository(session, draft);
    await assert.rejects(client.setRepositoryTopics(session, {...repository, id: 9123}), {code: 'denied'});
    login = 'another';
    const anotherSession = await client.connectForCreation();
    await assert.rejects(client.setRepositoryTopics(anotherSession, repository), {code: 'denied'});
    assert.equal(calls.length, 3);
});

test('inspects a lost Cloudflare operation and adopts only a matching receipt for the selected ID', async () => {
    const {client, calls} = fixture({replies: [
        owners(org), Response.json({code: 'inProgress'}, {status: 409}),
        Response.json({status: 'unknown', candidate: null}),
        Response.json({status: 'unknown', candidate: created}),
        createdReply({...created, id: 24}), createdReply(),
        new Response(null, {status: 204})
    ]});
    const session = await client.connectForCreation();
    await assert.rejects(client.createRepository(session, draft), {code: 'unknown'});
    assert.equal(await client.inspectUnknown(session, draft.operationId), null);
    const candidate = await client.inspectUnknown(session, draft.operationId);
    assert.deepEqual(candidate, {...created, remote: 'https://github.com/Team/game.git'});
    await assert.rejects(client.setRepositoryTopics(session, candidate), {code: 'denied'});
    await assert.rejects(client.adoptUnknown(session, draft, candidate.id), {code: 'unknown'});
    const repository = await client.adoptUnknown(session, draft, candidate.id);
    await client.setRepositoryTopics(session, repository);
    assert.deepEqual(calls.slice(4).map(([url, init]) => [url, init.method, JSON.parse(init.body)]), [
        [cloudflare.proxyOrigin + '/v1/github-create/operations/request-1/reconcile', 'POST', {repositoryId: 1312}],
        [cloudflare.proxyOrigin + '/v1/github-create/operations/request-1/reconcile', 'POST', {repositoryId: 1312}],
        [cloudflare.proxyOrigin + '/v1/github-create/repos/1312/topics', 'PUT', {operationId: 'request-1'}]
    ]);
});

test('distinguishes an unrecorded creation from an uncertain or completed creation', async () => {
    const {client} = fixture({replies: [
        owners(org), Response.json({code: 'invalidRequest'}, {status: 404}),
        Response.json({status: 'unknown', candidate: null}),
        Response.json({status: 'created', repository: created}),
        Response.json({status: 'refused', code: 'nameConflict'}),
        new Response(null, {status: 404})
    ]});
    const session = await client.connectForCreation();
    assert.deepEqual(await client.inspectCreation(session, draft.operationId), {status: 'absent'});
    assert.deepEqual(await client.inspectCreation(session, draft.operationId), {status: 'unknown', candidate: null});
    assert.deepEqual(await client.inspectCreation(session, draft.operationId),
        {status: 'created', repository: {...created, remote: 'https://github.com/Team/game.git'}});
    assert.deepEqual(await client.inspectCreation(session, draft.operationId), {status: 'refused', code: 'nameConflict'});
    await assert.rejects(client.inspectCreation(session, draft.operationId), {code: 'failed'});
});
