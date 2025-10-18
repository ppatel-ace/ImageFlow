# Ace Image Organizer

## Overview

This is a work order management application designed for Android tablets that enables users to capture and upload images to Google Drive with automatic folder organization. The app allows users to associate images with specific customers and work orders, creating an organized file structure. Built with a modern React frontend and Express backend, the application emphasizes touch-friendly interactions optimized for tablet use.

**Multiple Photo Capture**: Users can now capture multiple photos before uploading. Photos are displayed in a gallery with thumbnails, and users can remove individual images or clear all at once before proceeding with upload/save operations.

## Recent Performance Optimizations

**Code Efficiency Improvements (October 18, 2025)**
- Consolidated form state watchers: Reduced multiple `form.watch()` calls to a single destructured call, improving performance
- Extracted filename generation logic: Created `generateFilename()` helper function to eliminate repeated sanitization in loops
- Streamlined local save logic: Simplified folder creation using promise chaining
- Optimized upload error handling: Removed unnecessary error tracking array, simplified to count-based validation
- All optimizations maintain existing functionality while reducing code duplication and improving readability

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework & Tooling**
- React 18 with TypeScript for type-safe component development
- Vite as the build tool and development server for fast hot module replacement
- Wouter for client-side routing (lightweight alternative to React Router)
- TanStack Query for server state management and data fetching

**UI Design System**
- Material Design 3 principles adapted for tablet-optimized touch interactions
- Shadcn/ui component library with Radix UI primitives for accessible, customizable components
- Tailwind CSS for utility-first styling with custom design tokens
- "New York" style variant from Shadcn configured for consistent visual language
- Custom color system supporting light and dark modes with HSL-based theming
- Touch-friendly minimum target sizes (48px height for interactive elements)

**Form Management**
- React Hook Form for performant form state management
- Zod schema validation integrated via @hookform/resolvers
- Local storage persistence for user-entered fields: Dept and Work Order Number
- Real-time localStorage sync: Dept field saves automatically on change
- Work Order autocomplete: Supports both manual typing AND dropdown selection from Excel-loaded work orders
  - Popover + Command component for instant dropdown on focus/typing
  - Real-time filtering as user types
  - Accepts custom work orders not in the Excel file
  - Automatically clears Part #, Rev, and Customer Name when work order changes
- Part Number auto-selection: When a work order has only ONE part number option, it is automatically selected
  - Auto-fills Part #, Rev, and Customer Name fields when single option exists
  - Improves user experience by reducing clicks for single-option work orders
  - When multiple part numbers exist, user must manually select from dropdown
- Rev and Customer Name fields: Read-only, auto-filled from Excel data based on selected Part #

**State Management Pattern**
- React Context for theme management (light/dark mode)
- TanStack Query for server state with disabled refetching (staleTime: Infinity)
- Local component state for UI interactions and form handling

### Backend Architecture

**Server Framework**
- Express.js with TypeScript for RESTful API endpoints
- Custom middleware for request/response logging with timing metrics
- Development-only Vite integration for HMR during development
- Production builds use esbuild for server bundling
- Environment-based configuration: NODE_ENV determines dev vs production behavior
- Dynamic imports prevent Vite dependencies from being bundled in production
- Static file serving in production without Vite overhead

**Storage Layer**
- Abstracted storage interface (IStorage) allowing multiple implementations
- Current implementation: In-memory storage (MemStorage) using JavaScript Maps
- Drizzle ORM configured with PostgreSQL dialect for future database integration
- Schema defines user model with UUID primary keys

**File Structure**
- `/server` - Backend API routes and business logic
- `/client` - React frontend application
- `/shared` - Shared types and schemas accessible to both frontend and backend
- Path aliases configured for clean imports (@/, @shared/, @assets/)

### Design Decisions

**Responsive Design (Mobile & Tablet)**
- Responsive breakpoints: Mobile (<640px), Tablet/Desktop (≥640px)
- Mobile: Buttons stack vertically, compact spacing (px-3, min-h-12), smaller text (text-base)
- Tablet: Buttons display horizontally, generous spacing (px-4-6, min-h-14), larger text (text-lg)
- Adaptive typography: Scales from base sizes on mobile to larger sizes on tablet
- Touch-friendly targets: 48px minimum height on mobile, 56px on tablet
- Button groups use flex-col on mobile, flex-row on tablet for optimal layout
- Folder paths use break-all for text wrapping on small screens
- Header elements scale appropriately (logo, title, spacing) across devices

**Theme System**
- CSS custom properties for dynamic theming
- HSL color format for programmatic color manipulation
- Separate light/dark mode palettes with carefully chosen contrast ratios
- Primary blue (220° hue) for professional, trustworthy appearance
- Success green (142° hue) and error red (0° hue) for status feedback

**Image Upload Flow**
- Camera input prioritized for direct capture on tablet devices
- **Multiple photo capture**: Users can take/select multiple photos before uploading
  - Images stored in `capturedImages` array with `{ id, file, preview }` structure
  - Each image has unique ID generated with `Date.now() + Math.random()`
  - Gallery displays thumbnails in 2-column grid (mobile) or 3-column grid (tablet/desktop)
  - Individual image removal via hover overlay with remove button
  - "Clear All" button removes all captured images at once
  - Upload/Save buttons disabled until at least one image is captured
- Image gallery UI with thumbnail previews for quality confirmation
- Automatic file naming format: {partNumber}Rev{rev}-{timestamp}.{extension} (e.g., ABC123RevA-20250108-151500-123.jpg)
  - Timestamp includes milliseconds to prevent file name conflicts
- Folder structure: ACE/CustomerName/Dept/WorkOrderNumber
- Path and filename sanitization: Invalid characters (< > : " / \ | ? *) replaced with "_"
  - Applied to Customer Name in folder paths (server/sharepoint.ts, client)
  - Applied to Part # and Rev in filenames (client/src/components/ImageUploadForm.tsx)
  - Sanitization occurs in Google Drive uploads, SharePoint uploads, and local file saves
  - Original values preserved in UI and form data for display
- Local save option for offline scenarios or backup purposes
- Both local save and Google Drive upload process all captured images sequentially

**Excel Data Updates via Google Drive**
- Automatic Excel file updates from Google Drive KSAlert folder
- Folder ID: 1ixVvva0yj1FyytYBjj0DRuPNT4i76H76 (owned by aceelectronics385@gmail.com)
- File naming pattern: YYYYMMDD.xlsx (e.g., 20250117.xlsx)
- **Automatic Updates**:
  - Auto-check on page load (once per day, tracked via lastPageLoadCheck)
  - Scheduled check at 7:03 AM EST/EDT daily (tracked via lastScheduledCheck)
  - Both checks can run on the same day without interfering with each other
  - Uses Intl.DateTimeFormat with America/New_York timezone for accurate EST/EDT handling
  - Scheduled check fires at exactly 7:03 AM Eastern time regardless of user's local timezone
  - Date comparisons for scheduled checks use Eastern timezone to prevent skipped runs
  - Silent auto-checks (no toast notifications if no updates found)
  - lastAutoCheckDate tracks most recent auto-check for UI display
  - lastManualCheck tracks timestamp of manual check button clicks
- "Check for Updates" button in UI for manual checks (shows toast notifications)
- System searches for latest file in KSAlert folder matching YYYYMMDD.xlsx pattern
- Downloads and saves Excel file with timestamp to attached_assets folder (OpenOrdersAllQtyOnly_{timestamp}.xlsx)
- Automatically reloads work order data from new file
- Uses Replit's Google Drive connector for authentication and API access
- Files are sorted by date in filename (newest first) to find latest work order data

**Development Experience**
- TypeScript strict mode for type safety across the codebase
- ESM modules throughout (type: "module" in package.json)
- Incremental compilation with tsBuildInfo caching
- Custom Vite plugins for Replit integration (cartographer, dev-banner, error modal)

## External Dependencies

### Third-Party Services

**Cloud Storage API Integration**
- `@microsoft/microsoft-graph-client` (v3.0.7) for SharePoint API communication (if needed)
- `googleapis` (v148.0.0) for Google Drive API communication
- Handles file uploads and folder management in Google Drive
- Google Drive: Uses Replit's Google Drive connector for OAuth authentication (fully implemented) - aceelectronics385@gmail.com
- Files uploaded with Customer Name/Work Order Number folder structure

### Database

**PostgreSQL (via Neon)**
- `@neondatabase/serverless` (v0.10.4) for serverless PostgreSQL connections
- Drizzle ORM (v0.39.1) with `drizzle-zod` for schema-to-validation integration
- Migration system configured with `drizzle-kit` (output: ./migrations)
- Connection string expected via `DATABASE_URL` environment variable

### UI Component Libraries

**Radix UI Primitives** (v1.x-v2.x)
- Unstyled, accessible component primitives (accordion, dialog, dropdown, select, etc.)
- 20+ components installed for comprehensive UI coverage
- Composable architecture allows custom styling while maintaining accessibility

**Additional UI Dependencies**
- `cmdk` for command palette/search functionality
- `date-fns` for date formatting and manipulation
- `lucide-react` for icon system (imported in multiple components)
- `vaul` for drawer/bottom sheet components
- `input-otp` for one-time password inputs
- `recharts` for data visualization (chart component configured)
- `react-day-picker` for calendar/date picker functionality
- `embla-carousel-react` for carousel/image gallery components

### Styling & Utilities

- `tailwindcss` with `autoprefixer` for cross-browser CSS compatibility
- `class-variance-authority` for type-safe variant styling
- `clsx` and `tailwind-merge` for conditional className composition

### Session Management

- `connect-pg-simple` (v10.0.0) for PostgreSQL session storage
- Configured for Express session management (implementation pending)

### Development Tools

- `@replit/vite-plugin-*` suite for Replit development environment integration
- `tsx` for TypeScript execution in development
- `esbuild` for production server bundling
- `@jridgewell/trace-mapping` for source map support