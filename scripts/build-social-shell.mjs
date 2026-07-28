import { readFile, writeFile } from 'node:fs/promises';

const shellPath = new URL('../build/200.html', import.meta.url);
const notePath = new URL('../build/note.html', import.meta.url);

const replacements = new Map([
	['Cinder — an encrypted note or file retrieved once', 'Someone left you a one-time note · Cinder'],
	[
		'Encrypted in your browser, the key never touches the server. One successful reveal removes Cinder\'s stored copy.',
		'Encrypted in the sender\'s browser. Revealing it removes Cinder\'s stored copy.'
	],
	['https://cinder.ink/og.png', 'https://cinder.ink/og-note.png']
]);

let noteShell = await readFile(shellPath, 'utf8');

for (const [from, to] of replacements) {
	if (!noteShell.includes(from)) throw new Error(`social shell source missing: ${from}`);
	noteShell = noteShell.replaceAll(from, to);
}

await writeFile(notePath, noteShell);
