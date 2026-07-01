// Production Lambda entrypoints. Wires a real DynamoDB client (region + creds
// come from the Lambda execution environment) into the injectable handlers.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeHandlers } from './handlers.mjs';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const { createNote, readNote } = makeHandlers(doc);
