import {createCloudflareGitAuth} from './cloudflare.js';
import {isGitHubRemote} from './github-remote.js';
import type {CloudflareGitAuthOptions} from './cloudflare.js';
import type {GitAuthProvider, GitAuthState, GitConnectionMode, GitProxySession} from './index.js';

const desktopMethods = ['github-app', 'fine-grained-pat', 'git-credential-helper'] as const;
export type DesktopGitAuthMethod = typeof desktopMethods[number];
export type DesktopGitAuthOptions =
    | {method: 'github-app'}
    | {method: 'fine-grained-pat'; remember: boolean}
    | {method: 'git-credential-helper'; login: string};
type DesktopTokenConnection = {status: 'connected'} | null;

export interface DesktopGitPreload {
    getAuthMethods?(remote?: string): Promise<readonly DesktopGitAuthMethod[]>;
    connectPersonalAccessToken?(remote: string, remember?: boolean): Promise<DesktopTokenConnection>;
    connectGitCredential?(remote: string, login: string): Promise<DesktopTokenConnection>;
    restore?(): Promise<boolean>;
    begin(remember?: boolean): Promise<{userCode: string; verificationUri: string; expiresAt: number}>;
    finish(): Promise<unknown>;
    authorizeRepository(remote: string, write?: boolean, review?: boolean): Promise<GitProxySession | null>;
    getSession(): Promise<GitProxySession | null>;
    disconnect(): Promise<void>;
}

type View = {
    mode: GitConnectionMode | null;
    state: GitAuthState;
    proxyOrigin?: string;
    write?: boolean;
    review?: boolean;
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
    let pendingDisconnects = 0;
    let revision = 0;
    let remote: string | null = null;
    let desktopLogin: {done: boolean; failed: boolean; remote: string} | null = null;

    function acceptDesktopSession(session: GitProxySession | null) {
        return session?.connection.mode === 'desktop' &&
            /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(session.connection.proxyOrigin) &&
            URL.parse(session.connection.proxyOrigin)?.origin === session.connection.proxyOrigin &&
            typeof session.account?.login === 'string' && !!session.account.login &&
            typeof session.bearer === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(session.bearer) &&
            Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now() ? session : null;
    }

    async function getDesktopAuthMethods(target?: string): Promise<readonly DesktopGitAuthMethod[]> {
        if (!desktop) return [];
        if (!desktop.getAuthMethods) return ['github-app'];
        if (target !== undefined && !isGitHubRemote(target)) return [];
        const supported = await desktop.getAuthMethods(target);
        return desktopMethods.filter(method => supported.includes(method) &&
            (method !== 'fine-grained-pat' || !!desktop.connectPersonalAccessToken) &&
            (method !== 'git-credential-helper' || !!desktop.connectGitCredential));
    }

    async function authorizeDesktop(target: string, write: boolean | undefined, review: boolean | undefined, active: number) {
        const session = acceptDesktopSession(await (review
            ? desktop!.authorizeRepository(target, write, true)
            : desktop!.authorizeRepository(target, write)));
        if (active !== revision) return;
        if (!session) throw new Error('SESSION_REQUIRED');
        desktopLogin = null;
        view = {mode: 'desktop', proxyOrigin: session.connection.proxyOrigin, write, review,
            state: {status: 'connected', account: session.account, expiresAt: session.expiresAt}};
    }

    function cancelDesktopConnection() {
        remote = null;
        desktopStarted = false;
        view = {mode: 'desktop', state: disconnected};
    }

    async function disconnect() {
        revision++;
        remote = null;
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
        getDesktopAuthMethods,
        canRestoreDesktop: !!desktop?.restore,
        getView: () => view,
        async select(mode: GitConnectionMode) {
            if (!modes.includes(mode)) throw new Error('GIT_UNAVAILABLE');
            if (view.mode === mode) return;
            await disconnect();
            view = {mode, state: disconnected, proxyOrigin: mode === 'cloudflare' ? cloudflare?.proxyOrigin : undefined};
        },
        async connect(target: string, write = false, review = false, auth: DesktopGitAuthOptions = {method: 'github-app'}) {
            if (!isGitHubRemote(target)) throw new Error('INVALID_REMOTE');
            if (!view.mode || view.state.status === 'connecting' || revoking) throw new Error('GIT_UNAVAILABLE');
            if (provider || desktopStarted) await disconnect();
            const mode = view.mode;
            const active = ++revision;
            remote = target;
            view = {...view, write, review, state: {status: 'connecting'}};
            try {
                if (mode === 'cloudflare' && cloudflare) {
                    provider = createCloudflareGitAuth({...cloudflare, remote: target, write, review,
                        openAuthorization(url) {
                            if (revision === active) view = {...view, authorization: {url}};
                        }
                    });
                    await provider.connect();
                } else if (mode === 'desktop' && desktop) {
                    if (!(await getDesktopAuthMethods(target)).includes(auth.method)) throw new Error('GIT_UNAVAILABLE');
                    if (revision !== active || pendingDisconnects) return;
                    desktopStarted = true;
                    if (auth.method !== 'github-app') {
                        const result = auth.method === 'fine-grained-pat' ?
                            await desktop.connectPersonalAccessToken!(target, auth.remember) :
                            await desktop.connectGitCredential!(target, auth.login);
                        if (revision !== active) return;
                        if (result === null) return cancelDesktopConnection();
                        if (pendingDisconnects) return;
                        if (result.status !== 'connected') throw new Error('INVALID_RESPONSE');
                        await authorizeDesktop(target, write, review, active);
                        return;
                    }
                    const {userCode, verificationUri, expiresAt} = await desktop.begin(false);
                    if (revision !== active) return;
                    if (verificationUri !== 'https://github.com/login/device' ||
                        !/^[A-Z0-9-]+$/u.test(userCode) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
                        throw new Error('INVALID_RESPONSE');
                    view = {...view, authorization: {url: verificationUri, userCode}};
                    const login = {done: false, failed: false, remote: target};
                    desktopLogin = login;
                    void desktop.finish().then(
                        () => {login.done = true;},
                        () => {login.failed = true;}
                    );
                }
            } catch (error) {
                if (revision === active) view = {...view, state: disconnected, authorization: undefined};
                throw error;
            }
        },
        async restoreDesktop(target: string, write = false, review = false) {
            if (!isGitHubRemote(target)) throw new Error('INVALID_REMOTE');
            if (view.mode !== 'desktop' || !desktop?.restore || view.state.status === 'connecting' || revoking)
                throw new Error('GIT_UNAVAILABLE');
            if (desktopStarted) await disconnect();
            const active = ++revision;
            remote = target;
            desktopStarted = true;
            view = {...view, write, review, state: {status: 'connecting'}};
            try {
                const restored = await desktop.restore();
                if (revision !== active) return;
                if (!restored) {
                    cancelDesktopConnection();
                    throw new Error('NO_SAVED_CONNECTION');
                }
                if (pendingDisconnects) return;
                await authorizeDesktop(target, write, review, active);
            } catch (error) {
                if (active === revision) view = {...view, state: disconnected};
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
                await authorizeDesktop(desktopLogin.remote, view.write, view.review, active);
            } else if (view.state.status === 'connected') {
                const session = acceptDesktopSession(await desktop.getSession());
                if (active === revision && !session) view = {...view, state: {status: 'reauth-required'}};
            }
        },
        disconnect,
        async getSession(target?: string, write = false, review = false): Promise<GitProxySession | null> {
            if (revoking || pendingDisconnects || view.state.status !== 'connected' || (target !== undefined && target !== remote) ||
                (write && !view.write) || (review && !view.review)) return null;
            const active = revision;
            const session = provider ? await provider.getSession() : acceptDesktopSession(await desktop?.getSession() ?? null);
            return !pendingDisconnects && active === revision && session?.connection.mode === view.mode &&
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
        connect: (remote: string, write?: boolean, review?: boolean, auth?: DesktopGitAuthOptions) =>
            serial(() => commands.connect(remote, write, review, auth)),
        restoreDesktop: (remote: string, write?: boolean, review?: boolean) => serial(() => commands.restoreDesktop(remote, write, review)),
        refresh: () => serial(commands.refresh),
        disconnect() {
            pendingDisconnects++;
            return serial(disconnect).finally(() => {pendingDisconnects--;});
        }
    };
}
