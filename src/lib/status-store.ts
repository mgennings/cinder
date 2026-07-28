const KEY = 'cinder.sender-status.v1';
const MAX_ENTRIES = 64;

type Entry = { token: string; expiresAt: number };
type Entries = Record<string, Entry>;

const now = () => Math.floor(Date.now() / 1000);

function expiry(token: string): number | null {
	try {
		const segment = token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/');
		const claims = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
		return Number.isInteger(claims.exp) ? claims.exp : null;
	} catch {
		return null;
	}
}

function read(): Entries {
	try {
		const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Entries;
		return Object.fromEntries(
			Object.entries(parsed).filter(
				([locator, entry]) =>
					/^[A-Za-z0-9_-]{43}$/.test(locator) &&
					typeof entry?.token === 'string' &&
					Number.isInteger(entry.expiresAt) &&
					entry.expiresAt > now()
			)
		);
	} catch {
		return {};
	}
}

export function rememberTransferStatus(locator: string, token: string): void {
	if (!/^[A-Za-z0-9_-]{43}$/.test(locator)) return;
	const expiresAt = expiry(token);
	if (!expiresAt || expiresAt <= now()) return;
	try {
		const entries = Object.entries({ ...read(), [locator]: { token, expiresAt } }).slice(-MAX_ENTRIES);
		localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
	} catch {
		// Private browsing or a storage policy may refuse local state. Sending and
		// receiving still work; only the sender's later glance is unavailable.
	}
}

export function transferStatusToken(locator: string): string | null {
	const entries = read();
	try {
		localStorage.setItem(KEY, JSON.stringify(entries));
	} catch {}
	return entries[locator]?.token ?? null;
}
