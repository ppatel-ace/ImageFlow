# AGENTS.md

## Cursor Cloud specific instructions

Ace Image Organizer (ImageFlow) is a Vite (React) + Express + Drizzle app on a single port. Standard commands are in `package.json` (`npm run dev`, `npm run build`, `npm run check`, `npm run db:push`).

Environment specifics for this VM:

- The committed `package-lock.json` resolves packages from an unreachable Replit registry (`package-firewall.replit.local`). The update script rewrites those URLs to `https://registry.npmjs.org` before `npm install`; if you install manually, run:
  `sed -i 's#http://package-firewall.replit.local/npm#https://registry.npmjs.org#g' package-lock.json` first.
- The app boots with NO env required (in-memory storage); PostgreSQL is only used for upload history. Unlike the sibling apps, this one DOES read a local `.env` via `server/env.ts`.
- A `.env` is present setting `PORT=5003` (default `5000` collides with sibling apps) and a local `imageflow` database (`sudo pg_ctlcluster 16 main start`; role `ace` / `ace`).
- SharePoint/Google/SFTP integrations are optional and disabled without their credentials.
