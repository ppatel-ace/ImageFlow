import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Camera, Upload, FolderOpen, CheckCircle2, Loader2, Image as ImageIcon, Download } from "lucide-react";
import { format } from "date-fns";

const uploadFormSchema = z.object({
  partNumber: z.string().min(1, "Part # is required"),
  customerName: z.string().min(1, "Customer name is required"),
  workOrderNumber: z.string().min(1, "Work Order # is required"),
  imageFile: z.any().refine((file) => file instanceof File, "Image file is required"),
});

type UploadFormData = z.infer<typeof uploadFormSchema>;

interface ImageUploadFormProps {
  onSubmit: (data: UploadFormData & { imageName: string }) => Promise<void>;
}

export default function ImageUploadForm({ onSubmit }: ImageUploadFormProps) {
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const lastPartNumber = localStorage.getItem("lastPartNumber") || "";
  const lastCustomerName = localStorage.getItem("lastCustomerName") || "";
  const lastWorkOrderNumber = localStorage.getItem("lastWorkOrderNumber") || "";

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadFormSchema),
    defaultValues: {
      partNumber: lastPartNumber,
      customerName: lastCustomerName,
      workOrderNumber: lastWorkOrderNumber,
    },
  });

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      form.setValue("imageFile", file);
      
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFormSubmit = async (data: UploadFormData) => {
    setIsUploading(true);
    try {
      localStorage.setItem("lastPartNumber", data.partNumber);
      localStorage.setItem("lastCustomerName", data.customerName);
      localStorage.setItem("lastWorkOrderNumber", data.workOrderNumber);
      
      const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
      const imageName = `${data.partNumber}-${timestamp}`;
      await onSubmit({ ...data, imageName });
      setUploadSuccess(true);
      setTimeout(() => {
        setUploadSuccess(false);
        form.reset({
          partNumber: data.partNumber,
          customerName: data.customerName,
          workOrderNumber: data.workOrderNumber,
        });
        setImagePreview(null);
        setSelectedFile(null);
      }, 2000);
    } catch (error) {
      console.error("Upload failed:", error);
    } finally {
      setIsUploading(false);
    }
  };

  const customerName = form.watch("customerName");
  const workOrderNumber = form.watch("workOrderNumber");
  const partNumber = form.watch("partNumber");

  const handleSaveImageLocally = () => {
    if (!selectedFile || !partNumber) return;
    
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const imageName = `${partNumber}-${timestamp}`;
    const fileExtension = selectedFile.name.split('.').pop();
    const fileName = `${imageName}.${fileExtension}`;
    
    const link = document.createElement('a');
    link.href = imagePreview || '';
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log("Image saved locally:", fileName);
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-6 space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-semibold text-foreground">Upload Work Order Image</h1>
        <p className="text-muted-foreground text-lg">Capture and organize images to OneDrive</p>
      </div>

      <form onSubmit={form.handleSubmit(handleFormSubmit)} className="space-y-6">
        <Card className="p-6 space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="partNumber" className="text-lg font-medium">
                Part # <span className="text-destructive">*</span>
              </Label>
              <Input
                id="partNumber"
                data-testid="input-part-number"
                {...form.register("partNumber")}
                placeholder="Enter part number"
                className="min-h-14 text-base font-mono"
              />
              {form.formState.errors.partNumber && (
                <p className="text-sm text-destructive">{form.formState.errors.partNumber.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="customerName" className="text-lg font-medium">
                Customer Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customerName"
                data-testid="input-customer-name"
                {...form.register("customerName")}
                placeholder="Enter customer name"
                className="min-h-14 text-base"
              />
              {form.formState.errors.customerName && (
                <p className="text-sm text-destructive">{form.formState.errors.customerName.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="workOrderNumber" className="text-lg font-medium">
                Work Order # <span className="text-destructive">*</span>
              </Label>
              <Input
                id="workOrderNumber"
                data-testid="input-work-order"
                {...form.register("workOrderNumber")}
                placeholder="Enter work order number"
                className="min-h-14 text-base font-mono"
              />
              {form.formState.errors.workOrderNumber && (
                <p className="text-sm text-destructive">{form.formState.errors.workOrderNumber.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-lg font-medium">
                Image <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-3">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleImageSelect}
                  className="hidden"
                  id="camera-input"
                  data-testid="input-camera"
                />
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                  id="gallery-input"
                  data-testid="input-gallery"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="flex-1 min-h-14"
                  onClick={() => document.getElementById("camera-input")?.click()}
                  data-testid="button-camera"
                >
                  <Camera className="w-5 h-5 mr-2" />
                  Take Photo
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="flex-1 min-h-14"
                  onClick={() => document.getElementById("gallery-input")?.click()}
                  data-testid="button-gallery"
                >
                  <ImageIcon className="w-5 h-5 mr-2" />
                  Choose Image
                </Button>
              </div>
              {form.formState.errors.imageFile && (
                <p className="text-sm text-destructive">{form.formState.errors.imageFile.message as string}</p>
              )}
            </div>
          </div>
        </Card>

        {imagePreview && (
          <Card className="p-6">
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Image Preview</h3>
              <div className="relative aspect-video bg-muted rounded-lg overflow-hidden">
                <img src={imagePreview} alt="Preview" className="w-full h-full object-contain" />
              </div>
              {selectedFile && (
                <div className="space-y-1">
                  {partNumber && (
                    <p className="text-sm font-medium text-foreground" data-testid="text-generated-name">
                      Generated name: {partNumber}-{format(new Date(), "yyyyMMdd-HHmmss")}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground" data-testid="text-filename">
                    Original: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                  </p>
                </div>
              )}
            </div>
          </Card>
        )}

        {(customerName || workOrderNumber) && (
          <Card className="p-6 bg-accent/50">
            <div className="flex items-start gap-3">
              <FolderOpen className="w-5 h-5 text-primary mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-medium text-muted-foreground mb-1">OneDrive Folder Path</h3>
                <p className="font-mono text-base text-foreground" data-testid="text-folder-path">
                  {customerName || "[Customer Name]"} / {workOrderNumber || "[Work Order #]"}
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-14"
            onClick={handleSaveImageLocally}
            disabled={!selectedFile || !partNumber || isUploading}
            data-testid="button-save-local"
          >
            <Download className="w-5 h-5 mr-2" />
            Save Locally
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-14"
            onClick={() => {
              const lastPart = localStorage.getItem("lastPartNumber") || "";
              const lastCustomer = localStorage.getItem("lastCustomerName") || "";
              const lastWorkOrder = localStorage.getItem("lastWorkOrderNumber") || "";
              form.reset({
                partNumber: lastPart,
                customerName: lastCustomer,
                workOrderNumber: lastWorkOrder,
              });
              setImagePreview(null);
              setSelectedFile(null);
            }}
            disabled={isUploading}
            data-testid="button-clear"
          >
            Clear Form
          </Button>
          <Button
            type="submit"
            size="lg"
            className="flex-1 min-h-14"
            disabled={isUploading || !form.formState.isValid}
            data-testid="button-upload"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Uploading...
              </>
            ) : uploadSuccess ? (
              <>
                <CheckCircle2 className="w-5 h-5 mr-2" />
                Success!
              </>
            ) : (
              <>
                <Upload className="w-5 h-5 mr-2" />
                Upload to OneDrive
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
