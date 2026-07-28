import assert from "node:assert/strict";
import { readFileSync } from "node:fs";


const [beforePath, afterPath, validationName, statsName] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("before and after Route 53 snapshots are required");
if (!validationName || !statsName) throw new Error("exact validation and stats names are required");

const read = (path) => JSON.parse(readFileSync(path, "utf8")).ResourceRecordSets;
const key = (record) => `${record.Name}|${record.Type}|${record.SetIdentifier ?? ""}`;
const before = new Map(read(beforePath).map((record) => [key(record), record]));
const after = new Map(read(afterPath).map((record) => [key(record), record]));
const allowed = new Set([
  `${validationName}|CNAME|`,
  `${statsName}|A|`,
  `${statsName}|AAAA|`,
]);

for (const [recordKey, record] of before) {
  if (allowed.has(recordKey)) continue;
  assert.deepEqual(after.get(recordKey), record, `Route 53 record changed outside the exact stats names: ${recordKey}`);
}
for (const recordKey of after.keys()) {
  if (before.has(recordKey)) continue;
  assert.ok(allowed.has(recordKey), `unexpected Route 53 record added: ${recordKey}`);
}

console.log(`Route 53 preservation pass: ${before.size} existing record sets unchanged`);
