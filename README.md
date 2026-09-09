# Secure Inquiry Service

A small Node.js/Express middleware service that sanitizes incoming messages, simulates an external AI call, writes an encrypted audit log, and protects the mock AI call with a circuit breaker.

## Quick start

Make sure you have Node.js 20+ installed, then install dependencies:

```bash
npm install
```

Start the server with the environment variables from `.env`:

```bash
node --env-file=.env server.js
```

The server listens on `http://localhost:3000` by default. Change the port in `.env` or on the command line:

```bash
PORT=4000 node --env-file=.env server.js
```

If your Node.js version does not support `--env-file`, load `.env` manually:

```bash
set -a && source .env && set +a && npm start
```

## Environment variables

| Variable                  | Description                                                                  | Required |
|---------------------------|------------------------------------------------------------------------------|----------|
| `PORT`                    | Port the server listens on. Defaults to `3000`.                              | No       |
| `AUDIT_ENCRYPTION_KEY`    | Passphrase used to derive the AES-256-GCM key for encrypting the original message. If omitted, an ephemeral key is generated at startup and the console shows a warning. | No (but strongly recommended for production) |

## Endpoint

### `POST /secure-inquiry`

Accepts a JSON body:

```json
{
  "userId": "string",
  "message": "string"
}
```

Example:

```bash
curl -s -X POST http://localhost:3000/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "u1",
    "message": "Contact me at test@example.com or use card 4111-1111-1111-1111. SSN is 123-45-6789 and plain 987654321."
  }' | python3 -m json.tool
```

Example response:

```json
{
  "userId": "u1",
  "answer": "Generated Answer",
  "redactedMessage": "Contact me at <REDACTED: EMAIL> or use card <REDACTED: CREDIT_CARD>. SSN is <REDACTED: SSN> and plain <REDACTED: SSN>."
}
```

The service redacts:

- Email addresses → `<REDACTED: EMAIL>`
- Credit card numbers (13–19 digits with optional spaces or dashes) → `<REDACTED: CREDIT_CARD>`
- SSNs (`###-##-####` or exactly 9 digits) → `<REDACTED: SSN>`

The original message is encrypted with AES-256-GCM and stored alongside the plaintext redacted message in `mockDb.json`.

## Circuit breaker

The mock AI call has a built-in 2-second delay. If it fails 3 times in a row, the circuit breaker opens and the API immediately returns:

```json
{ "message": "Service Busy" }
```

### Testing the circuit breaker

Send 3 failing requests using the `x-simulate-ai-failure: true` header:

```bash
for i in 1 2 3; do
  curl -s -X POST http://localhost:3000/secure-inquiry \
    -H 'Content-Type: application/json' \
    -H 'x-simulate-ai-failure: true' \
    -d '{"userId":"u2","message":"fail"}'
  echo
done
```

Each returns:

```json
{ "error": "Mock AI service unavailable" }
```

Now send a 4th request. Because the circuit is open, you get the fallback immediately without waiting 2 seconds:

```bash
curl -s -X POST http://localhost:3000/secure-inquiry \
  -H 'Content-Type: application/json' \
  -H 'x-simulate-ai-failure: true' \
  -d '{"userId":"u2","message":"fail"}'
```

Response:

```json
{ "message": "Service Busy" }
```

The circuit stays open for 10 seconds before allowing one half-open probe request through.

## Docker deployment

### 1. Configure environment variables

Copy the example environment file and set a strong encryption key:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
AUDIT_ENCRYPTION_KEY=your-long-random-passphrase-here
PORT=3000
```

`AUDIT_ENCRYPTION_KEY` is used to derive the AES-256-GCM key for the audit log. Do not commit `.env`.

### 2. Build and run with Docker Compose

```bash
docker compose up --build -d
```

The container exposes the service on the host port defined by `PORT` (default `3000`). The audit database (`mockDb.json`) is persisted in a Docker named volume `secure-inquiry-data` mounted at `/data`.

Check the logs:

```bash
docker compose logs -f
```

### 3. Test the container

```bash
curl -s -X POST http://localhost:3000/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "u1",
    "message": "Contact me at test@example.com or use card 4111-1111-1111-1111. SSN is 123-45-6789 and plain 987654321."
  }' | python3 -m json.tool
```

### 4. Stop the service

```bash
docker compose down
```

To also remove the persisted audit volume:

```bash
docker compose down -v
```

### Manual Docker run (without Compose)

```bash
# Set the encryption key
export AUDIT_ENCRYPTION_KEY="your-long-random-passphrase"

# Build the image
docker build -t secure-inquiry .

# Run with a named volume for audit persistence
docker run -d \
  --name secure-inquiry \
  -p 3000:3000 \
  -e AUDIT_ENCRYPTION_KEY \
  -e DB_FILE=/data/mockDb.json \
  -v secure-inquiry-data:/data \
  secure-inquiry
```

### Production notes

- Never commit `.env`, `data/`, or `mockDb.json`.
- Prefer a secrets manager (Docker secrets, AWS Secrets Manager, etc.) over a plain `.env` file for `AUDIT_ENCRYPTION_KEY`.
- The container runs as the unprivileged `node` user.

## Notes

- `mockDb.json` is created automatically on the first successful request.
- Audit writes are serialized so concurrent requests do not corrupt the JSON file.
- The `x-simulate-ai-failure` header is intended for testing the circuit breaker only.
