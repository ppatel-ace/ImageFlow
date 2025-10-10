import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Camera, Upload, FolderOpen, CheckCircle2, Loader2, Image as ImageIcon, Download, Check } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const uploadFormSchema = z.object({
  dept: z.string().min(1, "Dept is required"),
  partNumber: z.string().min(1, "Part # is required"),
  rev: z.string().min(1, "Rev. is required"),
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
  const [isSavingLocal, setIsSavingLocal] = useState(false);
  const [isUploadingSharePoint, setIsUploadingSharePoint] = useState(false);
  const [sharePointSuccess, setSharePointSuccess] = useState(false);
  const [partNumberOptions, setPartNumberOptions] = useState<{ partNumber: string; rev: string; customerName: string }[]>([]);
  const [workOrderOpen, setWorkOrderOpen] = useState(false);
  const [workOrderSearch, setWorkOrderSearch] = useState("");
  const { toast } = useToast();

  // Fetch all work orders
  const { data: workOrders = [] } = useQuery<string[]>({
    queryKey: ['/api/work-orders'],
    staleTime: Infinity,
  });

  const lastDept = localStorage.getItem("lastDept") || "";
  const lastPartNumber = localStorage.getItem("lastPartNumber") || "";
  const lastRev = localStorage.getItem("lastRev") || "";
  const lastCustomerName = localStorage.getItem("lastCustomerName") || "";
  const lastWorkOrderNumber = localStorage.getItem("lastWorkOrderNumber") || "";

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadFormSchema),
    defaultValues: {
      dept: lastDept,
      partNumber: lastPartNumber,
      rev: lastRev,
      customerName: lastCustomerName,
      workOrderNumber: lastWorkOrderNumber,
    },
  });

  // Watch dept and rev fields and save to localStorage when they change
  const dept = form.watch("dept");
  const rev = form.watch("rev");
  const workOrderNumber = form.watch("workOrderNumber");

  // Track previous work order to detect changes
  const [prevWorkOrder, setPrevWorkOrder] = useState(workOrderNumber);

  // Fetch part numbers and clear dependent fields when work order changes
  useEffect(() => {
    // Clear dependent fields when work order changes
    if (workOrderNumber !== prevWorkOrder) {
      form.setValue("partNumber", "");
      form.setValue("rev", "");
      form.setValue("customerName", "");
      setPrevWorkOrder(workOrderNumber);
    }

    const fetchPartNumbers = async () => {
      if (workOrderNumber) {
        try {
          const response = await fetch(`/api/part-numbers/${encodeURIComponent(workOrderNumber)}`);
          if (response.ok) {
            const data = await response.json();
            setPartNumberOptions(data);
          } else {
            setPartNumberOptions([]);
          }
        } catch (error) {
          console.error("Error fetching part numbers:", error);
          setPartNumberOptions([]);
        }
      } else {
        setPartNumberOptions([]);
      }
    };

    fetchPartNumbers();
  }, [workOrderNumber, prevWorkOrder, form]);

  // Auto-populate rev and customer name when part number is selected
  const handlePartNumberSelect = (selectedValue: string) => {
    // Parse the value which is in format "partNumber-index"
    const lastDashIndex = selectedValue.lastIndexOf('-');
    const partNumber = selectedValue.substring(0, lastDashIndex);
    const index = parseInt(selectedValue.substring(lastDashIndex + 1));
    
    form.setValue("partNumber", partNumber);
    const selectedPart = partNumberOptions[index];
    if (selectedPart) {
      if (selectedPart.rev) {
        form.setValue("rev", selectedPart.rev);
      }
      if (selectedPart.customerName) {
        form.setValue("customerName", selectedPart.customerName);
      }
    }
  };

  useEffect(() => {
    if (dept) {
      localStorage.setItem("lastDept", dept);
    }
  }, [dept]);

  useEffect(() => {
    if (rev) {
      localStorage.setItem("lastRev", rev);
    }
  }, [rev]);

  // Sync workOrderSearch with form value
  useEffect(() => {
    setWorkOrderSearch(workOrderNumber);
  }, [workOrderNumber]);

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
      localStorage.setItem("lastDept", data.dept);
      localStorage.setItem("lastPartNumber", data.partNumber);
      localStorage.setItem("lastRev", data.rev);
      localStorage.setItem("lastCustomerName", data.customerName);
      localStorage.setItem("lastWorkOrderNumber", data.workOrderNumber);
      
      const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
      const imageName = `${data.partNumber}Rev${data.rev}-${timestamp}`;
      await onSubmit({ ...data, imageName });
      setUploadSuccess(true);
      setTimeout(() => {
        setUploadSuccess(false);
        form.reset({
          dept: data.dept,
          partNumber: data.partNumber,
          rev: data.rev,
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

  const handleSaveLocally = async () => {
    if (!selectedFile || !dept || !customerName || !workOrderNumber || !partNumber) {
      toast({
        title: "Missing Information",
        description: "Please fill in all fields and select an image before saving.",
        variant: "destructive",
      });
      return;
    }

    setIsSavingLocal(true);
    try {
      // Check if the File System Access API is supported
      if ('showDirectoryPicker' in window) {
        // Use File System Access API to create folder structure
        const directoryHandle = await (window as any).showDirectoryPicker();
        
        // Create or get ACE folder
        const aceFolderHandle = await directoryHandle.getDirectoryHandle('ACE', { create: true });
        
        // Create or get customer name folder
        const customerFolderHandle = await aceFolderHandle.getDirectoryHandle(customerName, { create: true });
        
        // Create or get dept folder
        const deptFolderHandle = await customerFolderHandle.getDirectoryHandle(dept, { create: true });
        
        // Create or get work order folder inside dept folder
        const workOrderFolderHandle = await deptFolderHandle.getDirectoryHandle(workOrderNumber, { create: true });
        
        // Generate filename with timestamp
        const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
        const extension = selectedFile.name.split('.').pop() || 'jpg';
        const filename = `${partNumber}Rev${rev}-${timestamp}.${extension}`;
        
        // Create and write the file
        const fileHandle = await workOrderFolderHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(selectedFile);
        await writable.close();
        
        toast({
          title: "Saved Successfully",
          description: `Image saved to ACE/${customerName}/${dept}/${workOrderNumber}/${filename}`,
        });
      } else {
        // Fallback: simple download with suggested path in filename
        const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
        const extension = selectedFile.name.split('.').pop() || 'jpg';
        const filename = `${partNumber}Rev${rev}-${timestamp}.${extension}`;
        
        const url = URL.createObjectURL(selectedFile);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toast({
          title: "Download Started",
          description: `Please create folders: ACE/${customerName}/${dept}/${workOrderNumber}/ and move the file there.`,
        });
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // User cancelled the directory picker
        toast({
          title: "Cancelled",
          description: "Save operation was cancelled.",
        });
      } else {
        console.error("Save failed:", error);
        toast({
          title: "Save Failed",
          description: "Could not save the image locally.",
          variant: "destructive",
        });
      }
    } finally {
      setIsSavingLocal(false);
    }
  };

  const handleSharePointUpload = async () => {
    if (!selectedFile || !dept || !customerName || !workOrderNumber || !partNumber) {
      toast({
        title: "Missing Information",
        description: "Please fill in all fields and select an image before uploading.",
        variant: "destructive",
      });
      return;
    }

    setIsUploadingSharePoint(true);
    try {
      const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
      const imageName = `${partNumber}Rev${form.watch("rev")}-${timestamp}`;
      
      const formData = new FormData();
      formData.append("imageFile", selectedFile);
      formData.append("customerName", customerName);
      formData.append("dept", dept);
      formData.append("workOrderNumber", workOrderNumber);
      formData.append("imageName", imageName);

      const response = await fetch("/api/upload/sharepoint", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        if (result.requiresAuth) {
          toast({
            title: "SharePoint Not Connected",
            description: "Please connect your SharePoint account in the Integrations panel to upload files.",
            variant: "destructive",
          });
          throw new Error(result.message);
        }
        throw new Error(result.error || "Upload failed");
      }

      toast({
        title: "Upload Successful",
        description: `Image saved to SharePoint: ${result.path}`,
      });

      setSharePointSuccess(true);
      setTimeout(() => {
        setSharePointSuccess(false);
      }, 2000);
    } catch (error: any) {
      console.error("SharePoint upload error:", error);
      if (!error.message.includes('not connected')) {
        toast({
          title: "Upload Failed",
          description: error.message || "An error occurred while uploading to SharePoint.",
          variant: "destructive",
        });
      }
    } finally {
      setIsUploadingSharePoint(false);
    }
  };

  const customerName = form.watch("customerName");
  const partNumber = form.watch("partNumber");

  // Check if work order matches the list (normalize trailing zeros for comparison)
  const normalizeWorkOrder = (wo: string) => {
    if (wo.length > 0 && /[1-9]/.test(wo)) {
      return wo.replace(/0+$/, '');
    }
    return wo;
  };
  
  const workOrderMatches = workOrderNumber && workOrders.some(wo => 
    normalizeWorkOrder(wo) === normalizeWorkOrder(workOrderNumber)
  );

  return (
    <div className="w-full max-w-3xl mx-auto px-3 sm:px-4 md:px-6 space-y-4 sm:space-y-6">
      <div className="text-center space-y-1 sm:space-y-2">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-semibold text-foreground">Ace Image Organizer</h1>
        <p className="text-muted-foreground text-base sm:text-lg">Capture and organize images</p>
      </div>

      <form onSubmit={form.handleSubmit(handleFormSubmit)} className="space-y-4 sm:space-y-6">
        <Card className="p-4 sm:p-6 space-y-4 sm:space-y-6">
          <div className="space-y-3 sm:space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dept" className="text-base sm:text-lg font-medium">
                Dept <span className="text-destructive">*</span>
              </Label>
              <Select
                value={form.watch("dept")}
                onValueChange={(value) => form.setValue("dept", value)}
              >
                <SelectTrigger className="min-h-12 sm:min-h-14 text-base" data-testid="select-dept">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="QC">QC</SelectItem>
                  <SelectItem value="Testing">Testing</SelectItem>
                </SelectContent>
              </Select>
              {form.formState.errors.dept && (
                <p className="text-sm text-destructive">{form.formState.errors.dept.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="workOrderNumber" className="text-base sm:text-lg font-medium">
                Work Order # <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="workOrderNumber"
                  data-testid="input-work-order"
                  value={workOrderSearch}
                  onChange={(e) => {
                    const value = e.target.value;
                    setWorkOrderSearch(value);
                    form.setValue("workOrderNumber", value);
                    setWorkOrderOpen(true);
                  }}
                  onFocus={() => setWorkOrderOpen(true)}
                  onBlur={() => {
                    // Close dropdown after a small delay to allow clicking items
                    setTimeout(() => setWorkOrderOpen(false), 200);
                  }}
                  placeholder="Type or select work order"
                  className="min-h-12 sm:min-h-14 text-base font-mono"
                />
                {workOrderOpen && workOrders.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-auto">
                    {workOrders
                      .filter((wo) => wo.toLowerCase().includes(workOrderSearch.toLowerCase()))
                      .map((wo) => (
                        <div
                          key={wo}
                          className={cn(
                            "px-3 py-2 cursor-pointer hover-elevate text-sm font-mono flex items-center",
                            form.watch("workOrderNumber") === wo && "bg-accent"
                          )}
                          onMouseDown={(e) => {
                            e.preventDefault(); // Prevent input blur
                            setWorkOrderSearch(wo);
                            form.setValue("workOrderNumber", wo);
                            setWorkOrderOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              form.watch("workOrderNumber") === wo ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {wo}
                        </div>
                      ))}
                    {workOrders.filter((wo) => wo.toLowerCase().includes(workOrderSearch.toLowerCase())).length === 0 && (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No work order found.
                      </div>
                    )}
                  </div>
                )}
              </div>
              {form.formState.errors.workOrderNumber && (
                <p className="text-sm text-destructive">{form.formState.errors.workOrderNumber.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="partNumber" className="text-base sm:text-lg font-medium">
                Part # <span className="text-destructive">*</span>
              </Label>
              <Select
                value={partNumber ? `${partNumber}-${partNumberOptions.findIndex(p => 
                  p.partNumber === partNumber && 
                  p.rev === rev && 
                  p.customerName === customerName
                )}` : ""}
                onValueChange={handlePartNumberSelect}
                disabled={!workOrderNumber || partNumberOptions.length === 0}
              >
                <SelectTrigger className="min-h-12 sm:min-h-14 text-base font-mono" data-testid="select-part-number">
                  <SelectValue placeholder={workOrderNumber ? (partNumberOptions.length > 0 ? "Select part number" : "No parts for this work order") : "Select work order first"} />
                </SelectTrigger>
                <SelectContent>
                  {partNumberOptions.map((part, index) => (
                    <SelectItem key={`${part.partNumber}-${index}`} value={`${part.partNumber}-${index}`}>
                      {part.partNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.formState.errors.partNumber && (
                <p className="text-sm text-destructive">{form.formState.errors.partNumber.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="rev" className="text-base sm:text-lg font-medium">
                Rev. <span className="text-destructive">*</span>
              </Label>
              <Input
                id="rev"
                data-testid="input-rev"
                {...form.register("rev")}
                placeholder="Auto-filled from Excel"
                className="min-h-12 sm:min-h-14 text-base bg-muted"
                readOnly
              />
              {form.formState.errors.rev && (
                <p className="text-sm text-destructive">{form.formState.errors.rev.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="customerName" className="text-base sm:text-lg font-medium">
                Customer Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customerName"
                data-testid="input-customer-name"
                {...form.register("customerName")}
                placeholder="Auto-filled from Excel"
                className="min-h-12 sm:min-h-14 text-base bg-muted"
                readOnly
              />
              {form.formState.errors.customerName && (
                <p className="text-sm text-destructive">{form.formState.errors.customerName.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-base sm:text-lg font-medium">
                Image <span className="text-destructive">*</span>
              </Label>
              <div className="flex flex-col sm:flex-row gap-3">
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
                  className="w-full sm:flex-1 min-h-12 sm:min-h-14"
                  onClick={() => document.getElementById("camera-input")?.click()}
                  disabled={!workOrderMatches}
                  data-testid="button-camera"
                >
                  <Camera className="w-5 h-5 mr-2" />
                  Take Photo
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="w-full sm:flex-1 min-h-12 sm:min-h-14"
                  onClick={() => document.getElementById("gallery-input")?.click()}
                  disabled={!workOrderMatches}
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
          <Card className="p-4 sm:p-6">
            <div className="space-y-3 sm:space-y-4">
              <h3 className="text-base sm:text-lg font-medium">Image Preview</h3>
              <div className="relative aspect-video bg-muted rounded-lg overflow-hidden">
                <img src={imagePreview} alt="Preview" className="w-full h-full object-contain" />
              </div>
              {selectedFile && (
                <div className="space-y-1">
                  {partNumber && rev && (
                    <p className="text-sm font-medium text-foreground" data-testid="text-generated-name">
                      Generated name: {partNumber}Rev{rev}-{format(new Date(), "yyyyMMdd-HHmmss")}
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

        {(customerName || dept || workOrderNumber) && (
          <Card className="p-4 sm:p-6 bg-accent/50">
            <div className="flex items-start gap-2 sm:gap-3">
              <FolderOpen className="w-4 h-4 sm:w-5 sm:h-5 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <h3 className="text-xs sm:text-sm font-medium text-muted-foreground mb-1">Folder Path</h3>
                <p className="font-mono text-sm sm:text-base text-foreground break-all" data-testid="text-folder-path">
                  ACE / {customerName || "[Customer Name]"} / {dept || "[Dept]"} / {workOrderNumber || "[Work Order #]"}
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full sm:flex-1 min-h-12 sm:min-h-14"
            onClick={() => {
              form.reset({
                dept: "",
                partNumber: "",
                rev: "",
                customerName: "",
                workOrderNumber: "",
              });
              setImagePreview(null);
              setSelectedFile(null);
            }}
            disabled={isUploading || isSavingLocal || isUploadingSharePoint}
            data-testid="button-clear"
          >
            Clear Form
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="w-full sm:flex-1 min-h-12 sm:min-h-14"
            onClick={handleSaveLocally}
            disabled={isUploading || isSavingLocal || isUploadingSharePoint || !selectedFile || !workOrderMatches}
            data-testid="button-save-local"
          >
            {isSavingLocal ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Download className="w-5 h-5 mr-2" />
                Save Locally
              </>
            )}
          </Button>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            type="submit"
            size="lg"
            className="w-full sm:flex-1 min-h-12 sm:min-h-14"
            disabled={isUploading || isSavingLocal || isUploadingSharePoint || !selectedFile || !workOrderMatches}
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
          <Button
            type="button"
            size="lg"
            className="w-full sm:flex-1 min-h-12 sm:min-h-14"
            onClick={handleSharePointUpload}
            disabled={isUploading || isSavingLocal || isUploadingSharePoint || !selectedFile || !workOrderMatches}
            data-testid="button-upload-sharepoint"
          >
            {isUploadingSharePoint ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Uploading...
              </>
            ) : sharePointSuccess ? (
              <>
                <CheckCircle2 className="w-5 h-5 mr-2" />
                Success!
              </>
            ) : (
              <>
                <Upload className="w-5 h-5 mr-2" />
                Upload to SharePoint
              </>
            )}
          </Button>
        </div>
      </form>
      
      <div className="text-center mt-8 pb-4">
        <p className="text-sm text-muted-foreground">Made by PP Inc.</p>
      </div>
    </div>
  );
}
