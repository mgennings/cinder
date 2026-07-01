# Deployment

This guide provisions your own copy of Cinder on AWS: the API, the database, and the static site behind a CDN. The entire stack is one CloudFormation/SAM template, so a deploy is a single command.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| An AWS account | The stack fits comfortably in the free tier at personal volume |
| [AWS CLI](https://aws.amazon.com/cli/) v2 | Configured with credentials (`aws sts get-caller-identity` should succeed) |
| [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | `brew install aws-sam-cli` on macOS |
| Node.js 22+ and pnpm 11+ | For building the front end |

> **Warning:** Deploying creates real AWS resources. They are inexpensive (effectively \$0 at low volume) but they are real. Tear the stack down with `sam delete` when you are done experimenting.

## What gets created

| Resource | Purpose |
| --- | --- |
| DynamoDB table `blip-notes` | Stores ciphertext, with TTL enabled on `expiresAt` |
| Two Lambda functions | `createNote` and `readNote`, Node 22 on ARM64 |
| API Gateway HTTP API | Fronts the two Lambdas with CORS |
| S3 bucket | Holds the static site (private, served only via CloudFront) |
| CloudFront distribution | HTTPS delivery with SPA fallback |
| IAM roles | Least-privilege: create can only `PutItem`, read can only `DeleteItem` |

## Deploy the backend

From the repo root:

```bash
sam build
sam deploy --guided
```

The guided deploy asks for a stack name (use `blip`), a region (`us-east-1` is assumed by the site config), and saves your answers to `samconfig.toml` so future deploys are just `sam deploy`.

When it finishes, note the `ApiUrl` output — you need it for the front end.

> **Note:** If you are not attaching a custom domain, you can pass an empty `CertificateArn` and remove the `Aliases`/`ViewerCertificate` block from the distribution, or deploy the base stack first and add the domain later.

## Deploy the front end

1. Point the build at your API by creating `.env.production`:

   ```
   VITE_API_BASE=https://<your-api-id>.execute-api.us-east-1.amazonaws.com
   ```

2. Build and sync to S3, then invalidate the CDN cache. The `scripts/deploy-frontend.sh` script does all three — edit the `BUCKET` and `DIST_ID` variables at the top to match your stack's outputs, then:

   ```bash
   ./scripts/deploy-frontend.sh
   ```

Your site is now live at the CloudFront URL from the stack outputs.

## Attaching a custom domain

To serve Cinder from your own domain (for example `notes.example.com`):

1. **Request an ACM certificate in `us-east-1`.** CloudFront only accepts certificates from that region, regardless of where the rest of your stack lives.

   ```bash
   aws acm request-certificate --domain-name notes.example.com \
     --validation-method DNS --region us-east-1
   ```

2. **Validate it** by adding the CNAME record ACM gives you to your DNS. If your DNS is in Route 53, this is one `change-resource-record-sets` call. Validation usually completes within minutes.

3. **Deploy with the domain parameters:**

   ```bash
   sam deploy --parameter-overrides \
     SiteDomain=notes.example.com \
     CertificateArn=arn:aws:acm:us-east-1:<acct>:certificate/<id>
   ```

4. **Point DNS at CloudFront** with an A-record alias to the distribution's domain name (Route 53 uses the fixed CloudFront hosted-zone ID `Z2FDTNDATAQYW2`).

> **Warning — for a future Android/TWA build:** if you add a `/.well-known/assetlinks.json` file, its CloudFront behavior must be ordered *before* the SPA fallback. The `CustomErrorResponses` rule that maps 403/404 to `/200.html` will otherwise return the app shell for that path and silently break the Trusted Web Activity's URL-bar removal. There is a comment marking this in `template.yaml`.

## Verifying a deploy

A quick end-to-end smoke test against the live API:

```bash
API=https://<your-api-id>.execute-api.us-east-1.amazonaws.com
ID=$(curl -s -XPOST "$API/notes" -d '{"ciphertext":"CT","iv":"IV","ttlSeconds":3600}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')
curl -s -XPOST "$API/notes/$ID/burn"                                   # → the note
curl -s -o /dev/null -w '%{http_code}\n' -XPOST "$API/notes/$ID/burn"  # → 410
```

The first burn returns the note; the second returns `410`. That proves the atomic burn is working on real infrastructure.

## Tearing it down

```bash
sam delete --stack-name blip
```

This removes the Lambdas, API, table, and CloudFront distribution. Empty and delete the S3 bucket separately if `sam delete` leaves it behind (S3 will not delete a non-empty bucket).

## Related documents

- [Architecture](architecture.md) — what each resource does
- [API reference](api.md) — the endpoints you just deployed
- [Local development](local-development.md) — iterating without deploying
