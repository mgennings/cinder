// Production Lambda entrypoints. Wires real AWS clients (region + creds come
// from the Lambda execution environment) into the injectable handlers.
//
// The S3 port below is deliberately four narrow verbs rather than an SDK client
// handed straight to the handlers. It keeps the handlers testable against an
// in-memory bucket, and it makes each function's IAM policy legible: whoever
// reads this file can see that finalize only ever asks for attributes, never a
// body.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	GetObjectAttributesCommand,
	HeadObjectCommand,
	DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeHandlers } from './handlers.mjs';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3client = new S3Client({});
const BUCKET = () => process.env.MEDIA_BUCKET;

// S3 answers "no such object" by throwing. Everywhere Cinder asks whether an
// object exists, absence is a legitimate answer and must not be an exception —
// but a permissions failure or an outage must NOT be quietly read as absence.
// Only the two genuine not-found shapes become null.
function absentOrThrow(e) {
	const status = e?.$metadata?.httpStatusCode;
	if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || status === 404) return null;
	throw e;
}

const s3 = {
	// The upload is signed against this exact key, length, and checksum, so S3
	// itself refuses a substituted object, a resized body, or corrupted bytes.
	// `signableHeaders` is what forces those into the signature instead of
	// letting the presigner hoist them into ignorable query parameters.
	async presignPut({ key, bytes, sha256, expiresIn }) {
		const url = await getSignedUrl(
			s3client,
			new PutObjectCommand({
				Bucket: BUCKET(),
				Key: key,
				ContentLength: bytes,
				ChecksumSHA256: sha256
			}),
			{
				expiresIn,
				signableHeaders: new Set(['content-length', 'x-amz-checksum-sha256'])
			}
		);
		return {
			url,
			headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 }
		};
	},

	// Size and checksum without the body. Needs only s3:GetObjectAttributes.
	async attributes({ key }) {
		try {
			const res = await s3client.send(
				new GetObjectAttributesCommand({
					Bucket: BUCKET(),
					Key: key,
					ObjectAttributes: ['ObjectSize', 'Checksum']
				})
			);
			return {
				contentLength: res.ObjectSize,
				checksumSha256: res.Checksum?.ChecksumSHA256
			};
		} catch (e) {
			return absentOrThrow(e);
		}
	},

	async get({ key }) {
		const res = await s3client.send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
		return res.Body.transformToByteArray();
	},

	async delete({ key }) {
		await s3client.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
	},

	// The absence check. S3 has been strongly read-after-write consistent for
	// deletes since 2020, so a 404 here immediately after DeleteObject is a real
	// answer rather than a race we are hoping to win.
	async head({ key }) {
		try {
			await s3client.send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key }));
			return {};
		} catch (e) {
			return absentOrThrow(e);
		}
	}
};

export const { createNote, readNote, createFile, finalizeFile, claimFile } = makeHandlers(doc, s3);
