# Design Guidelines: OneDrive Image Upload & Organization App

## Design Approach
**Selected System:** Material Design 3 with tablet-optimized adaptations
**Justification:** Material Design provides excellent touch-friendly components, clear visual hierarchy, and robust form patterns ideal for data-entry applications on Android tablets. The system's emphasis on adaptive layouts ensures optimal use of tablet screen real estate.

---

## Core Design Elements

### A. Color Palette

**Light Mode:**
- Primary: 220 90% 56% (Professional blue - trust and reliability)
- Primary Container: 220 90% 95% (Light blue backgrounds)
- Surface: 0 0% 98% (Clean white background)
- Surface Variant: 220 15% 96% (Subtle card backgrounds)
- On Surface: 220 15% 20% (Dark text)
- Success: 142 76% 36% (Upload confirmation)
- Error: 0 84% 60% (Validation errors)

**Dark Mode:**
- Primary: 220 90% 65%
- Primary Container: 220 90% 25%
- Surface: 220 15% 12%
- Surface Variant: 220 15% 18%
- On Surface: 220 5% 95%
- Success: 142 76% 50%
- Error: 0 84% 70%

### B. Typography

**Font Family:** Inter (via Google Fonts)
- Primary: Inter (400, 500, 600 weights)
- Monospace: JetBrains Mono (for Work Order numbers)

**Scale:**
- Heading Large: 32px / 600 weight (Page title)
- Heading Medium: 24px / 600 weight (Section headers)
- Body Large: 18px / 500 weight (Form labels - enhanced for tablet readability)
- Body Medium: 16px / 400 weight (Input text, helper text)
- Label Large: 14px / 600 weight (Button text)

### C. Layout System

**Spacing Primitives:** Use Tailwind units of 3, 4, 6, 8, 12, and 16
- Form field spacing: gap-6 between fields
- Section padding: p-8 or p-12 for main containers
- Touch target minimum: 48px height (h-12 for buttons, min-h-12 for inputs)
- Card padding: p-6 to p-8

**Tablet Optimization:**
- Container max-width: max-w-3xl (optimal for landscape tablets)
- Form width: w-full max-w-2xl (centered for comfortable reach)
- Grid layout for landscape: Split-screen capability (form on left, upload preview on right)

### D. Component Library

**Navigation:**
- Top app bar with app title and status indicators
- Breadcrumb showing: Customer Name > Work Order # (when applicable)
- Background upload queue indicator (shows pending uploads)

**Form Components:**
- **Text Inputs:** Large touch-friendly fields with floating labels
  - Height: min-h-14 (56px touch target)
  - Border: 2px solid, rounded-lg corners
  - Focus state: Ring-2 with primary color
  - Filled state: Background color changes to surface variant
  
- **Date Picker:** Native-style calendar interface
  - Large date cells (minimum 48x48px)
  - Month/year quick navigation
  - Default to today's date
  
- **Image Capture/Upload:**
  - Large dropzone area (min 200px height)
  - Camera button (launches tablet camera)
  - File browser button (selects from gallery)
  - Image preview with filename display
  - Replace image option after capture
  
- **Action Buttons:**
  - Primary CTA: "Upload to OneDrive" (filled, h-14, full width on mobile, fixed width on tablet)
  - Secondary: "Clear Form" (outlined, h-14)
  - Icon buttons for camera/gallery: Square 56x56px touch targets

**Data Display:**
- Folder path preview card showing: Customer Name/Work Order #/
- Upload progress indicator (linear progress bar with percentage)
- Success confirmation card with checkmark animation
- Error state card with retry option

**Overlays:**
- Upload progress modal (prevents form interaction during upload)
- Success confirmation modal with "Upload Another" and "View on OneDrive" actions
- Error dialog with detailed error message and retry button

### E. Interaction Patterns

**Form Validation:**
- Real-time validation on blur
- Required field indicators (asterisk + color)
- Inline error messages below fields
- Disabled submit button until all required fields valid

**Upload Flow:**
1. Fill form fields (auto-save to local storage)
2. Capture/select image
3. Preview shows thumbnail + metadata summary
4. Submit triggers folder creation + upload
5. Progress indicator shows upload percentage
6. Success state with confirmation + option to upload another

**Touch Optimizations:**
- All interactive elements minimum 48px height
- Increased padding around clickable areas
- Haptic feedback on button press (where supported)
- Swipe-to-clear for text inputs (optional gesture)
- Pinch-to-zoom on image preview

**Keyboard Behavior:**
- Auto-advance to next field on Enter key
- Numeric keyboard for Work Order # field
- Date picker opens on date field focus
- Form submits on final field + Enter

---

## Tablet-Specific Enhancements

**Landscape Layout:**
- Two-column layout: Form (60% width) | Image Preview + Folder Path (40% width)
- Sticky submit button in footer bar
- Side-by-side comparison of metadata and preview

**Portrait Layout:**
- Single column, full-width form
- Image preview above submit button
- Collapsed folder path (expandable)

**Responsive Breakpoints:**
- Mobile (< 640px): Single column, stacked
- Tablet Portrait (640px - 1024px): Optimized single column with larger targets
- Tablet Landscape (> 1024px): Two-column split layout

---

## Accessibility & Polish

- Maintain consistent dark mode across all inputs and text fields
- ARIA labels on all form controls
- Focus visible indicators (2px offset ring)
- Error announcements for screen readers
- High contrast mode support (4.5:1 minimum ratio)
- Loading states with descriptive text ("Uploading to OneDrive...")

---

## Key Screens

1. **Main Form Screen:** Clean, centered form with all input fields, clear visual hierarchy
2. **Upload Progress:** Modal overlay with animated progress bar and percentage
3. **Success Confirmation:** Full-screen success state with checkmark, folder path confirmation, and next action buttons
4. **Error State:** Clear error message with specific issue and retry/cancel options

This design prioritizes efficiency, touch-friendliness, and clear visual feedback for a seamless tablet-based workflow.