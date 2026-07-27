// Production Lambda entrypoints. Wires real AWS clients (region + creds come
// from the Lambda execution environment) into the injectable handlers.
//
// The S3 port below is deliberately five narrow verbs rather than an SDK client
// handed straight to the handlers. It keeps the handlers testable against an
// in-memory bucket, and it makes each function's IAM policy legible: whoever
// reads this file can see exactly which calls each Lambda actually makes.

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
import { absentProven, notRetrievable } from './s3-errors.mjs';
import { gate } from './entitlement-provider.mjs';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3client = new S3Client({});
const BUCKET = () => process.env.MEDIA_BUCKET;

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
				// `unhoistableHeaders`, NOT `signableHeaders`. The latter silently
				// does nothing here: the presigner hoists x-amz-* into query
				// parameters by default, and the resulting URL signs only
				// content-length and host, so S3 rejects the upload with
				// "headers present in the request which were not signed". Marking
				// it unhoistable is what puts it in X-Amz-SignedHeaders and makes
				// the checksum a real constraint instead of a decorative one.
				unhoistableHeaders: new Set(['x-amz-checksum-sha256'])
			}
		);
		return {
			url,
			headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 }
		};
	},

	// Size and checksum without the body — but AWS requires s3:GetObject alongside
	// s3:GetObjectAttributes, so this role CAN read the object. What is real:
	// no delete, no list.
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
			return notRetrievable(e);
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
			return absentProven(e);
		}
	}
};

export const { createNote, readNote, createFile, finalizeFile, claimFile } = makeHandlers(doc, s3, {
	capabilities: gate
});
