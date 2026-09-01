// One process owns the complete local review stack and every process it starts.
// Ctrl-C tears the whole stack down, so a review cannot leave stale servers
// occupying ports and silently serving yesterday's code.

import { execFileSync, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const REVIEW_PORTS = [8000, 4000, 4100, 5190];
const children = [];
let stopping = false;
const phone = process.argv.includes('--phone');

if (process.argv.includes('--help')) {
	console.log('Usage: pnpm review:local | pnpm dev:phone');
	console.log('Starts DynamoDB Local, both local APIs, and the review web app. Phone mode advertises secure Tailscale origins.');
	process.exit(0);
}

function phoneHost() {
	if (process.env.CINDER_PHONE_HOST) return process.env.CINDER_PHONE_HOST.replace(/\.$/, '');
	const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
	const host = status?.Self?.DNSName?.replace(/\.$/, '');
	if (!host) throw new Error('Tailscale did not report this device\'s tailnet hostname');
	return host;
}

function publishPhonePorts(host) {
	for (const port of [4000, 4100, 5190]) {
		execFileSync(
			'tailscale',
			['serve', '--bg', `--https=${port}`, `http://${HOST}:${port}`],
			{ stdio: 'inherit' }
		);
	}
	return {
		api: `https://${host}:4000`,
		identity: `https://${host}:4100`,
		web: `https://${host}:5190`
	};
}

/** Refuse to shadow another local stack or stop a process this command did not start. */
function assertPortAvailable(port) {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', (error) => reject(new Error(`port ${port} is already in use`, { cause: error })));
		server.listen(port, HOST, () => server.close(resolvePort));
	});
}

/** Wait until one spawned service accepts connections. */
async function waitForPort(port) {
	for (let attempt = 0; attempt < 64; attempt += 1) {
		const ready = await new Promise((resolveReady) => {
			const socket = createConnection({ host: HOST, port });
			socket.setTimeout(256);
			socket.once('connect', () => {
				socket.destroy();
				resolveReady(true);
			});
			socket.once('timeout', () => {
				socket.destroy();
				resolveReady(false);
			});
			socket.once('error', () => resolveReady(false));
		});
		if (ready) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 256));
	}
	throw new Error(`service on port ${port} did not become ready`);
}

/** Start a service in its own process group so shutdown reaches its descendants too. */
function start(name, command, args, env = {}) {
	const child = spawn(command, args, {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, ...env },
		stdio: 'inherit'
	});
	children.push({ name, child });
	child.once('exit', (code, signal) => {
		if (stopping) return;
		console.error(`${name} stopped unexpectedly (${signal || code || 'unknown'})`);
		shutdown(code || 1);
	});
	return child;
}

/** Stop only the process groups this command created. */
function shutdown(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const { child } of children) {
		if (!child.pid) continue;
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch (error) {
			if (error?.code !== 'ESRCH') console.error(error);
		}
	}
	setTimeout(() => process.exit(code), 256);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
	await Promise.all(REVIEW_PORTS.map(assertPortAvailable));
	const advertisedPhoneHost = phone ? phoneHost() : '';
	const origins = phone
		? publishPhonePorts(advertisedPhoneHost)
		: {
				api: `http://${HOST}:4000`,
				identity: `http://${HOST}:4100`,
				web: `http://${HOST}:5190`
			};

	start('DynamoDB Local', 'bash', ['./scripts/dynamodb-local.sh']);
	await waitForPort(8000);

	start('Cinder API', 'node', ['./scripts/dev-api.mjs'], {
		DEV_API_PUBLIC_ORIGIN: origins.api
	});
	await waitForPort(4000);

	start('Cinder identity', 'node', ['./scripts/dev-identity.mjs'], {
		CINDER_DEV_ENTITLEMENT_BYPASS: '1',
		CINDER_DEV_INSTANT_SESSION: '1',
		DEV_IDENTITY_PUBLIC_ORIGIN: origins.identity,
		DEV_WEB_ORIGIN: origins.web
	});
	await waitForPort(4100);

	start('Cinder web', 'pnpm', ['dev', '--host', HOST, '--port', '5190', '--strictPort'], {
		CINDER_PHONE_HOST: advertisedPhoneHost,
		VITE_API_BASE: origins.api,
		VITE_VIDEO_REVIEW_DEFAULT: '1',
		VITE_IDENTITY_API_BASE: origins.identity,
		VITE_IDENTITY_HOSTED_UI: origins.identity,
		VITE_IDENTITY_CLIENT_ID: 'dev-cinder-client',
		VITE_DEV_INSTANT_SESSION: '1'
	});
	await waitForPort(5190);

	console.log(`\n${phone ? 'Phone' : 'Local'} review is ready:`);
	console.log(`  ${origins.web}/`);
	console.log('A signed local session is created automatically. Paid capabilities mint without credits.');
	console.log('Press Ctrl-C to stop the complete stack.\n');
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	shutdown(1);
}
