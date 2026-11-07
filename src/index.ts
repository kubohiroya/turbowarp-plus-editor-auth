export type GitConnectionMode = 'desktop' | 'cloudflare';

export interface GitProxyConnection {
    readonly mode: GitConnectionMode;
    readonly proxyOrigin: string;
}

export interface GitAccount {
    readonly login: string;
}

export interface GitProxySession {
    readonly connection: GitProxyConnection;
    readonly account: GitAccount;
    readonly bearer: string;
    /** Milliseconds since the Unix epoch. */
    readonly expiresAt: number;
}

export type GitAuthState =
    | {readonly status: 'disconnected' | 'connecting' | 'reauth-required'}
    | {readonly status: 'connected'; readonly account: GitAccount; readonly expiresAt: number};

export interface GitAuthProvider {
    readonly connection: GitProxyConnection;
    connect(signal?: AbortSignal): Promise<void>;
    getState(): Promise<GitAuthState>;
    getSession(): Promise<GitProxySession | null>;
    disconnect(): Promise<void>;
}

export {createCloudflareGitAuth, CloudflareGitAuthError} from './cloudflare.js';
export type {CloudflareGitAuthOptions} from './cloudflare.js';
