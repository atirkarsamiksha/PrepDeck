# Multi-stage Production Dockerfile for PrepDeck
FROM node:20-alpine AS dependencies

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --only=production

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# Create application user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy production node_modules and code
COPY --from=dependencies /app/server/node_modules ./server/node_modules
COPY server ./server
COPY client ./client

# Create uploads directory and assign ownership
RUN mkdir -p server/uploads && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 5000

WORKDIR /app/server
CMD ["node", "server.js"]
