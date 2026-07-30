#!/usr/bin/env bash
# Offline proof for the recursive alias loop in scripts/deploy-frontend.sh.
#
# Builds a fixture tree under a temp directory, runs the loop's exact skip
# and key-derivation logic against it with the `aws s3 cp` publish call
# replaced by an `echo` of the key, and asserts specific keys are present or
# absent. Framework-free, assert-based, run directly, no test runner needed:
#
#   scripts/test-deploy-aliases.sh
#
# This check has been run, by hand, against the ORIGINAL non-recursive glob
# loop this repo shipped before the alias fix (`for f in build/*.html`), and
# it failed there exactly as expected: it could not find
# `field-notes/the-vote-to-stay-blind` because the glob never descended into
# `build/field-notes/`. A check nobody has watched fail is indistinguishable
# from a check that cannot fail. This one has been watched fail.
set -euo pipefail

pass=0
fail=0

assert_contains() {
	local label="$1" haystack="$2" needle="$3"
	if printf '%s\n' "$haystack" | grep -qxF -- "$needle"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		echo "FAIL: $label: expected '$needle' in key set"
	fi
}

assert_not_contains() {
	local label="$1" haystack="$2" needle="$3"
	if printf '%s\n' "$haystack" | grep -qxF -- "$needle"; then
		fail=$((fail + 1))
		echo "FAIL: $label: '$needle' must NOT be in key set"
	else
		pass=$((pass + 1))
	fi
}

assert_count() {
	local label="$1" haystack="$2" want="$3"
	local got
	got="$(printf '%s\n' "$haystack" | grep -c . || true)"
	if [ "$got" -eq "$want" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		echo "FAIL: $label: got $got keys, want $want"
		printf '  %s\n' "$haystack"
	fi
}

# Mirrors the loop in deploy-frontend.sh exactly (same skip guards, same key
# derivation) with one substitution: `aws s3 cp ...` becomes `echo "$key"`,
# since this check never publishes anything. The operator-facing progress
# line (`echo "  /$key"`) is omitted: it is terminal output, not loop logic.
run_loop() {
	local html_list
	html_list="$(mktemp)"
	find build -type f -name '*.html' -print0 > "$html_list"
	while IFS= read -r -d '' f; do
		rel="${f#build/}"
		base="${rel##*/}"
		base="${base%.html}"
		[ "$base" = "index" ] && continue
		[ "$rel" = "200.html" ] && continue
		key="${rel%.html}"
		echo "$key"
	done < "$html_list"
	rm -f "$html_list"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# --- Case 1: depth, spaces, root skips, nested index/200 --------------------
mkdir -p "build/field-notes/deep/deeper"
: > build/index.html                                # root skip
: > build/200.html                                  # root skip
: > build/security.html                             # depth 0 page
: > build/field-notes.html                          # depth 0 page
: > "build/field-notes/the-vote-to-stay-blind.html"     # depth 1
: > "build/field-notes/deep/deeper/still-here.html"     # depth 4, proves depth is not special-cased
: > build/field-notes/index.html                    # nested index: must skip
: > build/field-notes/200.html                      # nested 200: must NOT skip
mkdir -p "build/field notes with space"
: > "build/field notes with space/a b.html"          # space in path must survive intact

keys="$(run_loop)"
assert_contains     "depth 0 page (field-notes)"      "$keys" "field-notes"
assert_contains     "depth 0 page (security)"         "$keys" "security"
assert_contains     "depth 1 nested page"             "$keys" "field-notes/the-vote-to-stay-blind"
assert_contains     "depth 4 nested page"             "$keys" "field-notes/deep/deeper/still-here"
assert_contains     "space in path survives intact"   "$keys" "field notes with space/a b"
assert_contains     "nested 200.html is aliased"      "$keys" "field-notes/200"
assert_not_contains "root index.html is skipped"      "$keys" "index"
assert_not_contains "root 200.html is skipped"        "$keys" "200"
assert_not_contains "nested index.html is skipped"    "$keys" "field-notes/index"
assert_count        "case 1 total key count"          "$keys" 6

rm -rf build

# --- Case 2: leading-dash filename must not abort the run -------------------
mkdir -p build
: > "build/-leading-dash.html"
: > build/security.html

keys="$(run_loop)"
assert_contains "leading-dash filename derives cleanly" "$keys" "-leading-dash"
assert_contains "sibling page still present"            "$keys" "security"
assert_count    "case 2 total key count"                "$keys" 2

rm -rf build

echo ""
echo "assertions: $((pass + fail)), passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
