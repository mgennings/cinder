// Scratch storage for video bytes, on both sides of the wire:
//
//   - The SENDER stages encrypted segment envelopes here between hashing and
//     uploading. POST /videos pins every segment's exact SHA-256 before any
//     upload grant exists, and a re-encryption would mint a fresh IV and a
//     different hash — so the ciphertext produced for the create call is the
//     ciphertext that must be uploaded, and 512 MiB of it must never be
//     resident in memory at once (src/lib/video/types.ts). Disk is the seam.
//   - The RECIPIENT stages decrypted segments here while the download is
//     narrated, then plays the assembled file from local Blobs with zero
//     further server reads.
//
// OPFS (the browser's origin-private file system) in the browser, a Map in
// vitest. The interface is the minimum both callers need — get() returns a
// Blob so the watch side can assemble playback without pulling 512 MiB
// through memory (a Blob built from File handles reads lazily).

export interface ScratchStore {
	put(key: string, bytes: Uint8Array): Promise<void>;
	/** Null when the key was never written or has been removed. */
	get(key: string): Promise<Blob | null>;
	remove(key: string): Promise<void>;
	/** Best-effort sweep of every key under a prefix. Never throws. */
	removeAll(prefix: string): Promise<void>;
}

// Keys carry '/' as a namespace separator; OPFS filenames cannot. Encoding is
// per-character, so prefix relationships survive it.
const fname = (key: string) => encodeURIComponent(key);

const OPFS_DIR = 'cinder-video';

export function opfsStore(
	directory = navigator.storage
		.getDirectory()
		.then((root) => root.getDirectoryHandle(OPFS_DIR, { create: true }))
): ScratchStore {
	const dir = () => directory;

	return {
		async put(key, bytes) {
			const handle = await (await dir()).getFileHandle(fname(key), { create: true });
			const writable = await handle.createWritable();
			// Same SharedArrayBuffer generic fight as toBuf() in note-crypto: the
			// value is a plain ArrayBufferView at runtime.
			await writable.write(bytes as unknown as ArrayBufferView<ArrayBuffer>);
			await writable.close();
		},
		async get(key) {
			try {
				const handle = await (await dir()).getFileHandle(fname(key));
				return await handle.getFile();
			} catch {
				return null;
			}
		},
		async remove(key) {
			try {
				await (await dir()).removeEntry(fname(key));
			} catch {
				// Already gone is the outcome we wanted.
			}
		},
		async removeAll(prefix) {
			try {
				const d = await dir();
				const doomed: string[] = [];
				for await (const name of d.keys()) {
					if (name.startsWith(fname(prefix))) doomed.push(name);
				}
				for (const name of doomed) await d.removeEntry(name).catch(() => {});
			} catch {
				// A discard that cannot run leaves only local bytes the browser
				// owns; the server-side burn never depended on it.
			}
		}
	};
}

/** The vitest double, and the fallback when OPFS is unavailable. */
export function memoryStore(): ScratchStore {
	const files = new Map<string, Uint8Array>();
	return {
		async put(key, bytes) {
			files.set(key, bytes.slice());
		},
		async get(key) {
			const bytes = files.get(key);
			return bytes ? new Blob([bytes as BlobPart]) : null;
		},
		async remove(key) {
			files.delete(key);
		},
		async removeAll(prefix) {
			for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
		}
	};
}

/**
 * OPFS when the browser has it, memory when it does not. The memory fallback
 * is honest for the product too: everything staged here is discardable by
 * design, and a browser without OPFS simply pays the RAM.
 */
export function scratchStore(preferred?: Promise<ScratchStore>): ScratchStore {
	const fallback = memoryStore();
	const available =
		preferred ??
		(typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
			? navigator.storage
					.getDirectory()
					.then((root) => root.getDirectoryHandle(OPFS_DIR, { create: true }))
					.then((directory) => opfsStore(Promise.resolve(directory)))
			: Promise.resolve(fallback));

	let backend = available.catch(() => fallback);
	let primaryHasBytes = false;
	const switchToFallback = () => {
		backend = Promise.resolve(fallback);
		return fallback;
	};

	return {
		async put(key, bytes) {
			const store = await backend;
			try {
				await store.put(key, bytes);
				if (store !== fallback) primaryHasBytes = true;
			} catch (error) {
				// Falling back before the first successful write loses nothing. Once
				// OPFS holds bytes, changing stores would split one transfer across
				// two backends; surface that failure so the caller can retry instead.
				if (store === fallback || primaryHasBytes) throw error;
				await switchToFallback().put(key, bytes);
			}
		},
		async get(key) {
			const store = await backend;
			try {
				return await store.get(key);
			} catch (error) {
				if (store === fallback || primaryHasBytes) throw error;
				return switchToFallback().get(key);
			}
		},
		async remove(key) {
			try {
				await (await backend).remove(key);
			} catch {
				await fallback.remove(key);
			}
		},
		async removeAll(prefix) {
			try {
				await (await backend).removeAll(prefix);
			} catch {
				await fallback.removeAll(prefix);
			}
		}
	};
}
