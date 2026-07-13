import ImageUploadForm from "@/components/ImageUploadForm";
import ThemeToggle from "@/components/ThemeToggle";
import { getHubAppsUrl } from "@/lib/hub";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 py-3 sm:py-4 flex items-center justify-between">
          <a
            href={getHubAppsUrl()}
            className="flex items-center gap-2 sm:gap-3 no-underline rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Back to ACE ERP"
          >
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-base sm:text-lg">ACE</span>
            </div>
            <div>
              <h1 className="text-base sm:text-lg md:text-xl font-semibold text-foreground">Ace Image Organizer</h1>
              <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">Cloud Integration</p>
            </div>
          </a>
          <ThemeToggle />
        </div>
      </header>

      <main className="py-4 sm:py-6 md:py-8">
        <ImageUploadForm />
      </main>
    </div>
  );
}
