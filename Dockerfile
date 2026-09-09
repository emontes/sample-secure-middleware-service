FROM node:22-slim

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create a writable directory for the audit database
RUN mkdir -p /data && chown -R node:node /data /app

# Run as non-root user
USER node

EXPOSE 3000

# Default location for the audit database inside the container
ENV DB_FILE=/data/mockDb.json
ENV PORT=3000

CMD ["node", "server.js"]
