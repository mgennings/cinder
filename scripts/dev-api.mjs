// Local dev API — mounts the real Lambda handlers behind a tiny Node HTTP
// server, backed by DynamoDB Local. This is the same handler code that runs in
// production; only the transport and the DynamoDB endpoint differ. Used for
// end-to-end testing without Docker/sam local.

import { createServer } from 'node:http';
import {
	DynamoDBClient,
	CreateTableCommand,
	DescribeTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeHandlers } from '../api/src/handlers.mjs';

const PORT = Number(process.env.DEV_API_PORT || 4000);
process.env.TABLE_NAME = process.env.TABLE_NAME || 'blip-notes';

const raw = new DynamoDBClient({
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
});
const doc = DynamoDBDocumentClient.from(raw);
const { createNote, readNote } = makeHandlers(doc);

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
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => resolve(data));
	});
}

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type'
};

const server = createServer(async (req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(204, cors);
		return res.end();
	}

	const url = new URL(req.url, `http://localhost:${PORT}`);
	let result;
	try {
		if (req.method === 'POST' && url.pathname === '/notes') {
			result = await createNote({ body: await readBody(req) });
		} else {
			const m = url.pathname.match(/^\/notes\/([^/]+)\/burn$/);
			if (req.method === 'POST' && m) {
				result = await readNote({ pathParameters: { id: decodeURIComponent(m[1]) } });
			} else {
				result = { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };
			}
		}
	} catch (e) {
		result = { statusCode: 500, body: JSON.stringify({ error: String(e?.message || e) }) };
	}

	res.writeHead(result.statusCode, { ...cors, ...(result.headers || {}) });
	res.end(result.body);
});

await ensureTable();
server.listen(PORT, () => console.log(`dev-api on http://localhost:${PORT}`));
