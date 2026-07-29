// The published privacy claim for reading a field note.
//
// ONE string, rendered by /field-notes and by /field-notes/<slug>, because a
// corrected sentence sitting beside a stale copy of itself is not a correction.
// Anything that wants to say this says it by importing this constant.
//
// Every clause is here because something in the repository actually makes it
// true, and the two are checked together:
//
//   "no analytics, nothing from anyone else" — vite.config.ts sets CSP
//        default-src 'none' with script-src, img-src, and font-src pinned to
//        'self'. There is no origin a third-party script could load from.
//   "sets no cookie, saves nothing about you" — tests/e2e/field-notes-privacy.spec.ts
//        wraps Storage.prototype.setItem before navigation and asserts zero
//        cookies and zero storage writes on both routes.
//   "caches this site's own files" — src/service-worker.ts precaches the built
//        shell into CacheStorage, which IS browser storage. The sentence names
//        it rather than claiming an absolute the code does not support.
//   "the delivery network sees the request" — a browser assertion cannot see
//        the edge. src/routes/field-notes/privacy-claim.test.ts guards the
//        CloudFront and S3 half of that in template.yaml.
//
// Never widen this back to "reading a note collects nothing." That absolute is
// false the moment anyone toggles CloudFront access logging, and a shipped
// string claiming a privacy property the code lacks is the same defect class as
// a false legal claim.
export const READ_PRIVACY_CLAIM =
	"Cinder runs no analytics and loads nothing from anyone else. Reading a note sets no cookie, saves nothing about you in your browser, and leaves Cinder no record of who read what. Your browser caches this site's own files so it opens offline, and the delivery network in front of it sees the request the way any web server must in order to answer it.";

// The half of the claim that stops being true the instant edge access logging
// is switched on. Named separately so the infrastructure guard can assert
// against the exact clause instead of a fuzzy substring of the whole sentence.
export const NO_EDGE_RECORD_CLAUSE = 'leaves Cinder no record of who read what';
