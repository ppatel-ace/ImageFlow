# Ace Image Organizer

## Overview

Ace Image Organizer is an Android tablet-optimized work order management application. It enables users to capture and upload images to Google Drive, automatically organizing them into customer and work order specific folders. The application aims to streamline image management for technicians, ensuring organized documentation of work performed.

## User Preferences

Preferred communication style: Simple, everyday language.

## Self-Hosted Deployment (Portainer / Docker)

The target Docker host (managed by an external datacenter) has no reliable outbound access to the npm registry, so `docker build` cannot run `npm install` there — every attempt timed out after ~500s. To work around this, the Docker image is built from pre-installed dependencies and a pre-built `dist/` folder committed to the repo under `deploy_vendor/` (`deploy_vendor/node_modules`, `deploy_vendor/dist`). The `Dockerfile` only copies these in — it never calls `npm install`.

**Whenever dependencies change or the app is rebuilt, `deploy_vendor/` must be regenerated from Replit before redeploying:**
```
rm -rf deploy_vendor
mkdir -p deploy_vendor
cp -r node_modules deploy_vendor/node_modules
cp package.json package-lock.json deploy_vendor/
cd deploy_vendor && npm prune --omit=dev && cd ..
npm run build
rm -rf deploy_vendor/dist
cp -r dist deploy_vendor/dist
```
Then commit and push `deploy_vendor/` along with the rest of the changes.

- `docker-compose.yml` publishes the app on host port **8095** → container port 5000, on an isolated subnet (172.28.55.0/24) chosen to avoid collisions with existing stacks.
- No environment variables are strictly required to boot (in-memory storage, no DB).
- For work-order / part-number Excel sync in production, set `SFTP_HOST`, `SFTP_USER`, `SFTP_PASSWORD` (and optionally `SFTP_PORT`, `SFTP_REMOTE_DIRS`). Image uploads use SharePoint (`AZURE_*` / `SHAREPOINT_*`).
- Google Drive Excel sync remains a Replit-only fallback (`server/gdrive.ts`).

## System Architecture

### Frontend Architecture

**Framework & Tooling**
- React 18 with TypeScript
- Vite for building and development
- Wouter for client-side routing
- TanStack Query for server state management

**UI Design System**
- Material Design 3 principles adapted for tablet touch interactions
- Shadcn/ui component library with Radix UI primitives
- Tailwind CSS for styling with custom design tokens and "New York" style variant
- Custom HSL-based color system supporting light and dark modes
- Touch-friendly minimum target sizes (48px for interactive elements)

**Form Management**
- React Hook Form for performant form state management
- Zod for schema validation
- Local storage persistence for Dept and Work Order Number
- Work Order autocomplete with real-time filtering and support for custom entries
- Automatic selection of Part Number, Rev, and Customer Name when a work order has a single part number option
- Read-only Rev and Customer Name fields auto-filled from Excel data

**State Management Pattern**
- React Context for theme management
- TanStack Query for server state
- Local component state for UI interactions

### Backend Architecture

**Server Framework**
- Express.js with TypeScript for RESTful API endpoints
- Custom middleware for request/response logging
- `node-cron` for scheduled tasks (daily Excel updates at 7:20 AM EST/EDT)

**Storage Layer**
- Abstracted storage interface with current in-memory implementation (MemStorage)
- Drizzle ORM configured with PostgreSQL dialect for future database integration

**File Structure**
- `/server` for backend logic
- `/client` for React frontend
- `/shared` for shared types and schemas
- Path aliases for clean imports

### Design Decisions

**Responsive Design (Mobile & Tablet)**
- Adaptive layouts and typography based on screen size
- Touch-friendly target sizes (48px on mobile, 56px on tablet)

**Theme System**
- CSS custom properties for dynamic theming
- HSL color format for programmatic color manipulation
- Separate light/dark mode palettes with optimized contrast ratios

**Image Upload Flow**
- **Hybrid Camera System**:
  - Android: Custom camera screen with zoom and brightness controls, large capture button.
  - iOS: Native camera app integration via file input.
- **Multiple photo capture**: Users can capture multiple photos before uploading.
  - Images displayed in a gallery with thumbnails.
  - Option to remove individual images or clear all.
- Automatic file naming: `{partNumber}Rev{rev}-{timestamp}.{extension}`
- Folder structure: `ACE/CustomerName/Dept/WorkOrderNumber`
- Path and filename sanitization to replace invalid characters
- Local save option for offline use
- Error reporting for Google Drive auth failures is enhanced to provide clear "reconnect Google Drive" messages.
- Google Drive uploads now use a resumable protocol to handle large files, bypassing proxy size limits.

**Excel Data Updates via SFTP (primary) / Google Drive (fallback)**
- Automatic daily Excel file updates at 7:20 AM EST/EDT from the Sage SFTP share (`SFTP_HOST`, files matching `Open Order All Qty Only_<date>.xlsx` under `/mnt/sage` or `/mnt/import`).
- Falls back to Google Drive KSAlert sync when SFTP is not configured (Replit connectors only).
- Client-side checks on page load and scheduled checks when the app is open.
- Manual "Check for Updates" button in UI.
- Downloads and processes the latest Excel file to update work order / part number data.

## External Dependencies

### Third-Party Services

**Cloud Storage API Integration**
- `googleapis` for Google Drive API communication for file uploads and folder management.
- Uses Replit's Google Drive connector for OAuth authentication.

### Database

**PostgreSQL (via Neon)**
- `@neondatabase/serverless` for serverless PostgreSQL connections.
- Drizzle ORM for database interactions.

### UI Component Libraries

- Radix UI Primitives for accessible, unstyled UI components.
- `cmdk` for command palette functionality.
- `date-fns` for date manipulation.
- `lucide-react` for icons.
- `vaul` for drawer components.
- `input-otp` for OTP inputs.
- `recharts` for data visualization.
- `react-day-picker` for calendar/date picking.
- `embla-carousel-react` for carousels.

### Styling & Utilities

- `tailwindcss` for utility-first styling.
- `class-variance-authority` for type-safe variant styling.
- `clsx` and `tailwind-merge` for conditional class names.

### Session Management

- `connect-pg-simple` for PostgreSQL session storage with Express.