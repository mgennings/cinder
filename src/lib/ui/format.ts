// The two ways Cinder renders a fact about a file. Both were written twice —
// once on the sending page and once on the receiving page — which is how a
// byte count starts being rounded differently on the two screens that describe
// the same transfer.

/**
 * Deliberately decimal MB, matching what a phone's file browser shows the
 * person. Agreeing with their operating system beats being pedantic.
 */
export function humanSize(bytes: number): string {
	if (bytes < 1000) return `${bytes} bytes`;
	if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
	return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/**
 * Truncating a filename from the right throws away the extension, which is the
 * part that tells you what you just received. Keep both ends.
 */
export function middleTruncate(name: string, max = 34): string {
	if (name.length <= max) return name;
	const keepEnd = Math.min(12, Math.floor(max / 2));
	return `${name.slice(0, max - keepEnd - 1)}…${name.slice(-keepEnd)}`;
}
