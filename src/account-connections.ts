// SPDX-License-Identifier: MPL-2.0
import {createGitConnectionSettings, type DesktopGitPreload, type DesktopGitAuthOptions} from './connection-settings.js';
import type {CloudflareGitAuthOptions} from './cloudflare.js';
import type {GitConnectionMode, GitProxySession} from './index.js';
import {isGitHubUserId, publicGitHubAccount} from './identity.js';
import {browserSignOutStorage, loadSignOutReceipts, signOutStorageKey,
    type GitSignOutReceipt, type SignOutStorage} from './signout.js';

/** Each slot is a separate privileged auth service, not a switch of one service's credentials. */
export interface DesktopGitAccounts {
    create(): Promise<string>;
    begin(slot: string): ReturnType<DesktopGitPreload['begin']>;
    finish(slot: string): Promise<unknown>;
    authorizeRepository(slot: string, remote: string, write?: boolean, review?: boolean): Promise<GitProxySession | null>;
    getSession(slot: string): Promise<GitProxySession | null>;
    disconnect(slot: string): Promise<void>;
}
type Settings = ReturnType<typeof createGitConnectionSettings>;
export function createGitAccountConnections({desktop, cloudflare, primary, signOutStorage = browserSignOutStorage()}: {
    desktop?: DesktopGitAccounts | null;
    cloudflare?: Pick<CloudflareGitAuthOptions, 'bffOrigin' | 'proxyOrigin' | 'fetch'> | null;
    primary?: Settings;
    signOutStorage?: SignOutStorage;
}) {
    const slots = new Map<string, Settings>();
    const receipts = new Map(loadSignOutReceipts(signOutStorage).map(receipt => [receipt.id, receipt]));
    const stopping = new Map<string, Promise<void>>();
    const listeners = new Set<() => void>();
    let closed = false, primaryPending = false;
    let receiptsRecorded = !!signOutStorage;
    const notify = () => {
        const safe = [...receipts.values()].slice(-100).map(({retryable: _, ...receipt}) => receipt);
        try {signOutStorage?.setItem(signOutStorageKey, JSON.stringify(safe)); receiptsRecorded = !!signOutStorage;}
        catch {receiptsRecorded = false;}
        for (const listener of listeners) {try {listener();} catch { /* A view cannot prevent credential disposal. */ }}
    };
    const reportView = (receipt: GitSignOutReceipt) => ({id: receipt.id, mode: receipt.mode,
        state: {status: 'disconnected' as const}, signOut: {...receipt, recorded: receiptsRecorded,
            retryable: slots.has(receipt.id) && !stopping.has(receipt.id)}});
    function disconnect(id: string): Promise<void> {
        const pending = stopping.get(id);
        if (pending) return pending;
        const settings = slots.get(id);
        if (!settings) return Promise.resolve();
        const before = settings.getView(), previous = receipts.get(id);
        receipts.set(id, {id, mode: before.mode, at: previous?.at ?? Date.now(), local: 'stopped', session: 'pending', github: 'unconfirmed',
            retryable: false, ...('account' in before.state ? {account: publicGitHubAccount(before.state.account)!} : previous?.account && {account: previous.account})});
        // Calling settings.disconnect starts the local barrier synchronously, outside the command queue.
        const operation = settings.disconnect().then(async () => {
            if (before.mode === 'desktop' && settings !== primary) await desktop!.disconnect(id);
            const status = settings.getView().signOut;
            receipts.set(id, {...receipts.get(id)!, ...(status ?? {session: 'revoked' as const}), retryable: false});
            slots.delete(id);
        }).catch(error => {
            receipts.set(id, {...receipts.get(id)!, ...settings.getView().signOut, retryable: true});
            throw error;
        }).finally(() => {stopping.delete(id); notify();});
        stopping.set(id, operation); notify(); return operation;
    }
    const modes: GitConnectionMode[] = [...desktop || primary?.modes.includes('desktop') ? ['desktop' as const] : [], ...cloudflare ? ['cloudflare' as const] : []];
    return {
        modes,
        canRestoreDesktop: !!primary?.canRestoreDesktop,
        async restoreDesktop(remote: string, write = false, review = false) {
            return this.begin(remote, 'desktop', write, review, {method: 'github-app'}, true);
        },
        getDesktopAuthMethods: (remote?: string) => primary?.getDesktopAuthMethods(remote) ?? Promise.resolve(desktop ? ['github-app' as const] : []),
        async begin(remote: string, mode: GitConnectionMode = modes[0], write = false, review = false,
            auth: DesktopGitAuthOptions = {method: 'github-app'}, restore = false) {
            if (closed || !modes.includes(mode) || slots.size >= 16) throw new Error('GIT_UNAVAILABLE');
            const usePrimary = mode === 'desktop' && (!desktop || auth.method !== 'github-app' || restore);
            if (usePrimary && !primary) throw new Error('GIT_UNAVAILABLE');
            if (usePrimary && primaryPending) throw new Error('GIT_UNAVAILABLE');
            if (usePrimary) primaryPending = true;
            try {
            if (usePrimary) for (const [id, settings] of slots) if (settings === primary) await disconnect(id);
            const id = mode === 'desktop' && !usePrimary ? await desktop!.create() : crypto.randomUUID();
            if (closed) {if (mode === 'desktop' && !usePrimary) await desktop!.disconnect(id); throw new Error('SESSION_REQUIRED');}
            const scoped: DesktopGitPreload | undefined = mode === 'desktop' && !usePrimary ? {
                begin: () => desktop!.begin(id), finish: () => desktop!.finish(id),
                authorizeRepository: (target, write, review) => desktop!.authorizeRepository(id, target, write, review),
                getSession: () => desktop!.getSession(id), disconnect: () => desktop!.disconnect(id)
            } : undefined;
            const settings = usePrimary ? primary! : createGitConnectionSettings({desktop: scoped,
                cloudflare: mode === 'cloudflare' ? {...cloudflare!, selectAccount: true} : undefined});
            slots.set(id, settings);
            try {
                await settings.select(mode);
                if (closed || receipts.has(id)) throw new Error('SESSION_REQUIRED');
                if (restore) await settings.restoreDesktop(remote, write, review);
                else await settings.connect(remote, write, review, auth);
                if (closed || receipts.has(id)) throw new Error('SESSION_REQUIRED');
                notify();
                return {id, ...settings.getView()};
            } catch (error) {
                await disconnect(id).catch(() => {});
                throw error;
            }
            } finally {if (usePrimary) primaryPending = false;}
        },
        async refresh(id: string) {
            const settings = slots.get(id);
            if (!settings || receipts.has(id)) throw new Error('SESSION_REQUIRED');
            await settings.refresh();
            if (closed || receipts.has(id)) throw new Error('SESSION_REQUIRED');
            const view = settings.getView();
            if (view.state.status === 'connected') {
                const accountId = view.state.account.id;
                if (!isGitHubUserId(accountId)) throw new Error('ACCOUNT_ID_REQUIRED');
                const previous = [...slots].find(([otherId, other]) => otherId !== id &&
                    other.getView().state.status === 'connected' &&
                    (other.getView().state as {account?: {id?: number}}).account?.id === accountId);
                if (previous) {
                    const [previousId, old] = previous;
                    if (old.getView().write && !view.write) {
                        await settings.disconnect(); slots.delete(id); return {id: previousId, ...old.getView()};
                    }
                    await old.disconnect(); slots.set(previousId, settings); slots.delete(id); notify();
                    return {id: previousId, ...settings.getView()};
                }
            }
            notify(); return {id, ...settings.getView()};
        },
        list: () => [...[...slots].filter(([id]) => !receipts.has(id)).map(([id, settings]) => {
            const view = settings.getView();
            return view.state.status === 'connected' && !isGitHubUserId(view.state.account.id) ?
                {id, ...view, state: {status: 'reauth-required' as const}} : {id, ...view};
        }),
            ...[...receipts.values()].map(reportView)],
        subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
        /** Capture the selected slot once. Subsequent UI changes cannot redirect an in-flight request. */
        bind(id: string) {
            const settings = slots.get(id);
            if (closed || !settings || receipts.has(id)) throw new Error('SESSION_REQUIRED');
            const state = settings.getView().state;
            if (state.status !== 'connected' || !isGitHubUserId(state.account.id)) throw new Error('ACCOUNT_ID_REQUIRED');
            const accountId = state.account.id;
            return async (...args: Parameters<Settings['getSession']>) => {
                if (closed || receipts.has(id)) return null;
                const result = await settings.getSession(...args);
                return !closed && !receipts.has(id) && result?.account.id === accountId ? result : null;
            };
        },
        disconnect,
        async disconnectAll() {
            const results = await Promise.allSettled([...slots.keys()].map(disconnect));
            const failed = results.find(result => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        },
        async dispose() {
            closed = true;
            const results = await Promise.allSettled([...slots.keys()].map(disconnect));
            const failed = results.find(result => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        }
    };
}
