// Production entrypoints for the video API, wired the way lambda.mjs wires the
// file handlers: real AWS clients into the injectable handlers, an S3 port of
// narrow verbs so each function's IAM policy is legible from the code.
//
// Two things exist here and not in lambda.mjs, both confined to video:
//
//   presignGet — the one deliberate departure from the file path. Video
//     ciphertext flows from S3 directly because a 512 MiB watch cannot ride a
//     6 MB buffered Lambda response. The SegmentUrlFn role's s3:GetObject is
//     scoped to v/* in template.yaml, so this signer structurally cannot name
//     a burn-mode file object.
//
//   the burn scheduler — a one-shot EventBridge Scheduler entry per open watch
//     session, armed at claim and re-armed on finished and extend, targeting
//     burnVideo below. Its payload is hashes only, never a locator, so the
//     schedule store holds nothing replayable against the API.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	GetObjectAttributesCommand,
	DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
	SchedulerClient,
	CreateScheduleCommand,
	UpdateScheduleCommand
} from '@aws-sdk/client-scheduler';
import { createHash } from 'node:crypto';
import { makeVideoHandlers } from './video-handlers.mjs';
import { notRetrievable } from './s3-errors.mjs';
import { gate } from './entitlement-provider.mjs';
import { mintStatusToken, verifyStatusToken } from './status-token.mjs';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3client = new S3Client({});
const schedulerClient = new SchedulerClient({});
const BUCKET = () => process.env.MEDIA_BUCKET;

const statusTokens = {
	mint: (claims) => mintStatusToken({ secret: process.env.STATUS_SECRET, ...claims }),
	verify: (token) => verifyStatusToken(token, { secret: process.env.STATUS_SECRET })
};

const s3 = {
	// Identical discipline to lambda.mjs: the checksum is forced into the
	// signature with unhoistableHeaders, so S3 itself refuses a substituted or
	// resized body. See the long note there; do not "simplify" the option.
	async presignPut({ key, bytes, sha256, expiresIn }) {
		const url = await getSignedUrl(
			s3client,
			new PutObjectCommand({
				Bucket: BUCKET(),
				Key: key,
				ContentLength: bytes,
				ChecksumSHA256: sha256
			}),
			{ expiresIn, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) }
		);
		return {
			url,
			headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 }
		};
	},

	// The departure, in one verb. `expiresIn` is capped by the handler at
	// min(480, deadline - now), so an issued URL never outlives the deadline.
	async presignGet({ key, expiresIn }) {
		return getSignedUrl(s3client, new GetObjectCommand({ Bucket: BUCKET(), Key: key }), {
			expiresIn
		});
	},

	async attributes({ key }) {
		try {
			const res = await s3client.send(
				new GetObjectAttributesCommand({
					Bucket: BUCKET(),
					Key: key,
					ObjectAttributes: ['ObjectSize', 'Checksum']
				})
			);
			return { contentLength: res.ObjectSize, checksumSha256: res.Checksum?.ChecksumSHA256 };
		} catch (e) {
			return notRetrievable(e);
		}
	},

	async delete({ key }) {
		await s3client.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
	}
};

// One schedule per video, named by a hash of the session pk so the name
// carries nothing readable and re-arming is an update of the same entry
// rather than a second timer. ActionAfterCompletion DELETE makes it one-shot
// and self-cleaning; the burn handler's deadline guard makes a stale one
// harmless.
const scheduleName = (pk) =>
	`cinder-video-burn-${createHash('sha256').update(pk, 'utf8').digest('hex').slice(0, 40)}`;

const scheduler = {
	async arm({ pk, segmentPks, atEpoch }) {
		const at = new Date(atEpoch * 1000).toISOString().slice(0, 19);
		const input = {
			Name: scheduleName(pk),
			GroupName: process.env.BURN_SCHEDULE_GROUP || 'default',
			ScheduleExpression: `at(${at})`,
			FlexibleTimeWindow: { Mode: 'OFF' },
			ActionAfterCompletion: 'DELETE',
			Target: {
				Arn: process.env.BURN_FUNCTION_ARN,
				RoleArn: process.env.BURN_SCHEDULER_ROLE_ARN,
				Input: JSON.stringify({ pk, segmentPks }),
				RetryPolicy: { MaximumRetryAttempts: 8, MaximumEventAgeInSeconds: 3600 }
			}
		};
		try {
			await schedulerClient.send(new CreateScheduleCommand(input));
		} catch (e) {
			if (e?.name !== 'ConflictException') throw e;
			await schedulerClient.send(new UpdateScheduleCommand(input));
		}
	}
};

export const {
	createVideo,
	finalizeVideo,
	claimVideo,
	segmentUrl,
	finishedVideo,
	extendVideo,
	statusVideo,
	destroyVideo,
	burnVideo
} = makeVideoHandlers(doc, s3, { capabilities: gate, statusTokens, scheduler });
