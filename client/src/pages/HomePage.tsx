import ImageUploadForm from "@/components/ImageUploadForm";
import ThemeToggle from "@/components/ThemeToggle";

export default function HomePage() {
  const handleUpload = async (data: any) => {
    console.log("Uploading to OneDrive:", data);
    await new Promise(resolve => setTimeout(resolve, 1500));
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-lg">WO</span>
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">Work Order Manager</h1>
              <p className="text-xs text-muted-foreground">OneDrive Integration</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="py-8">
        <ImageUploadForm onSubmit={handleUpload} />
      </main>
    </div>
  );
}
