#!/usr/bin/env bash
# Runs DynamoDB Local as a standalone Java process (no Docker). Listens on :8000.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/.dynamodb-local"
mkdir -p "$DIR" && cd "$DIR"
if [ ! -f DynamoDBLocal.jar ]; then
	echo "Downloading DynamoDB Local..."
	curl -sL https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz | tar xz
fi
exec java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000
