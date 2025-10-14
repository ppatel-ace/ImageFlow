# OneDrive Image Upload & Organization App

## Overview

This is a work order management application designed for Android tablets that enables users to capture and upload images to OneDrive with automatic folder organization. The app allows users to associate images with specific customers and work orders, creating an organized file structure in OneDrive. Built with a modern React frontend and Express backend, the application emphasizes touch-friendly interactions optimized for tablet use.

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
- Local storage persistence for form data (part numbers, customer names, work orders, dept, and rev values)
- Real-time localStorage sync: Dept and Rev fields save automatically on change (not just on submit)
- Work Order autocomplete: Supports both manual typing AND dropdown selection from Excel-loaded work orders
  - Popover + Command component for instant dropdown on focus/typing
  - Real-time filtering as user types
  - Accepts custom work orders not in the Excel file
  - Automatically clears Part #, Rev, and Customer Name when work order changes
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
- Image preview before upload for quality confirmation
- Automatic file naming format: {partNumber}Rev{rev}-{timestamp}.{extension} (e.g., ABC123RevA-20250108-151500.jpg)
- Folder structure: ACE/CustomerName/Dept/WorkOrderNumber
- Path and filename sanitization: Invalid characters (< > : " / \ | ? *) replaced with "_"
  - Applied to Customer Name in folder paths (server/onedrive.ts, server/sharepoint.ts, client)
  - Applied to Part # and Rev in filenames (client/src/components/ImageUploadForm.tsx)
  - Sanitization occurs in OneDrive uploads, SharePoint uploads, and local file saves
  - Original values preserved in UI and form data for display
- Local save option for offline scenarios or backup purposes

**Excel Data Updates via Gmail**
- Automatic Excel file updates from emails sent to aceelectronics385@gmail.com
- Scanner sends updated work order files from scanner@aceelectronics.com
- "Check for Updates" button in UI to manually trigger email check
- System searches for latest email with Excel attachment (.xlsx or .xls)
- Downloads and saves Excel file with timestamp to attached_assets folder
- Automatically reloads work order data from new file
- Gmail OAuth integration via Replit connector for secure authentication
- Base64url to base64 conversion for proper Excel file decoding
- Search query ensures only scanner emails with attachments are processed

**Development Experience**
- TypeScript strict mode for type safety across the codebase
- ESM modules throughout (type: "module" in package.json)
- Incremental compilation with tsBuildInfo caching
- Custom Vite plugins for Replit integration (cartographer, dev-banner, error modal)

## External Dependencies

### Third-Party Services

**Cloud Storage API Integration**
- `@microsoft/microsoft-graph-client` (v3.0.7) for OneDrive API communication
- `googleapis` (v148.0.0) for Google Drive and Gmail API communication
- Handles file uploads and folder management in OneDrive and Google Drive
- OneDrive: Uses Replit's OneDrive connector for OAuth authentication (fully implemented)
- Google Drive: Uses Replit's Google Drive connector for OAuth authentication (fully implemented) - aceelectronics385@gmail.com
- Gmail: Uses Replit's Gmail connector for OAuth authentication (fully implemented) - aceelectronics385@gmail.com
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