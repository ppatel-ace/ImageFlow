FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY package.json package-lock.json* ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --include=dev --no-audit --no-fund
COPY . .
RUN ls node_modules/.bin/vite && npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY package.json package-lock.json* ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/attached_assets ./attached_assets
EXPOSE 5000
CMD ["node", "dist/index.js"]
