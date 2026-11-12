import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCloudflareGitAuth, createCloudflareRepositoryCreationAuthorization, createRepositoryCreationClient} from '../dist/index.js';

const bffOrigin = 'https://login.example.test';
const state = 's'.repeat(43);
const ticket = 'login.' + state + '.' + 'l'.repeat(43);
const bearer = 'create.' + state + '.' + 'c'.repeat(43);
const authorizationUrl = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
    state, redirect_uri: bffOrigin + '/v1/github-create/callback', code_challenge_method: 'S256'
});
const reply = () => ({scope: 'repository-creation', connection: {mode: 'cloudflare', proxyOrigin: bffOrigin},
    account: {login: 'octocat'}, bearer, expiresAt: Date.now() + 60_000});

test('opens the state-bound authorization and exchanges a login ticket for a creation-only grant', async () => {
    const calls = [];
    let polls = 0;
    const send = async (url, init) => {
        const route = new URL(url).pathname;
        calls.push([route, init.method]);
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
        if (route.endsWith('/start')) {
            assert.equal(init.body, '{}');
            return Response.json({ticket, authorizationUrl});
        }
        if (route.endsWith('/owners')) {
            assert.equal(init.headers.Authorization, 'Bearer ' + bearer);
            return Response.json({owners: [{login: 'octocat', type: 'User', canCreate: {public: true, private: true}}]});
        }
        assert.equal(init.headers.Authorization, 'Bearer ' + ticket);
        if (init.method === 'DELETE') return new Response(null, {status: 204});
        return polls++ ? Response.json(reply()) : new Response(null, {status: 202});
    };
    const opened = [];
    const provider = createCloudflareRepositoryCreationAuthorization({bffOrigin,
        openAuthorization: url => opened.push(url), fetch: send, wait: async () => {}});
    const client = createRepositoryCreationClient({...provider, fetch: send});
    const session = await client.connectForCreation();
    assert.equal(session.account.login, 'octocat');
    assert.equal(session.owners[0].login, 'octocat');
    assert.deepEqual(opened, [authorizationUrl]);
    assert.equal((await provider.authorize()).bearer, bearer);
    await provider.disconnect();
    assert.deepEqual(calls.map(([route, method]) => [route.split('/').at(-1), method]),
        [['start', 'POST'], ['session', 'GET'], ['session', 'GET'], ['owners', 'GET'], ['session', 'DELETE']]);
});

test('does not open a mismatched OAuth URL and revokes the unclaimed ticket', async () => {
    let revoked = false;
    const provider = createCloudflareRepositoryCreationAuthorization({bffOrigin, openAuthorization: assert.fail,
        async fetch(_url, {method}) {
            if (method === 'DELETE') {
                revoked = true;
                return new Response(null, {status: 204});
            }
            return Response.json({ticket, authorizationUrl: authorizationUrl.replace(state, 'x'.repeat(43))});
        }});
    await assert.rejects(provider.authorize(), {code: 'failed'});
    assert.equal(revoked, true);
});

test('passes the requested repository ID through normal Git authorization and rejects a different ID', async () => {
    const proxyOrigin = 'https://git.example.test';
    let repositoryId = 8;
    const normalTicket = state + '.' + 'l'.repeat(43);
    const git = createCloudflareGitAuth({bffOrigin, proxyOrigin, repositoryId: 7,
        remote: 'https://github.com/octocat/test.git', write: true, openAuthorization() {},
        async fetch(url, {method, body}) {
            if (new URL(url).pathname.endsWith('/start')) {
                assert.equal(method, 'POST');
                assert.deepEqual(JSON.parse(body), {remote: 'https://github.com/octocat/test.git', write: true, repositoryId: 7});
                return Response.json({ticket: normalTicket, authorizationUrl: 'https://github.com/login/oauth/authorize?state=' + state});
            }
            return Response.json({connection: {mode: 'cloudflare', proxyOrigin}, repositoryId, account: {login: 'octocat'},
                bearer: state + '.' + 'g'.repeat(43), expiresAt: Date.now() + 60_000});
        }});
    await git.connect();
    await assert.rejects(git.getSession(), {code: 'INVALID_RESPONSE'});
    repositoryId = 7;
    assert.equal((await git.getSession()).repositoryId, 7);
});
