import assert from 'node:assert/strict';
import test from 'node:test';
import {createCloudflareGitAuth} from '../dist/index.js';

const bffOrigin = 'https://auth.example';
const proxyOrigin = 'https://git.example';
const remote = 'https://github.com/owner/repo.git';
const state = 's'.repeat(43);
const ticket = state + '.' + 't'.repeat(43);
const bearer = state + '.' + 'b'.repeat(43);
const authorizationUrl = 'https://github.com/login/oauth/authorize?state=' + state;
const credentials = () => ({
    connection: {mode: 'cloudflare', proxyOrigin},
    account: {login: 'octocat'},
    bearer,
    expiresAt: Date.now() + 60_000
});

function fixture(responses) {
    const requests = [];
    const opened = [];
    const provider = createCloudflareGitAuth({
        bffOrigin, proxyOrigin, remote, write: true, openAuthorization: url => opened.push(url),
        fetch: async (url, init) => {
            requests.push({url, init});
            assert.ok(responses.length, 'unexpected network request');
            return responses.shift();
        }
    });
    return {provider, requests, opened};
}

test('connects explicitly and keeps the login ticket on the BFF', async () => {
    const session = credentials();
    const {provider, requests, opened} = fixture([
        Response.json({ticket, authorizationUrl}),
        new Response(null, {status: 202}),
        Response.json(session),
        Response.json(session),
        new Response(null, {status: 204})
    ]);
    assert.deepEqual(await provider.getState(), {status: 'disconnected'});
    assert.equal(await provider.getSession(), null);
    assert.equal(requests.length, 0);
    await provider.connect();
    assert.deepEqual(opened, [authorizationUrl]);
    assert.deepEqual(await provider.getState(), {status: 'connecting'});
    assert.deepEqual(await provider.getState(), {
        status: 'connected', account: session.account, expiresAt: session.expiresAt
    });
    assert.deepEqual(await provider.getSession(), session);
    await provider.disconnect();
    assert.deepEqual(await provider.getState(), {status: 'disconnected'});
    assert.deepEqual(JSON.parse(requests[0].init.body), {remote, write: true});
    assert.deepEqual(requests.map(({url, init}) => [
        url, init.method, init.headers.Authorization, init.credentials, init.redirect, init.cache
    ]), [
        [bffOrigin + '/v1/git-auth/start', 'POST', undefined, 'omit', 'error', 'no-store'],
        ...['GET', 'GET', 'GET', 'DELETE'].map(method => [
            bffOrigin + '/v1/git-auth/session', method, 'Bearer ' + ticket, 'omit', 'error', 'no-store'
        ])
    ]);
});

test('rejects an unexpected authorization target or proxy and clears an expired session', async () => {
    const badLogin = fixture([
        Response.json({ticket, authorizationUrl: authorizationUrl.replace('github.com', 'other.example')}),
        new Response(null, {status: 204})
    ]);
    await assert.rejects(badLogin.provider.connect(), {code: 'INVALID_RESPONSE'});
    assert.deepEqual(badLogin.opened, []);
    assert.equal(badLogin.requests.at(-1).init.method, 'DELETE');
    const badProxy = fixture([
        Response.json({ticket, authorizationUrl}),
        Response.json({...credentials(), connection: {mode: 'desktop', proxyOrigin}}),
        new Response(null, {status: 401})
    ]);
    await badProxy.provider.connect();
    await assert.rejects(badProxy.provider.getSession(), {code: 'INVALID_RESPONSE'});
    assert.deepEqual(await badProxy.provider.getState(), {status: 'reauth-required'});
    assert.equal(await badProxy.provider.getSession(), null);
});

test('discards a late session response after disconnect', async () => {
    const pending = Promise.withResolvers();
    const {provider} = fixture([
        Response.json({ticket, authorizationUrl}),
        pending.promise,
        new Response(null, {status: 204})
    ]);
    await provider.connect();
    const session = provider.getSession();
    await provider.disconnect();
    pending.resolve(Response.json(credentials()));
    assert.equal(await session, null);
    assert.deepEqual(await provider.getState(), {status: 'disconnected'});
});

test('keeps a failed revocation retryable without making its session available', async () => {
    const {provider, requests} = fixture([
        Response.json({ticket, authorizationUrl}),
        new Response(null, {status: 502}),
        new Response(null, {status: 204})
    ]);
    await provider.connect();
    await assert.rejects(provider.disconnect(), {code: 'REQUEST_FAILED'});
    assert.equal(await provider.getSession(), null);
    await assert.rejects(provider.connect(), {code: 'REVOCATION_PENDING'});
    await provider.disconnect();
    assert.deepEqual(requests.map(({init}) => init.method), ['POST', 'DELETE', 'DELETE']);
});
