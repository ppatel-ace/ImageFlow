# This Dockerfile does NOT run `npm install` at all — it uses dependencies and a
# build that were already produced inside Replit (deploy_vendor/), because the
# target Docker host has no reliable outbound access to the npm registry.
# If you add/update dependencies, regenerate deploy_vendor/ from Replit before
# redeploying (see replit.md for the exact steps).
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY deploy_vendor/node_modules ./node_modules
COPY deploy_vendor/dist ./dist
COPY attached_assets ./attached_assets
EXPOSE 5000
CMD ["node", "dist/index.js"]
