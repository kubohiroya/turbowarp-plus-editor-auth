export function isGitHubRemote(remote: string) {
    const match = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(remote);
    return !!match && match[0] === remote && !['.', '..', '.git'].includes(match[1].toLowerCase());
}
