import {createCloudflareGitAuth} from './cloudflare.js';
import {isGitHubRemote} from './github-remote.js';
import type {CloudflareGitAuthOptions} from './cloudflare.js';
import type {GitAuthProvider, GitAuthState, GitConnectionMode, GitProxySession} from './index.js';

export interface DesktopGitPreload {
    begin(remember?: boolean): Promise<{userCode: string; verificationUri: string; expiresAt: number}>;
    finish(): Promise<unknown>;
    authorizeRepository(remote: string, write?: boolean): Promise<GitProxySession | null>;
    getSession(): Promise<GitProxySession | null>;
    disconnect(): Promise<void>;
}

type View = {
    mode: GitConnectionMode | null;
    state: GitAuthState;
    proxyOrigin?: string;
    authorization?: {url: string; userCode?: string};
};

export function createGitConnectionSettings({desktop, cloudflare}: {
    desktop?: DesktopGitPreload | null;
    cloudflare?: Pick<CloudflareGitAuthOptions, 'bffOrigin' | 'proxyOrigin' | 'fetch'> | null;
}) {
    const modes: GitConnectionMode[] = [];
    if (desktop) modes.push('desktop');
    if (cloudflare) modes.push('cloudflare');
    const disconnected: GitAuthState = {status: 'disconnected'};
    let view: View = {mode: null, state: disconnected};
    let provider: GitAuthProvider | null = null;
    let desktopStarted = false;
    let revoking = false;
    let revision = 0;
    let desktopLogin: {done: boolean; failed: boolean; remote: string} | null = null;

    function acceptDesktopSession(session: GitProxySession | null) {
        return session?.connection.mode === 'desktop' &&
            /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(session.connection.proxyOrigin) &&
            URL.parse(session.connection.proxyOrigin)?.origin === session.connection.proxyOrigin &&
            typeof session.account?.login === 'string' && !!session.account.login &&
            typeof session.bearer === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(session.bearer) &&
            Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now() ? session : null;
    }

    async function disconnect() {
        revision++;
        desktopLogin = null;
        view = {mode: view.mode, state: disconnected,
            proxyOrigin: view.mode === 'cloudflare' ? cloudflare?.proxyOrigin : undefined};
        revoking = true;
        if (provider) await provider.disconnect();
        if (desktopStarted) await desktop!.disconnect();
        provider = null;
        desktopStarted = false;
        revoking = false;
    }

    const commands = {
        modes: Object.freeze(modes),
        getView: () => view,
        async select(mode: GitConnectionMode) {
            if (!modes.includes(mode)) throw new Error('GIT_UNAVAILABLE');
            if (view.mode === mode) return;
            await disconnect();
            view = {mode, state: disconnected, proxyOrigin: mode === 'cloudflare' ? cloudflare?.proxyOrigin : undefined};
        },
        async connect(remote: string) {
            if (!isGitHubRemote(remote)) throw new Error('INVALID_REMOTE');
            if (!view.mode || view.state.status === 'connecting' || revoking) throw new Error('GIT_UNAVAILABLE');
            if (provider || desktopStarted) await disconnect();
            const mode = view.mode;
            const active = ++revision;
            view = {...view, state: {status: 'connecting'}};
            try {
                if (mode === 'cloudflare' && cloudflare) {
                    provider = createCloudflareGitAuth({...cloudflare, remote, write: false,
                        openAuthorization(url) {
                            if (revision === active) view = {...view, authorization: {url}};
                        }
                    });
                    await provider.connect();
                } else if (mode === 'desktop' && desktop) {
                    desktopStarted = true;
                    const {userCode, verificationUri, expiresAt} = await desktop.begin(false);
                    if (revision !== active) return;
                    if (verificationUri !== 'https://github.com/login/device' ||
                        !/^[A-Z0-9-]+$/u.test(userCode) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
                        throw new Error('INVALID_RESPONSE');
                    view = {...view, authorization: {url: verificationUri, userCode}};
                    const login = {done: false, failed: false, remote};
                    desktopLogin = login;
                    void desktop.finish().then(
                        () => {login.done = true;},
                        () => {login.failed = true;}
                    );
                }
            } catch (error) {
                if (revision === active) view = {...view, state: disconnected};
                throw error;
            }
        },
        async refresh() {
            if (revoking) return;
            const active = revision;
            if (provider) {
                const state = await provider.getState();
                if (active === revision)
                    view = {...view, state, authorization: state.status === 'connecting' ? view.authorization : undefined};
                return;
            }
            if (!desktop || view.mode !== 'desktop') return;
            if (desktopLogin?.failed) {
                view = {...view, state: {status: 'reauth-required'}, authorization: undefined};
                return;
            }
            if (desktopLogin?.done) {
                const session = acceptDesktopSession(await desktop.authorizeRepository(desktopLogin.remote, false));
                if (active !== revision) return;
                if (!session) throw new Error('SESSION_REQUIRED');
                desktopLogin = null;
                view = {mode: 'desktop', proxyOrigin: session.connection.proxyOrigin,
                    state: {status: 'connected', account: session.account, expiresAt: session.expiresAt}};
            } else if (view.state.status === 'connected') {
                const session = acceptDesktopSession(await desktop.getSession());
                if (active === revision && !session) view = {...view, state: {status: 'reauth-required'}};
            }
        },
        disconnect,
        async getSession(): Promise<GitProxySession | null> {
            if (revoking || view.state.status !== 'connected') return null;
            const active = revision;
            const session = provider ? await provider.getSession() : acceptDesktopSession(await desktop?.getSession() ?? null);
            return active === revision && session?.connection.mode === view.mode &&
                session.connection.proxyOrigin === view.proxyOrigin ? session : null;
        }
    };
    let tail = Promise.resolve();
    function serial(action: () => Promise<void>) {
        const result = tail.then(action);
        tail = result.catch(() => {});
        return result;
    }
    return {...commands,
        select: (mode: GitConnectionMode) => serial(() => commands.select(mode)),
        connect: (remote: string) => serial(() => commands.connect(remote)),
        refresh: () => serial(commands.refresh),
        disconnect: () => serial(disconnect)
    };
}
