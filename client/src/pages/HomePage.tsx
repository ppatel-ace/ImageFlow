import ImageUploadForm from "@/components/ImageUploadForm";
import ThemeToggle from "@/components/ThemeToggle";
import { useToast } from "@/hooks/use-toast";

export default function HomePage() {
  const { toast } = useToast();

  const handleUpload = async (data: any) => {
    const formData = new FormData();
    formData.append("imageFile", data.imageFile);
    formData.append("customerName", data.customerName);
    formData.append("workOrderNumber", data.workOrderNumber);
    formData.append("imageName", data.imageName);

    try {
      const response = await fetch("/api/upload/onedrive", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        if (result.requiresAuth) {
          toast({
            title: "OneDrive Not Connected",
            description: "Please connect your OneDrive account in the Integrations panel to upload files.",
            variant: "destructive",
          });
          throw new Error(result.message);
        }
        throw new Error(result.error || "Upload failed");
      }

      toast({
        title: "Upload Successful",
        description: `Image saved to OneDrive: ${result.path}`,
      });
    } catch (error: any) {
      console.error("Upload error:", error);
      if (!error.message.includes('not connected')) {
        toast({
          title: "Upload Failed",
          description: error.message || "An error occurred while uploading to OneDrive.",
          variant: "destructive",
        });
      }
      throw error;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-lg">ACE</span>
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">Ace Image Organizer</h1>
              <p className="text-xs text-muted-foreground">Cloud Integration</p>
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
