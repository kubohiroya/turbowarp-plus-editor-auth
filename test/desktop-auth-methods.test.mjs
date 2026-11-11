import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGitConnectionSettings} from '../dist/index.js';

const remote = 'https://github.com/owner/project.git';
const other = 'https://github.com/owner/other.git';
const session = () => ({
    connection: {mode: 'desktop', proxyOrigin: 'http://127.0.0.1:49152'},
    account: {login: 'fixture'}, bearer: 'a'.repeat(43), expiresAt: Date.now() + 60_000
});

function fixture() {
    const calls = [];
    const desktop = {
        async getAuthMethods(target) {
            return target === remote ? ['fine-grained-pat', 'git-credential-helper'] : ['fine-grained-pat'];
        },
        begin() {assert.fail('Device Flow is unavailable');},
        async connectPersonalAccessToken(...args) {calls.push(['pat', ...args]); return {status: 'connected'};},
        async connectGitCredential(...args) {calls.push(['helper', ...args]); return null;},
        async authorizeRepository(...args) {calls.push(['authorize', ...args]); return session();},
        async getSession() {return session();},
        async disconnect() {calls.push(['disconnect']);}
    };
    return {calls, desktop};
}

test('Desktop methods use the selected remote and authorize only after a successful connection', async () => {
    const {calls, desktop} = fixture();
    const settings = createGitConnectionSettings({desktop});
    await settings.select('desktop');
    assert.deepEqual(await settings.getDesktopAuthMethods(remote), ['fine-grained-pat', 'git-credential-helper']);
    assert.deepEqual(await settings.getDesktopAuthMethods(other), ['fine-grained-pat']);
    await assert.rejects(settings.connect(remote), {message: 'GIT_UNAVAILABLE'});
    await settings.connect(remote, false, false, {method: 'git-credential-helper', login: 'fixture'});
    assert.equal(settings.getView().state.status, 'disconnected');
    assert.equal(await settings.getSession(remote), null);
    await settings.connect(remote, true, false, {method: 'fine-grained-pat', remember: true});
    assert.equal(settings.getView().state.status, 'connected');
    assert.equal(await settings.getSession(other), null);
    assert.equal((await settings.getSession(remote, true)).account.login, 'fixture');
    await settings.disconnect();
    assert.equal(await settings.getSession(remote), null);
    assert.deepEqual(calls, [['helper', remote, 'fixture'], ['pat', remote, true], ['authorize', remote, true], ['disconnect']]);
});

test('disconnect prevents a late credential reply from authorizing the previous repository', async () => {
    const {calls, desktop} = fixture();
    let finish;
    let started;
    const prompting = new Promise(resolve => {started = resolve;});
    desktop.connectGitCredential = () => new Promise(resolve => {finish = resolve; started();});
    const settings = createGitConnectionSettings({desktop});
    await settings.select('desktop');
    const connecting = settings.connect(remote, false, false, {method: 'git-credential-helper', login: 'fixture'});
    await prompting;
    const disconnecting = settings.disconnect();
    finish({status: 'connected'});
    await Promise.all([connecting, disconnecting]);
    assert.deepEqual(calls, [['disconnect']]);
    assert.equal(await settings.getSession(remote), null);
});

test('a restored Desktop connection still authorizes the selected repository', async () => {
    const {calls, desktop} = fixture();
    let saved = false;
    desktop.restore = async () => saved;
    const settings = createGitConnectionSettings({desktop});
    await settings.select('desktop');
    await assert.rejects(settings.restoreDesktop(remote), {message: 'NO_SAVED_CONNECTION'});
    assert.equal(settings.getView().state.status, 'disconnected');
    saved = true;
    await settings.restoreDesktop(remote);
    assert.equal(settings.getView().state.status, 'connected');
    assert.deepEqual(calls, [['authorize', remote, false]]);
});
