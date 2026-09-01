// Local dev API — mounts the real Lambda handlers behind a tiny Node HTTP
// server, backed by DynamoDB Local and an in-memory stand-in for the private
// media bucket. This is the same handler code that runs in production; only the
// transport, the DynamoDB endpoint, and the bucket differ.
//
// The fake bucket enforces the same things real S3 enforces on a presigned PUT
// — exact length, exact SHA-256 — because a local bucket that accepted anything
// would let a broken upload path pass here and fail in production.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
	DynamoDBClient,
	CreateTableCommand,
	DescribeTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeHandlers } from '../api/src/handlers.mjs';
import { makeVideoHandlers } from '../api/src/video-handlers.mjs';
import { gate } from '../api/src/entitlement-provider.mjs';
import { mintStatusToken, verifyStatusToken } from '../api/src/status-token.mjs';

const PORT = Number(process.env.DEV_API_PORT || 4000);

// The fake bucket's URL has to sit on the SAME host the browser is already
// using, not merely an equivalent one. `localhost` and `127.0.0.1` are
// different origins to the browser and can even resolve to different address
// families, which produces a bare "Failed to fetch" with no CORS message and
// no clue. Everything local is pinned to 127.0.0.1 for exactly this reason.
const HOST = process.env.DEV_API_HOST || '127.0.0.1';

// The gate's secret, defaulted to the SAME literal scripts/dev-identity.mjs
// defaults to. It has to match or the mint signs grants this process refuses —
// which looks exactly like a broken product rather than a mismatched key. The
// default is what stops that from being a thing anyone discovers.
process.env.CAPABILITY_SECRET = process.env.CAPABILITY_SECRET || 'dev-capability-secret';
const DEV_STATUS_SECRET = 'dev-status-secret-separate-from-capability-grants';

// Phone review needs the ADVERTISED origin to differ from the bound one. A
// presigned URL is handed to the browser, so it has to name an address that
// browser can actually reach: on this Mac that is 127.0.0.1, but on Matt's
// iPhone over the tailnet it is the tailnet name, and 127.0.0.1 there is the
// phone itself. Worse, the app's CSP `connect-src` is derived from
// VITE_API_BASE, so a mismatched presign origin is refused by the browser
// before any request leaves — which surfaces as "the connection dropped"
// rather than as a configuration problem. Bind with DEV_API_HOST=0.0.0.0 and
// advertise with DEV_API_PUBLIC_ORIGIN=https://<tailnet-name>:4000.
const ORIGIN = process.env.DEV_API_PUBLIC_ORIGIN || `http://${HOST}:${PORT}`;
process.env.TABLE_NAME = process.env.TABLE_NAME || 'blip-notes';

const raw = new DynamoDBClient({
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
});
const doc = DynamoDBDocumentClient.from(raw);

// --- in-memory private bucket ---------------------------------------------

const objects = new Map(); // key -> { body: Buffer, sha: string }
const grants = new Map(); // key -> { bytes, sha, expiresAtMs }
// Read authorizations, video segments only — the dev twin of a presigned GET.
// Reusable within its window, exactly like the real signature.
const readGrants = new Map(); // key -> { expiresAtMs }

const devS3 = {
	async presignPut({ key, bytes, sha256, expiresIn }) {
		grants.set(key, { bytes, sha: sha256, expiresAtMs: Date.now() + expiresIn * 1000 });
		return {
			url: `${ORIGIN}/dev-bucket/${key}`,
			headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 }
		};
	},
	async presignGet({ key, expiresIn }) {
		readGrants.set(key, { expiresAtMs: Date.now() + expiresIn * 1000 });
		return `${ORIGIN}/dev-bucket/${key}`;
	},
	async attributes({ key }) {
		const o = objects.get(key);
		return o ? { contentLength: o.body.length, checksumSha256: o.sha } : null;
	},
	async get({ key }) {
		const o = objects.get(key);
		if (!o) throw new Error('NoSuchKey');
		return o.body;
	},
	async delete({ key }) {
		objects.delete(key);
	},
	async head({ key }) {
		return objects.has(key) ? {} : null;
	}
};

// The capability gate, and it is the REAL one — api/src/entitlement-provider.mjs,
// the same module lambda.mjs wires in production, verifying a real HMAC against
// CAPABILITY_SECRET. scripts/dev-identity.mjs mints grants with the same secret,
// so the full journey local run proves the actual gate rather than a stand-in.
//
// The literal below is the ONE thing that is not real, and it is deliberately
// narrow: it exists so tests/e2e can exercise the chunked transport with no
// identity server running at all. It is checked only after the real gate has
// already denied, it is never deployed, and it has to be presented explicitly,
// so an unentitled local caller still gets the 402 the e2e suite asserts.
// Do not import this into api/src/.
const DEV_GRANT = 'dev-capability-grant';
// What the dev literal is entitled to, per capability. The video.send row
// carries prepaidExtensions: 2 so tests/e2e can exercise the one-tap prepaid
// path and its exhaustion into 402 without an identity server.
const DEV_GRANT_LIMITS = {
	'transfer.multipart': { maxParts: 64 },
	'video.send': { maxSegments: 128, prepaidExtensions: 2 },
	'video.extend': { extensions: 1 }
};
const devGate = {
	async check(req) {
		const real = await gate.check(req);
		if (real.granted) return real;
		if (req.grant !== DEV_GRANT) return { granted: false };
		const limits = DEV_GRANT_LIMITS[req.capability];
		return limits ? { granted: true, limits } : { granted: false };
	}
};

const devStatusTokens = {
	mint: (claims) => mintStatusToken({ secret: DEV_STATUS_SECRET, ...claims }),
	verify: (token) => verifyStatusToken(token, { secret: DEV_STATUS_SECRET })
};

const { createNote, readNote, createFile, finalizeFile, statusFile, claimFile } = makeHandlers(
	doc,
	devS3,
	{
		capabilities: devGate,
		statusTokens: devStatusTokens
	}
);

// The dev burn scheduler: one timer per session, re-armed by name exactly the
// way EventBridge Scheduler updates the named schedule. unref'd so a pending
// burn never holds the process open.
const burnTimers = new Map(); // pk -> Timeout
const devScheduler = {
	async arm({ pk, segmentPks, atEpoch }) {
		clearTimeout(burnTimers.get(pk));
		const timer = setTimeout(
			() => {
				burnTimers.delete(pk);
				videoHandlers.burnVideo({ pk, segmentPks }).catch((e) => console.error('burn:', e));
			},
			Math.max(0, atEpoch * 1000 - Date.now())
		);
		timer.unref();
		burnTimers.set(pk, timer);
	}
};

const videoHandlers = makeVideoHandlers(doc, devS3, {
	capabilities: devGate,
	statusTokens: devStatusTokens,
	scheduler: devScheduler
});

async function ensureTable() {
	try {
		await raw.send(new DescribeTableCommand({ TableName: process.env.TABLE_NAME }));
	} catch {
		await raw.send(
			new CreateTableCommand({
				TableName: process.env.TABLE_NAME,
				AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
				KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
				BillingMode: 'PAY_PER_REQUEST'
			})
		);
	}
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
	'access-control-allow-headers': 'content-type, x-amz-checksum-sha256'
};

// Stands in for S3's own enforcement of a presigned PUT.
async function handleBucketPut(req, res, key) {
	const grant = grants.get(key);
	if (!grant) return { status: 403, message: 'no such upload grant' };
	if (Date.now() > grant.expiresAtMs) return { status: 403, message: 'upload grant expired' };

	const body = await readBody(req);
	if (body.length !== grant.bytes) return { status: 400, message: 'content-length mismatch' };

	const sha = createHash('sha256').update(body).digest('base64');
	if (sha !== grant.sha) return { status: 400, message: 'checksum mismatch' };
	if (req.headers['x-amz-checksum-sha256'] !== grant.sha) {
		return { status: 400, message: 'declared checksum mismatch' };
	}

	objects.set(key, { body, sha });
	grants.delete(key); // one use, like the signature's window
	return { status: 200, message: 'ok' };
}

const server = createServer(async (req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(204, cors);
		return res.end();
	}

	const url = new URL(req.url, ORIGIN);
	let result;
	try {
		const bucket = url.pathname.match(/^\/dev-bucket\/(.+)$/);
		if (req.method === 'PUT' && bucket) {
			const { status, message } = await handleBucketPut(req, res, bucket[1]);
			res.writeHead(status, { ...cors, 'content-type': 'text/plain' });
			return res.end(message);
		}

		// The dev twin of a presigned segment GET: authorized only while an
		// unexpired read grant exists for the key, which the handler only
		// issues inside an open watch window.
		if (req.method === 'GET' && bucket) {
			const read = readGrants.get(bucket[1]);
			if (!read || Date.now() > read.expiresAtMs || !objects.has(bucket[1])) {
				res.writeHead(403, { ...cors, 'content-type': 'text/plain' });
				return res.end('no such read grant');
			}
			res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
			return res.end(objects.get(bucket[1]).body);
		}

		const burn = url.pathname.match(/^\/notes\/([^/]+)\/burn$/);
		if (req.method === 'POST' && url.pathname === '/notes') {
			result = await createNote({ body: (await readBody(req)).toString() });
		} else if (req.method === 'POST' && burn) {
			result = await readNote({ pathParameters: { id: decodeURIComponent(burn[1]) } });
		} else if (req.method === 'POST' && url.pathname === '/files') {
			result = await createFile({ body: (await readBody(req)).toString() });
		} else if (req.method === 'POST' && url.pathname === '/files/finalize') {
			result = await finalizeFile({ body: (await readBody(req)).toString() });
		} else if (req.method === 'POST' && url.pathname === '/files/status') {
			result = await statusFile({ body: (await readBody(req)).toString() });
		} else if (req.method === 'POST' && url.pathname === '/files/claim') {
			result = await claimFile({ body: (await readBody(req)).toString() });
		} else if (req.method === 'POST' && url.pathname.startsWith('/videos')) {
			const videoRoutes = {
				'/videos': videoHandlers.createVideo,
				'/videos/finalize': videoHandlers.finalizeVideo,
				'/videos/claim': videoHandlers.claimVideo,
				'/videos/segment-url': videoHandlers.segmentUrl,
				'/videos/finished': videoHandlers.finishedVideo,
				'/videos/extend': videoHandlers.extendVideo,
				'/videos/status': videoHandlers.statusVideo,
				'/videos/destroy': videoHandlers.destroyVideo
			};
			const handler = videoRoutes[url.pathname];
			result = handler
				? await handler({ body: (await readBody(req)).toString() })
				: { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };
		} else {
			result = { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };
		}
	} catch (e) {
		result = { statusCode: 500, body: JSON.stringify({ error: String(e?.message || e) }) };
	}

	res.writeHead(result.statusCode, { ...cors, ...(result.headers || {}) });
	// API Gateway decodes a base64 body into binary before it reaches the
	// browser; do the same here so the client sees identical bytes either way.
	res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
});

await ensureTable();
server.listen(PORT, HOST, () => console.log(`dev-api on ${ORIGIN}`));
