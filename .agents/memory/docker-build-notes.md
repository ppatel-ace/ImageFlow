---
name: Docker build notes for this app
description: Why the Docker build kept failing with "vite: not found" and npm ci crashes, and the fix that worked
---

Two separate issues showed up when containerizing this Vite + Express app for Portainer/self-hosted Docker:

1. `npm ci` intermittently crashed with "npm error Exit handler never called!" (a known npm 10.x defect), sometimes appearing to exit 0 while leaving `node_modules` incomplete. This happened on both Alpine and Debian-slim base images, so it's not base-image specific — it's an npm bug. Fix: use `npm install` instead of `npm ci`, with retry config (`fetch-retries`, `fetch-retry-mintimeout/maxtimeout`).

2. Even after switching to `npm install`, the build stage still reported `vite: not found` when running `npm run build`. `vite` is a devDependency. The fix that resolved it: explicitly set `ENV NODE_ENV=development` in the build stage before running `npm install --include=dev` — don't rely on npm's default behavior to install devDependencies, since something in the build environment (base image env inheritance, or leftover config) was causing them to be skipped. Added `ls node_modules/.bin/vite` as a build-time sanity check before invoking the build.

**Why:** Silent/partial dependency installs are hard to diagnose from Portainer's build logs alone; being explicit about NODE_ENV and using `--include=dev` avoids ambiguity.

**How to apply:** Any Dockerfile for this project's build stage should keep `ENV NODE_ENV=development` + `npm install --include=dev`, and the runtime stage should keep `ENV NODE_ENV=production` + `npm install --omit=dev`.
