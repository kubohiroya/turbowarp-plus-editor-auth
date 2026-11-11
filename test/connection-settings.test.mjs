import assert from 'node:assert/strict';
import test from 'node:test';
import {createGitConnectionSettings} from '../dist/index.js';

const remote = 'https://github.com/owner/repo.git';
const state = 's'.repeat(43);
const ticket = state + '.' + 't'.repeat(43);
const authorizationUrl = 'https://github.com/login/oauth/authorize?state=' + state;

function desktopSession() {
    return {
        connection: {mode: 'desktop', proxyOrigin: 'http://127.0.0.1:4567'},
        account: {login: 'octocat'},
        bearer: 'd'.repeat(43),
        expiresAt: Date.now() + 60_000
    };
}

function desktopPreload() {
    const calls = [];
    return {
        calls,
        async begin() {
            return {userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 60_000};
        },
        async finish() {},
        async authorizeRepository(...args) {
            calls.push(args);
            return desktopSession();
        },
        async getSession() {
            return desktopSession();
        },
        async disconnect() {}
    };
}

test('passes the review grant to Desktop and exposes it in the view', async () => {
    const desktop = desktopPreload();
    const settings = createGitConnectionSettings({desktop});
    await settings.select('desktop');
    await settings.connect(remote, false, true);
    await new Promise(resolve => setTimeout(resolve));
    await settings.refresh();
    assert.deepEqual(desktop.calls, [[remote, false, true]]);
    assert.equal(settings.getView().review, true);
    assert.equal(settings.getView().state.status, 'connected');
    assert.ok(await settings.getSession(remote, false, true));
    assert.equal(await settings.getSession(remote, true, true), null);
});

test('keeps the Desktop call unchanged without review and refuses a review session', async () => {
    const desktop = desktopPreload();
    const settings = createGitConnectionSettings({desktop});
    await settings.select('desktop');
    await settings.connect(remote, true);
    await new Promise(resolve => setTimeout(resolve));
    await settings.refresh();
    assert.deepEqual(desktop.calls, [[remote, true]]);
    assert.equal(settings.getView().review, false);
    assert.ok(await settings.getSession(remote, true));
    assert.equal(await settings.getSession(remote, false, true), null);
});

test('sends the review grant to the Cloudflare BFF', async () => {
    const requests = [];
    const settings = createGitConnectionSettings({cloudflare: {
        bffOrigin: 'https://auth.example', proxyOrigin: 'https://git.example',
        fetch: async (url, init) => {
            requests.push({url, init});
            return Response.json({ticket, authorizationUrl});
        }
    }});
    await settings.select('cloudflare');
    await settings.connect(remote, false, true);
    assert.deepEqual(JSON.parse(requests[0].init.body), {remote, write: false, review: true});
    assert.equal(settings.getView().review, true);
    assert.equal(settings.getView().authorization.url, authorizationUrl);
});
