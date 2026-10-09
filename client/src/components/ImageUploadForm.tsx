import { useState, useEffect, useRef } from "react";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import CustomCamera from "@/components/CustomCamera";
import { shouldUseCustomCamera } from "@/lib/deviceDetection";
import { saveImageToDevice } from "@/lib/saveImageToDevice";
import { prepareImageForUpload } from "@/lib/compressImage";
import { trackFeature } from "@/components/AceUsageBeacon";
import UploadQueuePanel from "@/components/UploadQueuePanel";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import {
  enqueuePhotos,
  listPhotos,
  newPhotoId,
  removePhoto,
  removePhotos,
  saveDraft,
  updatePhoto,
  type QueuedPhoto,
  type UploadMeta,
} from "@/lib/uploadQueue";

// SharePoint-safe path segment (no trailing "." — e.g. "CACI TECHNOLOGIES, INC.")
const sanitizePath = (value: string): string => {
  let name = value
    .replace(/[<>:"/\\|?*#%\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return name || "_";
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
  id: string;
  /** Full-resolution original; in memory only (used by Save Locally), not persisted. */
  original: Blob | null;
  /** Compressed upload blob; null while still preparing. */
  blob: Blob | null;
  thumb: Blob | null;
  preview: string;
  ext: string;
  source: "camera" | "gallery";
  capturedAt: string;
  nameStem: string;
  nameLocked: boolean;
  sizeBytes: number;
  compressMs: number;
  preparing: boolean;
}

let lastCaptureMs = 0;

function nextCapturedAt(): string {
  let now = Date.now();
  if (now <= lastCaptureMs) now = lastCaptureMs + 1;
  lastCaptureMs = now;
  return format(new Date(now), "yyyyMMdd-HHmmss-SSS");
}

function buildDefaultStem(part: string, rev: string, capturedAt: string): string {
  return `${sanitizePath(part || "image")}Rev${sanitizePath(rev || "0")}-${capturedAt}`;
}

function fileExtension(file: Blob): string {
  const name = file instanceof File ? file.name : "";
  const fromName = name.split(".").pop();
  if (fromName && fromName !== name) return fromName.toLowerCase();
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function capturedToRecord(
  img: CapturedImage,
  status: QueuedPhoto["status"],
  meta: UploadMeta | null = null,
): QueuedPhoto {
  const now = Date.now();
  return {
    id: img.id,
    status,
    blob: img.blob,
    thumb: img.thumb,
    ext: img.ext,
    source: img.source,
    capturedAt: img.capturedAt,
    nameStem: img.nameStem,
    nameLocked: img.nameLocked,
    sizeBytes: img.sizeBytes,
    compressMs: img.compressMs,
    meta,
    attempts: 0,
    lastError: null,
    serverFailed: false,
    nextAttemptAt: now,
    queuedAt: status === "queued" ? now : null,
    createdAt: now,
    updatedAt: now,
    webUrl: null,
  };
}

function draftToCaptured(p: QueuedPhoto): CapturedImage {
  const source = p.thumb ?? p.blob;
  return {
    id: p.id,
    original: null,
    blob: p.blob,
    thumb: p.thumb,
    preview: source ? URL.createObjectURL(source) : "",
    ext: p.ext,
    source: p.source,
    capturedAt: p.capturedAt,
    nameStem: p.nameStem,
    nameLocked: p.nameLocked,
    sizeBytes: p.sizeBytes,
    compressMs: p.compressMs,
    preparing: false,
  };
}

function uniquifyStems(images: CapturedImage[]): Record<string, string> {
  const assigned: Record<string, string> = {};
  const used = new Set<string>();
  for (const img of images) {
    let stem = sanitizePath(img.nameStem);
    if (used.has(stem.toLowerCase())) {
      let n = 2;
      let candidate = `${stem}-${n}`;
      while (used.has(candidate.toLowerCase())) {
        n += 1;
        candidate = `${stem}-${n}`;
      }
      stem = candidate;
    }
    used.add(stem.toLowerCase());
    assigned[img.id] = stem;
  }
  return assigned;
}

export default function ImageUploadForm() {
  const [capturedImages, setCapturedImages] = useState<CapturedImage[]>([]);
  const [isSavingLocal, setIsSavingLocal] = useState(false);
  const [isUploadingSharePoint, setIsUploadingSharePoint] = useState(false);
  const [sharePointSuccess, setSharePointSuccess] = useState(false);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const removedIdsRef = useRef<Set<string>>(new Set());
  const imagesRef = useRef<CapturedImage[]>(capturedImages);
  imagesRef.current = capturedImages;
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
  const queryClient = useQueryClient();

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

  const trackPreview = (url: string) => {
    if (url) previewUrlsRef.current.add(url);
    return url;
  };

  const releasePreview = (url: string) => {
    if (url && previewUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
  };

  // Restore photos captured before a refresh / SSO redirect / app kill.
  useEffect(() => {
    let cancelled = false;
    listPhotos()
      .then((all) => {
        if (cancelled) return;
        const drafts = all.filter((p) => p.status === "draft");
        if (drafts.length === 0) return;
        const restored = drafts.map((p) => {
          const img = draftToCaptured(p);
          trackPreview(img.preview);
          return img;
        });
        setCapturedImages((prev) => {
          const known = new Set(prev.map((i) => i.id));
          return [...prev, ...restored.filter((i) => !known.has(i.id))];
        });
      })
      .catch((err) => console.warn("[uploadQueue] draft restore failed:", err));
    const urls = previewUrlsRef.current;
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  const addCapturedImage = (file: File, source: "camera" | "gallery") => {
    const capturedAt = nextCapturedAt();
    const nameStem = buildDefaultStem(partNumber, rev, capturedAt);
    const id = newPhotoId();
    const placeholder: CapturedImage = {
      id,
      original: file,
      blob: null,
      thumb: null,
      preview: trackPreview(URL.createObjectURL(file)),
      ext: fileExtension(file),
      source,
      capturedAt,
      nameStem,
      nameLocked: false,
      sizeBytes: file.size,
      compressMs: 0,
      preparing: true,
    };
    setCapturedImages((prev) => [...prev, placeholder]);

    void (async () => {
      const prepared = await prepareImageForUpload(file);
      if (removedIdsRef.current.has(id)) return;
      const ext = prepared.blob === file ? fileExtension(file) : "jpg";
      const current = imagesRef.current.find((img) => img.id === id) ?? placeholder;
      const ready: CapturedImage = {
        ...current,
        blob: prepared.blob,
        thumb: prepared.thumb,
        ext,
        sizeBytes: prepared.blob.size,
        compressMs: Math.round(prepared.compressMs),
        preparing: false,
      };
      try {
        await saveDraft(capturedToRecord(ready, "draft"));
      } catch (err) {
        console.error("[uploadQueue] could not persist photo:", err);
        toast({
          title: "Photo not saved on device",
          description: "Storage is full or unavailable. Upload this photo before closing the app.",
          variant: "destructive",
        });
      }
      if (removedIdsRef.current.has(id)) {
        void removePhoto(id);
        return;
      }
      setCapturedImages((prev) =>
        prev.map((img) =>
          img.id === id
            ? { ...ready, nameStem: img.nameStem, nameLocked: img.nameLocked }
            : img,
        ),
      );
    })();
  };

  const persistCameraImage = async (file: File) => {
    const result = await saveImageToDevice(file);
    if (!result.ok) {
      toast({
        title: "Device save failed",
        description: result.error || "Could not save the photo to this device.",
        variant: "destructive",
      });
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const source: "camera" | "gallery" =
      e.target.id === "camera-input" ? "camera" : "gallery";

    if (files && files.length > 0) {
      Array.from(files).forEach((file) => {
        if (source === "camera") {
          void persistCameraImage(file);
        }
        addCapturedImage(file, source);
      });

      // Reset input value so same file can be selected again
      e.target.value = "";
    }
  };

  const handleCameraCapture = (file: File) => {
    void persistCameraImage(file);
    addCapturedImage(file, "camera");
  };

  const discardImages = (images: CapturedImage[]) => {
    for (const img of images) {
      removedIdsRef.current.add(img.id);
      releasePreview(img.preview);
    }
    void removePhotos(images.map((img) => img.id)).catch(() => {});
  };

  const removeImage = (imageId: string) => {
    const target = capturedImages.find((img) => img.id === imageId);
    if (target) discardImages([target]);
    setCapturedImages((prev) => prev.filter((img) => img.id !== imageId));
  };

  const clearAllImages = () => {
    discardImages(capturedImages);
    setCapturedImages([]);
  };

  // Keep persisted drafts' names in sync so edits survive a refresh.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const img of capturedImages) {
        if (img.preparing) continue;
        void updatePhoto(
          img.id,
          { nameStem: img.nameStem, nameLocked: img.nameLocked },
          false,
        ).catch(() => {});
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [capturedImages]);

  const updateImageStem = (imageId: string, value: string) => {
    setCapturedImages((prev) =>
      prev.map((img) =>
        img.id === imageId ? { ...img, nameStem: value, nameLocked: true } : img,
      ),
    );
  };

  const commitImageStem = (imageId: string) => {
    setCapturedImages((prev) =>
      prev.map((img) =>
        img.id === imageId ? { ...img, nameStem: sanitizePath(img.nameStem) } : img,
      ),
    );
  };

  useEffect(() => {
    setCapturedImages((prev) => {
      let changed = false;
      const next = prev.map((img) => {
        if (img.nameLocked) return img;
        const nameStem = buildDefaultStem(partNumber, rev, img.capturedAt);
        if (nameStem === img.nameStem) return img;
        changed = true;
        return { ...img, nameStem };
      });
      return changed ? next : prev;
    });
  }, [partNumber, rev]);

  const generateFilename = (stem: string, fileExtensionName: string) => {
    return `${sanitizePath(stem)}.${fileExtensionName}`;
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
    trackFeature("imageflow.save_local", "Save photos locally");
    const sanitizedCustomerName = sanitizePath(customerName);
    const stems = uniquifyStems(capturedImages);
    
    try {
      if ('showDirectoryPicker' in window) {
        const directoryHandle = await (window as any).showDirectoryPicker();
        const folderHandle = await directoryHandle.getDirectoryHandle(dept, { create: true })
          .then((h: any) => h.getDirectoryHandle(sanitizedCustomerName, { create: true }))
          .then((h: any) => h.getDirectoryHandle(workOrderNumber, { create: true }));
        
        for (const image of capturedImages) {
          const data = image.original ?? image.blob;
          if (!data) continue;
          const ext = image.original ? fileExtension(image.original) : image.ext;
          const fileHandle = await folderHandle.getFileHandle(
            generateFilename(stems[image.id], ext),
            { create: true },
          );
          const writable = await fileHandle.createWritable();
          await writable.write(data);
          await writable.close();
        }
        
        toast({
          title: "Saved Successfully",
          description: `${capturedImages.length} image(s) saved to ${dept}/${sanitizedCustomerName}/${workOrderNumber}/`,
        });
      } else {
        for (const image of capturedImages) {
          const data = image.original ?? image.blob;
          if (!data) continue;
          const ext = image.original ? fileExtension(image.original) : image.ext;
          const url = URL.createObjectURL(data);
          const a = Object.assign(document.createElement('a'), {
            href: url,
            download: generateFilename(stems[image.id], ext)
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
      
      clearAllImages();
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

    if (capturedImages.some((img) => img.preparing || !img.blob)) {
      toast({
        title: "Still preparing photos",
        description: "Wait a moment for the photos to finish processing, then tap Upload again.",
      });
      return;
    }

    setIsUploadingSharePoint(true);
    trackFeature("imageflow.upload.sharepoint", "Upload to SharePoint");

    try {
      const stems = uniquifyStems(capturedImages);
      const records = capturedImages.map((img) =>
        capturedToRecord(img, "queued", {
          dept,
          customerName,
          workOrderNumber,
          partNumber,
          rev: rev || "",
          imageName: stems[img.id],
        }),
      );
      await enqueuePhotos(records);

      const count = capturedImages.length;
      for (const img of capturedImages) releasePreview(img.preview);
      setCapturedImages([]);

      toast({
        title: `${count} photo${count === 1 ? "" : "s"} queued`,
        description: navigator.onLine
          ? "Sending now — keep this page open until the Upload Queue shows \"Sent to server\" (a few seconds). You can start the next work order."
          : "You're offline. Photos are saved on this device and will upload automatically when the connection returns.",
      });
      setSharePointSuccess(true);
      setTimeout(() => setSharePointSuccess(false), 2000);
    } catch (error: any) {
      console.error("Queue upload error:", error);
      toast({
        title: "Could not queue photos",
        description:
          error?.message ||
          "Device storage is unavailable. Try again, or use Save Locally as a backup.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingSharePoint(false);
    }
  };

  // Refresh history when queued photos land in SharePoint.
  const queueItems = useUploadQueue();
  const doneCount = queueItems.filter((p) => p.status === "done").length;
  useEffect(() => {
    if (doneCount > 0) queryClient.invalidateQueries({ queryKey: ["upload-history"] });
  }, [doneCount, queryClient]);

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
        // Soft refresh only — full page reload re-runs the SSO gate and can bounce users to login.
        await queryClient.invalidateQueries();
        await refetchWorkOrders();
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
              onClick={() => {
                trackFeature("imageflow.excel.check_updates", "Check for work-order updates");
                void handleCheckUpdates(false);
              }}
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
              onClick={async () => {
                // Soft refresh keeps the SSO session cookie; window.location.reload()
                // remounts AuthGate and can redirect users back to ACE SSO login.
                try {
                  await queryClient.invalidateQueries();
                  await refetchWorkOrders();
                  toast({
                    title: "Page refreshed",
                    description: "Work orders and data have been updated.",
                  });
                } catch (error: any) {
                  toast({
                    title: "Refresh failed",
                    description: error?.message || "Could not refresh page data.",
                    variant: "destructive",
                  });
                }
              }}
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
                    onClick={() => {
                      trackFeature("imageflow.camera.open", "Open camera");
                      setShowCustomCamera(true);
                    }}
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
                  onClick={clearAllImages}
                  disabled={isUploadingSharePoint}
                  data-testid="button-clear-all-images"
                >
                  Clear All
                </Button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {capturedImages.map((image, index) => (
                  <div key={image.id} className="relative group space-y-2">
                    <div className="relative aspect-square bg-muted rounded-lg overflow-hidden">
                      {image.preview ? (
                        <img src={image.preview} alt={`Captured ${index + 1}`} className="w-full h-full object-cover" />
                      ) : null}
                      {image.preparing ? (
                        <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Preparing
                        </div>
                      ) : null}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => removeImage(image.id)}
                          disabled={isUploadingSharePoint}
                          data-testid={`button-remove-image-${index}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor={`image-name-${image.id}`}
                        className="text-sm font-medium"
                      >
                        SharePoint name
                      </Label>
                      <div className="flex items-center gap-1.5">
                        <Input
                          id={`image-name-${image.id}`}
                          className="h-11 min-h-11 text-base md:text-base"
                          value={image.nameStem}
                          onChange={(e) => updateImageStem(image.id, e.target.value)}
                          onBlur={() => commitImageStem(image.id)}
                          disabled={isUploadingSharePoint}
                          autoComplete="off"
                          data-testid={`input-image-name-${index}`}
                        />
                        <span className="text-sm text-muted-foreground shrink-0">
                          .{image.ext}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {(image.sizeBytes / 1024).toFixed(1)} KB
                      {image.preparing ? "" : " · saved on device"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}

        <UploadQueuePanel />

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
              clearAllImages();
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
              Queuing...
            </>
          ) : sharePointSuccess ? (
            <>
              <CheckCircle2 className="w-5 h-5 mr-2" />
              Queued!
            </>
          ) : (
            <>
              <Upload className="w-5 h-5 mr-2" />
              Upload to SharePoint
            </>
          )}
        </Button>
      </form>
      
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
