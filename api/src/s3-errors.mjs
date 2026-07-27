// How to read an S3 error, in the two places where it matters.
//
// S3 hides object existence from callers that cannot list a bucket: without
// s3:ListBucket, a request for a missing object returns 403 AccessDenied rather
// than 404 NoSuchKey. Cinder asks "is this object there?" at two moments with
// opposite stakes, so it needs two different readings of that answer. Getting
// them the same way round is a silent catastrophe in one direction and a broken
// product in the other, which is why they live here with a test.

// PROOF OF ABSENCE — used only after the delete, where a wrong answer means
// handing over bytes Cinder promised were unrecoverable.
//
// This must never accept an ambiguous answer. A definitive 404 is evidence the
// object is gone. A 403 means we could not look, and "I am not allowed to look"
// is not a deletion proof. ClaimFileFn holds s3:ListBucket purely so the real
// 404 is available to it. Everything else throws, and throwing means no bytes
// leave.
export function absentProven(e) {
	const status = e?.$metadata?.httpStatusCode;
	if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || status === 404) return null;
	throw e;
}

// NOT RETRIEVABLE — used before anything is destroyed, where the object is
// supposed to exist.
//
// Missing, forbidden, and misconfigured all mean the same thing here: this
// transfer must not become deliverable. Conflating them is safe because every
// branch refuses, and refusing is the conservative direction. FinalizeFileFn
// keeps no s3:ListBucket as a result.
export function notRetrievable(e) {
	const status = e?.$metadata?.httpStatusCode;
	if (status === 404 || status === 403) return null;
	if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.name === 'AccessDenied') return null;
	throw e;
}
