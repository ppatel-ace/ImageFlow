import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
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
import { Camera, Upload, FolderOpen, CheckCircle2, Loader2, Image as ImageIcon, Download, Check, RefreshCw, ChevronsUpDown } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import CustomCamera from "@/components/CustomCamera";
import { shouldUseCustomCamera } from "@/lib/deviceDetection";

// Sanitize path components by replacing invalid characters with underscore
const sanitizePath = (value: string): string => {
  return value.replace(/[<>:"/\\|?*]/g, '_');
};

const uploadFormSchema = z.object({
  dept: z.string().min(1, "Dept is required"),
  partNumber: z.string().min(1, "Part # is required"),
  rev: z.string().min(1, "Rev. is required"),
  customerName: z.string().min(1, "Customer name is required"),
  workOrderNumber: z.string().min(1, "Work Order # is required"),
});

type UploadFormData = z.infer<typeof uploadFormSchema>;

interface CapturedImage {
  file: File;
  preview: string;
  id: string;
}

export default function ImageUploadForm() {
  const [capturedImages, setCapturedImages] = useState<CapturedImage[]>([]);
  const [isSavingLocal, setIsSavingLocal] = useState(false);
  const [isUploadingSharePoint, setIsUploadingSharePoint] = useState(false);
  const [sharePointSuccess, setSharePointSuccess] = useState(false);
  const [partNumberOptions, setPartNumberOptions] = useState<{ partNumber: string; rev: string; customerName: string }[]>([]);
  const [workOrderOpen, setWorkOrderOpen] = useState(false);
  const [workOrderSearch, setWorkOrderSearch] = useState("");
  const [partNumberOpen, setPartNumberOpen] = useState(false);
  const [partNumberSearch, setPartNumberSearch] = useState("");
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [lastAutoCheck, setLastAutoCheck] = useState<string | null>(null);
  const [lastManualCheck, setLastManualCheck] = useState<string | null>(null);
  const [showCustomCamera, setShowCustomCamera] = useState(false);
  const { toast } = useToast();

  // Prevent body scroll when camera is open
  useEffect(() => {
    if (showCustomCamera) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showCustomCamera]);

  // Clear old localStorage entries that are no longer used (auto-filled fields)
  useEffect(() => {
    localStorage.removeItem("lastPartNumber");
    localStorage.removeItem("lastRev");
    localStorage.removeItem("lastCustomerName");
  }, []);

  // Fetch all work orders (refetch after Excel sync / on focus)
  const { data: workOrders = [], refetch: refetchWorkOrders, isFetching: isFetchingWorkOrders } = useQuery<string[]>({
    queryKey: ['/api/work-orders'],
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const lastDept = localStorage.getItem("lastDept") || "";
  const lastWorkOrderNumber = localStorage.getItem("lastWorkOrderNumber") || "";

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadFormSchema),
    defaultValues: {
      dept: lastDept,
      partNumber: "",
      rev: "",
      customerName: "",
      workOrderNumber: lastWorkOrderNumber,
    },
  });

  // Watch all form fields efficiently
  const { dept, rev, workOrderNumber, partNumber, customerName } = form.watch();
  const [prevWorkOrder, setPrevWorkOrder] = useState(workOrderNumber);

  // Auto-populate part number fields from selection
  const handlePartNumberSelect = (index: number) => {
    const selectedPart = partNumberOptions[index];
    if (selectedPart) {
      setPartNumberSearch(selectedPart.partNumber);
      form.setValue("partNumber", selectedPart.partNumber);
      form.setValue("rev", selectedPart.rev || "");
      form.setValue("customerName", selectedPart.customerName || "");
      setPartNumberOpen(false);
    }
  };

  // Save dept to localStorage
  useEffect(() => {
    if (dept) localStorage.setItem("lastDept", dept);
  }, [dept]);

  // Sync search fields with form values
  useEffect(() => {
    setWorkOrderSearch(workOrderNumber);
    setPartNumberSearch(partNumber);
  }, [workOrderNumber, partNumber]);

  // Fetch part numbers when work order changes
  useEffect(() => {
    if (workOrderNumber !== prevWorkOrder) {
      form.setValue("partNumber", "");
      form.setValue("rev", "");
      form.setValue("customerName", "");
      setPrevWorkOrder(workOrderNumber);
    }

    if (!workOrderNumber) {
      setPartNumberOptions([]);
      return;
    }

    fetch(`/api/part-numbers/${encodeURIComponent(workOrderNumber)}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        setPartNumberOptions(data);
        if (data.length === 1) {
          const part = data[0];
          form.setValue("partNumber", part.partNumber);
          form.setValue("rev", part.rev || "");
          form.setValue("customerName", part.customerName || "");
          setPartNumberSearch(part.partNumber);
        }
      })
      .catch(() => setPartNumberOptions([]));
  }, [workOrderNumber, prevWorkOrder, form]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // Process each selected file
      Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const newImage: CapturedImage = {
            file: file,
            preview: reader.result as string,
            id: `${Date.now()}-${Math.random()}`
          };
          setCapturedImages(prev => [...prev, newImage]);
        };
        reader.readAsDataURL(file);
      });
      
      // Reset input value so same file can be selected again
      e.target.value = '';
    }
  };

  const handleCameraCapture = (file: File) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const newImage: CapturedImage = {
        file: file,
        preview: reader.result as string,
        id: `${Date.now()}-${Math.random()}`
      };
      setCapturedImages(prev => [...prev, newImage]);
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (imageId: string) => {
    setCapturedImages(prev => prev.filter(img => img.id !== imageId));
  };

  // Helper to generate unique filename
  const generateFilename = (fileExtension: string) => {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss-SSS");
    return `${sanitizePath(partNumber)}Rev${sanitizePath(rev)}-${timestamp}.${fileExtension}`;
  };

  const handleSaveLocally = async () => {
    if (capturedImages.length === 0 || !dept || !customerName || !workOrderNumber || !partNumber) {
      toast({
        title: "Missing Information",
        description: "Please fill in all fields and capture at least one image before saving.",
        variant: "destructive",
      });
      return;
    }

    setIsSavingLocal(true);
    const sanitizedCustomerName = sanitizePath(customerName);
    
    try {
      if ('showDirectoryPicker' in window) {
        const directoryHandle = await (window as any).showDirectoryPicker();
        const folderHandle = await directoryHandle.getDirectoryHandle(dept, { create: true })
          .then((h: any) => h.getDirectoryHandle(sanitizedCustomerName, { create: true }))
          .then((h: any) => h.getDirectoryHandle(workOrderNumber, { create: true }));
        
        for (const image of capturedImages) {
          const ext = image.file.name.split('.').pop() || 'jpg';
          const fileHandle = await folderHandle.getFileHandle(generateFilename(ext), { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(image.file);
          await writable.close();
        }
        
        toast({
          title: "Saved Successfully",
          description: `${capturedImages.length} image(s) saved to ${dept}/${sanitizedCustomerName}/${workOrderNumber}/`,
        });
      } else {
        for (const image of capturedImages) {
          const ext = image.file.name.split('.').pop() || 'jpg';
          const url = URL.createObjectURL(image.file);
          const a = Object.assign(document.createElement('a'), {
            href: url,
            download: generateFilename(ext)
          });
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        
        toast({
          title: "Download Started",
          description: `${capturedImages.length} image(s) downloaded. Please create folders: ${dept}/${sanitizedCustomerName}/${workOrderNumber}/ and move the files there.`,
        });
      }
      
      setCapturedImages([]);
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
    if (capturedImages.length === 0 || !dept || !customerName || !workOrderNumber || !partNumber) {
      toast({
        title: "Missing Information",
        description: "Please fill in all fields and capture at least one image before uploading.",
        variant: "destructive",
      });
      return;
    }

    setIsUploadingSharePoint(true);
    
    try {
      let uploadedCount = 0;
      let lastErrorMessage = "";
      let authErrorEncountered = false;

      for (let i = 0; i < capturedImages.length; i++) {
        const image = capturedImages[i];
        const ext = image.file.name.split('.').pop() || 'jpg';
        const filename = generateFilename(ext);
        const imageName = filename.substring(0, filename.lastIndexOf('.')); // Remove extension for API

        const formData = new FormData();
        formData.append("imageFile", image.file);
        formData.append("customerName", customerName);
        formData.append("dept", dept);
        formData.append("workOrderNumber", workOrderNumber);
        formData.append("imageName", imageName);

        try {
          const response = await fetch("/api/upload/sharepoint", {
            method: "POST",
            body: formData,
            credentials: "include",
          });

          const result = await response.json().catch(() => ({} as any));

          if (response.ok) {
            uploadedCount++;
            continue;
          }

          if (response.status === 401 && result?.ssoLoginUrl) {
            window.location.assign(result.ssoLoginUrl);
            return;
          }

          // Capture the actual server-reported reason so we can surface it below
          lastErrorMessage = result?.message || result?.error || `HTTP ${response.status}`;
          if (result?.requiresAuth) {
            authErrorEncountered = true;
            // Auth issue won't recover by retrying the remaining files — stop early
            break;
          }
        } catch (err: any) {
          // Network-level failure (the fetch itself never reached the server)
          lastErrorMessage = "Could not reach the server. Please check your internet connection.";
          console.error(`Image ${i + 1} upload failed:`, err?.message);
        }
      }

      if (uploadedCount > 0) {
        toast({
          title: "Upload Successful",
          description: `${uploadedCount} of ${capturedImages.length} image(s) uploaded to SharePoint`,
        });
        setCapturedImages([]);
        setSharePointSuccess(true);
        setTimeout(() => {
          setSharePointSuccess(false);
        }, 2000);
      } else if (authErrorEncountered) {
        toast({
          title: "SharePoint Not Configured",
          description:
            lastErrorMessage ||
            "SharePoint / Azure Graph credentials are missing or invalid. Contact IT.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Upload Failed",
          description: lastErrorMessage || "Could not upload any images.",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      console.error("SharePoint upload error:", error);
      toast({
        title: "Upload Failed",
        description: error?.message || "An error occurred while uploading to SharePoint.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingSharePoint(false);
    }
  };

  const handleCheckUpdates = async (isAutoCheck: boolean = false, checkType: 'pageLoad' | 'scheduled' | 'manual' = 'manual') => {
    setIsCheckingUpdates(true);
    
    const now = new Date().toISOString();
    
    // Record the auto-check attempt BEFORE making the request
    if (isAutoCheck) {
      // Track page load and scheduled checks separately
      if (checkType === 'pageLoad') {
        localStorage.setItem("lastPageLoadCheck", now);
      } else if (checkType === 'scheduled') {
        localStorage.setItem("lastScheduledCheck", now);
      }
      
      // Also update the general last auto-check for UI display
      localStorage.setItem("lastAutoCheckDate", now);
      setLastAutoCheck(now);
    } else {
      // Track manual check
      localStorage.setItem("lastManualCheck", now);
      setLastManualCheck(now);
    }
    
    try {
      const response = await fetch("/api/check-excel-updates", {
        method: "POST",
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: isAutoCheck ? "Auto-Update Successful!" : "Excel Data Updated!",
          description: `Updated from ${result.source || "remote"}: ${result.originalFileName}`,
        });
        await refetchWorkOrders();
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        // Only show toast for manual checks, silent for auto-checks with no updates
        if (!isAutoCheck) {
          toast({
            title: "No Updates Found",
            description: result.message || "No new Open Orders Excel file found on SFTP",
          });
        }
      }
    } catch (error: any) {
      console.error("Update check error:", error);
      // Only show error toast for manual checks
      if (!isAutoCheck) {
        toast({
          title: "Check Failed",
          description: error.message || "Failed to check for updates",
          variant: "destructive",
        });
      }
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  // Load last auto-check date and manual check date on mount
  useEffect(() => {
    const lastCheck = localStorage.getItem("lastAutoCheckDate");
    if (lastCheck) {
      setLastAutoCheck(lastCheck);
    }

    const lastManual = localStorage.getItem("lastManualCheck");
    if (lastManual) {
      setLastManualCheck(lastManual);
    }
  }, []);

  // Auto-check on page load (runs once)
  useEffect(() => {

    const performAutoCheck = async () => {
      const lastPageLoadCheckDate = localStorage.getItem("lastPageLoadCheck");
      
      // Check if we already did a page load check today
      if (lastPageLoadCheckDate) {
        const lastCheck = new Date(lastPageLoadCheckDate);
        const now = new Date();
        
        // Compare dates (same day check)
        if (lastCheck.toDateString() === now.toDateString()) {
          return; // Already did page load check today, skip
        }
      }
      
      // Wait 2 seconds after page load to check
      setTimeout(() => {
        handleCheckUpdates(true, 'pageLoad');
      }, 2000);
    };

    performAutoCheck();
  }, []); // Run once on mount

  // Scheduled check at 7:20 AM EST/EDT daily
  useEffect(() => {

    const getEasternDateString = (date: Date): string => {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
      const parts = formatter.formatToParts(date);
      const year = parts.find(p => p.type === "year")?.value;
      const month = parts.find(p => p.type === "month")?.value;
      const day = parts.find(p => p.type === "day")?.value;
      return `${year}-${month}-${day}`;
    };

    const checkScheduledTime = () => {
      const now = new Date();
      
      // Get current time in America/New_York timezone using Intl.DateTimeFormat
      const timeFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      
      const timeParts = timeFormatter.formatToParts(now);
      const hours = parseInt(timeParts.find(p => p.type === "hour")?.value || "0");
      const minutes = parseInt(timeParts.find(p => p.type === "minute")?.value || "0");
      
      // Check if it's 7:20 AM EST/EDT
      if (hours === 7 && minutes === 20) {
        const lastScheduledCheckDate = localStorage.getItem("lastScheduledCheck");
        
        // Only check if we haven't done the scheduled check today (in Eastern timezone)
        if (lastScheduledCheckDate) {
          const lastCheck = new Date(lastScheduledCheckDate);
          const lastCheckEasternDate = getEasternDateString(lastCheck);
          const todayEasternDate = getEasternDateString(now);
          
          if (lastCheckEasternDate === todayEasternDate) {
            return; // Already did scheduled check today in Eastern timezone, skip
          }
        }
        
        handleCheckUpdates(true, 'scheduled');
      }
    };

    // Check every minute for the scheduled time
    const interval = setInterval(checkScheduledTime, 60000);

    // Also check immediately when component mounts
    checkScheduledTime();

    return () => clearInterval(interval);
  }, []);

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
      <div className="text-center space-y-3 sm:space-y-4">
        <div className="space-y-1 sm:space-y-2">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-semibold text-foreground">Ace Image Organizer</h1>
          <p className="text-muted-foreground text-base sm:text-lg">Capture and organize images</p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-h-12 sm:min-h-14"
              onClick={() => handleCheckUpdates(false)}
              disabled={isCheckingUpdates}
              data-testid="button-check-updates"
            >
              {isCheckingUpdates ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <RefreshCw className="w-5 h-5 mr-2" />
                  Check for Updates
                </>
              )}
            </Button>
            <Button
              type="button"
              size="lg"
              className="min-h-12 sm:min-h-14 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => window.location.reload()}
              data-testid="button-hard-refresh"
            >
              <RefreshCw className="w-5 h-5 mr-2" />
              Refresh Page
            </Button>
          </div>
          <div className="text-xs text-muted-foreground text-center">
            <p className="flex items-center gap-1 justify-center">
              <Check className="w-3 h-3 text-green-600" />
              Sage SFTP Open Orders — Auto-updates: Daily at 7:20 AM EST & on page load
            </p>
            {lastAutoCheck && (
              <p className="text-xs">
                Last auto-check: {new Date(lastAutoCheck).toLocaleString()}
              </p>
            )}
            {lastManualCheck && (
              <p className="text-xs">
                Last manual check: {new Date(lastManualCheck).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>

      <form className="space-y-4 sm:space-y-6">
        <Card className="p-4 sm:p-6 space-y-4 sm:space-y-6">
          <div className="space-y-3 sm:space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dept" className="text-base sm:text-lg font-medium">
                Dept <span className="text-destructive">*</span>
              </Label>
              <Select
                value={dept}
                onValueChange={(value) => form.setValue("dept", value)}
              >
                <SelectTrigger className="min-h-12 sm:min-h-14 text-base" data-testid="select-dept">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="QC">QC</SelectItem>
                  <SelectItem value="Testing">Testing</SelectItem>
                  <SelectItem value="Production">Production</SelectItem>
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
                  onClick={() => setWorkOrderOpen(true)}
                  onBlur={() => {
                    setTimeout(() => setWorkOrderOpen(false), 200);
                  }}
                  placeholder={
                    isFetchingWorkOrders
                      ? "Loading work orders…"
                      : workOrders.length > 0
                        ? `Type or select (${workOrders.length} available)`
                        : "No work orders loaded — check Excel sync"
                  }
                  className="min-h-12 sm:min-h-14 text-base font-mono pr-10"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                  aria-label="Show work orders"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setWorkOrderOpen((open) => !open);
                  }}
                >
                  <ChevronsUpDown className="h-4 w-4" />
                </button>
                {workOrderOpen && (
                  <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-auto">
                    {workOrders.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        {isFetchingWorkOrders
                          ? "Loading work orders…"
                          : "No work orders available. Use Check for Updates to sync Excel from SFTP."}
                      </div>
                    ) : (
                      <>
                        {workOrders
                          .filter((wo) => wo.toLowerCase().includes(workOrderSearch.toLowerCase()))
                          .map((wo) => (
                            <div
                              key={wo}
                              className={cn(
                                "px-3 py-2 cursor-pointer hover-elevate text-sm font-mono flex items-center",
                                workOrderNumber === wo && "bg-accent"
                              )}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setWorkOrderSearch(wo);
                                form.setValue("workOrderNumber", wo);
                                setWorkOrderOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4 shrink-0",
                                  workOrderNumber === wo ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {wo}
                            </div>
                          ))}
                        {workOrders.filter((wo) =>
                          wo.toLowerCase().includes(workOrderSearch.toLowerCase())
                        ).length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            No work order matches “{workOrderSearch}”.
                          </div>
                        )}
                      </>
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
              <div className="relative">
                <Input
                  id="partNumber"
                  data-testid="input-part-number"
                  value={partNumberSearch}
                  onChange={(e) => {
                    const value = e.target.value;
                    setPartNumberSearch(value);
                    form.setValue("partNumber", value);
                    setPartNumberOpen(true);
                  }}
                  onFocus={() => workOrderNumber && setPartNumberOpen(true)}
                  onClick={() => workOrderNumber && setPartNumberOpen(true)}
                  onBlur={() => {
                    setTimeout(() => setPartNumberOpen(false), 200);
                  }}
                  placeholder={
                    !workOrderNumber
                      ? "Select work order first"
                      : partNumberOptions.length > 0
                        ? `Type or select (${partNumberOptions.length} available)`
                        : "No parts for this work order"
                  }
                  className="min-h-12 sm:min-h-14 text-base font-mono pr-10"
                  disabled={!workOrderNumber}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                  aria-label="Show part numbers"
                  disabled={!workOrderNumber}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (workOrderNumber) setPartNumberOpen((open) => !open);
                  }}
                >
                  <ChevronsUpDown className="h-4 w-4" />
                </button>
                {partNumberOpen && workOrderNumber && (
                  <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-auto">
                    {partNumberOptions.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No part numbers found for this work order.
                      </div>
                    ) : (
                      <>
                        {partNumberOptions
                          .map((part, index) => ({ part, index }))
                          .filter(({ part }) =>
                            part.partNumber.toLowerCase().includes(partNumberSearch.toLowerCase())
                          )
                          .map(({ part, index }) => (
                            <div
                              key={`${part.partNumber}-${index}`}
                              className={cn(
                                "px-3 py-2 cursor-pointer hover-elevate text-sm font-mono flex items-center",
                                partNumber === part.partNumber &&
                                  rev === part.rev &&
                                  customerName === part.customerName &&
                                  "bg-accent"
                              )}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handlePartNumberSelect(index);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4 shrink-0",
                                  partNumber === part.partNumber &&
                                    rev === part.rev &&
                                    customerName === part.customerName
                                    ? "opacity-100"
                                    : "opacity-0"
                                )}
                              />
                              <span className="truncate">
                                {part.partNumber}
                                {part.rev ? (
                                  <span className="text-muted-foreground"> · Rev {part.rev}</span>
                                ) : null}
                              </span>
                            </div>
                          ))}
                        {partNumberOptions.filter((part) =>
                          part.partNumber.toLowerCase().includes(partNumberSearch.toLowerCase())
                        ).length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            No part number matches “{partNumberSearch}”.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
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
                {shouldUseCustomCamera() ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full sm:flex-1 min-h-12 sm:min-h-14"
                    onClick={() => setShowCustomCamera(true)}
                    disabled={!workOrderMatches}
                    data-testid="button-camera"
                  >
                    <Camera className="w-5 h-5 mr-2" />
                    Open Camera
                  </Button>
                ) : (
                  <label
                    htmlFor={workOrderMatches ? "camera-input" : undefined}
                    data-testid="button-camera"
                    className={cn(
                      "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
                      "w-full sm:flex-1 min-h-12 sm:min-h-14 px-8 cursor-pointer",
                      !workOrderMatches && "opacity-50 pointer-events-none cursor-not-allowed"
                    )}
                  >
                    <Camera className="w-5 h-5 mr-2" />
                    Take Photo
                  </label>
                )}
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
            </div>
          </div>
        </Card>

        {capturedImages.length > 0 && (
          <Card className="p-4 sm:p-6">
            <div className="space-y-3 sm:space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base sm:text-lg font-medium">Captured Images ({capturedImages.length})</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCapturedImages([])}
                  data-testid="button-clear-all-images"
                >
                  Clear All
                </Button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {capturedImages.map((image, index) => (
                  <div key={image.id} className="relative group">
                    <div className="relative aspect-square bg-muted rounded-lg overflow-hidden">
                      <img src={image.preview} alt={`Captured ${index + 1}`} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => removeImage(image.id)}
                          data-testid={`button-remove-image-${index}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      {image.file.name} ({(image.file.size / 1024).toFixed(1)} KB)
                    </p>
                  </div>
                ))}
              </div>
              {partNumber && rev && (
                <p className="text-sm font-medium text-foreground" data-testid="text-generated-name">
                  Example filename: {partNumber}Rev{rev}-{format(new Date(), "yyyyMMdd-HHmmss-SSS")}.jpg
                </p>
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
                  {dept || "[QC / Testing / Production]"} / {customerName || "[Customer Name]"} / {workOrderNumber || "[Work Order #]"}
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
              });
              setCapturedImages([]);
            }}
            disabled={isSavingLocal || isUploadingSharePoint}
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
            disabled={isSavingLocal || isUploadingSharePoint || capturedImages.length === 0 || !workOrderMatches}
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
        
        <Button
          type="button"
          size="lg"
          className="w-full min-h-12 sm:min-h-14"
          onClick={handleSharePointUpload}
          disabled={isSavingLocal || isUploadingSharePoint || capturedImages.length === 0 || !workOrderMatches}
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
      </form>
      
      <div className="text-center mt-8 pb-4 space-y-1">
        <p className="text-sm text-muted-foreground">Made by PP Inc.</p>
        <p className="text-xs text-muted-foreground">Version 1.1</p>
      </div>

      {/* Custom Camera Modal - Android only - Rendered via Portal to bypass layout constraints */}
      {showCustomCamera && createPortal(
        <CustomCamera
          onCapture={handleCameraCapture}
          onClose={() => setShowCustomCamera(false)}
        />,
        document.body
      )}
    </div>
  );
}
