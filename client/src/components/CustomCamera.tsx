import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Camera, X } from "lucide-react";
import { Card } from "@/components/ui/card";

interface CustomCameraProps {
  onCapture: (file: File) => void;
  onClose: () => void;
}

export default function CustomCamera({ onCapture, onClose }: CustomCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureCancelledRef = useRef<boolean>(false);
  const metadataListenerPendingRef = useRef<boolean>(false);
  
  const [zoom, setZoom] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [hasZoomSupport, setHasZoomSupport] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment", // Use back camera
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });

      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Check if zoom is supported
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack.getCapabilities() as any;
      
      if (capabilities.zoom) {
        setHasZoomSupport(true);
        const settings = videoTrack.getSettings() as any;
        if (settings.zoom) {
          setZoom(settings.zoom);
        }
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
      alert("Could not access camera. Please check permissions.");
      onClose();
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const handleZoomChange = async (value: number) => {
    setZoom(value);
    
    if (streamRef.current && hasZoomSupport) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      const capabilities = videoTrack.getCapabilities() as any;
      
      if (capabilities.zoom) {
        try {
          await videoTrack.applyConstraints({
            advanced: [{ zoom: value } as any]
          });
        } catch (error) {
          console.error("Error applying zoom:", error);
        }
      }
    }
  };

  const capturePhoto = async () => {
    if (!streamRef.current || !canvasRef.current) return;

    // Reset capture cancelled flag at start of new capture
    captureCancelledRef.current = false;

    const track = streamRef.current.getVideoTracks()[0];
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    
    if (!context) return;

    // Helper to set capture result, checking if cancelled
    const setCaptureResult = (imageUrl: string, file: File) => {
      if (captureCancelledRef.current) {
        console.log("Capture was cancelled, ignoring late result");
        URL.revokeObjectURL(imageUrl);
        return;
      }
      setCapturedImage(imageUrl);
      setCapturedFile(file);
    };

    // Helper function for canvas-based capture (fallback)
    const captureViaCanvas = () => {
      if (!videoRef.current) return;
      
      const video = videoRef.current;
      
      // Ensure video dimensions are ready
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        // Prevent multiple listeners from stacking
        if (metadataListenerPendingRef.current) {
          console.log("Already waiting for video metadata...");
          return;
        }
        console.log("Video dimensions not ready, waiting...");
        metadataListenerPendingRef.current = true;
        video.addEventListener('loadedmetadata', () => {
          metadataListenerPendingRef.current = false;
          captureViaCanvas();
        }, { once: true });
        return;
      }
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.filter = `brightness(${brightness}%)`;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Reset filter after draw
      context.filter = 'none';

      canvas.toBlob((blob) => {
        if (blob) {
          const timestamp = Date.now();
          const file = new File([blob], `photo-${timestamp}.jpg`, {
            type: "image/jpeg",
          });
          const imageUrl = URL.createObjectURL(blob);
          setCaptureResult(imageUrl, file);
          console.log("Photo captured using canvas fallback");
        }
      }, "image/jpeg", 1.0); // Max quality for fallback too
    };

    // Helper to wrap a promise with a timeout, marks capture as cancelled on timeout
    const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: () => void): Promise<T> => {
      return new Promise((resolve, reject) => {
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          // Mark ImageCapture path as cancelled so late results are ignored
          captureCancelledRef.current = true;
          reject(new Error("Operation timeout"));
          fallback();
        }, ms);
        
        promise
          .then((result) => {
            clearTimeout(timeout);
            // If we already timed out and triggered fallback, ignore this late result
            if (timedOut) {
              console.log("Ignoring late ImageCapture result after timeout");
              return;
            }
            resolve(result);
          })
          .catch((error) => {
            clearTimeout(timeout);
            if (!timedOut) {
              reject(error);
            }
          });
      });
    };

    // Helper to apply brightness to blob via canvas with timeout and error handling
    const applyBrightnessToBlob = (blob: Blob): Promise<{ file: File; previewUrl: string }> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const imageUrl = URL.createObjectURL(blob);
        
        // Timeout after 5 seconds
        const timeout = setTimeout(() => {
          URL.revokeObjectURL(imageUrl);
          reject(new Error("Image decode timeout"));
        }, 5000);
        
        img.onload = () => {
          clearTimeout(timeout);
          canvas.width = img.width;
          canvas.height = img.height;
          context.filter = `brightness(${brightness}%)`;
          context.drawImage(img, 0, 0);
          // Reset filter after draw
          context.filter = 'none';
          URL.revokeObjectURL(imageUrl);
          
          canvas.toBlob((adjustedBlob) => {
            if (adjustedBlob) {
              const timestamp = Date.now();
              const file = new File([adjustedBlob], `photo-${timestamp}.jpg`, {
                type: "image/jpeg",
              });
              // Create preview URL directly from the blob, no re-encoding
              const previewUrl = URL.createObjectURL(adjustedBlob);
              resolve({ file, previewUrl });
            } else {
              reject(new Error("Canvas toBlob failed"));
            }
          }, "image/jpeg", 1.0);
        };
        
        img.onerror = () => {
          clearTimeout(timeout);
          URL.revokeObjectURL(imageUrl);
          reject(new Error("Image decode failed"));
        };
        
        img.src = imageUrl;
      });
    };

    try {
      // Check if Image Capture API is available and track is live
      if ('ImageCapture' in window && track && track.readyState === 'live' && track.enabled) {
        const imageCapture = new (window as any).ImageCapture(track);
        
        // Settings optimized for sharp document/label photos
        let photoSettings: any = {
          imageQuality: 1.0 // No compression - maximum quality
        };
        
        try {
          const capabilities = await imageCapture.getPhotoCapabilities();
          
          // Use flash mode to flatten shadows on labels/documents
          if (capabilities.fillLightMode && capabilities.fillLightMode.includes('flash')) {
            photoSettings.fillLightMode = 'flash';
          } else if (capabilities.fillLightMode && capabilities.fillLightMode.includes('auto')) {
            photoSettings.fillLightMode = 'auto';
          }
          
          // Add slight exposure compensation to keep paper white without losing ink detail
          if (capabilities.exposureCompensation) {
            const expRange = capabilities.exposureCompensation;
            // Target +0.5 EV, but clamp to device's supported range
            const targetExp = 0.5;
            if (expRange.min !== undefined && expRange.max !== undefined) {
              photoSettings.exposureCompensation = Math.min(Math.max(targetExp, expRange.min), expRange.max);
            }
          }
        } catch (e) {
          console.log("Could not get photo capabilities, using defaults");
        }
        
        // Take high-quality photo from camera sensor with 10 second timeout
        const blob = await withTimeout<Blob>(
          imageCapture.takePhoto(photoSettings),
          10000,
          captureViaCanvas
        );
        
        // Check if capture was cancelled (timeout triggered fallback)
        if (captureCancelledRef.current) {
          console.log("ImageCapture succeeded but capture was cancelled, ignoring");
          return;
        }
        
        // Apply brightness adjustment if needed
        if (brightness !== 100) {
          try {
            const { file, previewUrl } = await applyBrightnessToBlob(blob);
            setCaptureResult(previewUrl, file);
          } catch (brightnessError) {
            // Brightness adjustment failed, use original blob without adjustment
            console.log("Brightness adjustment failed, using original:", brightnessError);
            const timestamp = Date.now();
            const file = new File([blob], `photo-${timestamp}.jpg`, {
              type: "image/jpeg",
            });
            const previewUrl = URL.createObjectURL(blob);
            setCaptureResult(previewUrl, file);
          }
        } else {
          // No brightness adjustment needed, use original high-quality blob
          const timestamp = Date.now();
          const file = new File([blob], `photo-${timestamp}.jpg`, {
            type: "image/jpeg",
          });
          const previewUrl = URL.createObjectURL(blob);
          setCaptureResult(previewUrl, file);
        }
        
        console.log("Photo captured using Image Capture API (high quality)");
        return;
      }
    } catch (error) {
      console.log("Image Capture API failed, falling back to canvas:", error);
    }

    // Fallback: Canvas-based capture for browsers without Image Capture support
    captureViaCanvas();
  };

  const handleUsePhoto = () => {
    if (capturedFile) {
      stopCamera();
      onCapture(capturedFile);
      onClose();
    }
  };

  const handleRetake = () => {
    if (capturedImage) {
      URL.revokeObjectURL(capturedImage);
    }
    setCapturedImage(null);
    setCapturedFile(null);
    // Restart camera for retake
    startCamera();
  };

  // Show photo confirmation screen if photo was captured
  if (capturedImage) {
    return (
      <div className="fixed top-0 left-0 right-0 bottom-0 z-[9999] bg-black w-screen" style={{ height: '100dvh' }}>
        {/* Header */}
        <div className="absolute top-0 left-0 right-0 z-10 p-4 bg-black/80 flex justify-between items-center h-16">
          <h2 className="text-white text-xl font-semibold">Photo Preview</h2>
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/20"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            data-testid="button-close-camera"
          >
            <X className="w-6 h-6" />
          </Button>
        </div>

        {/* Photo Preview - Calculated to fit between header and buttons */}
        <div 
          className="absolute left-0 right-0 flex items-center justify-center overflow-hidden px-4"
          style={{ 
            top: '64px', 
            bottom: '100px'
          }}
        >
          <img
            src={capturedImage}
            alt="Captured"
            style={{ 
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
              objectFit: 'contain'
            }}
          />
        </div>

        {/* Action Buttons - Fixed at bottom with safe area */}
        <div 
          className="absolute left-0 right-0 z-10 bg-black/90 flex gap-4 justify-center"
          style={{
            bottom: '0',
            paddingTop: '20px',
            paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
            paddingLeft: '24px',
            paddingRight: '24px'
          }}
        >
          <Button
            size="lg"
            variant="outline"
            className="min-h-14 px-8 text-lg bg-white/10 text-white border-white/40 hover:bg-white/20"
            onClick={handleRetake}
            data-testid="button-retake-photo"
          >
            Cancel
          </Button>
          <Button
            size="lg"
            className="min-h-14 px-8 text-lg bg-blue-600 hover:bg-blue-700 text-white"
            onClick={handleUsePhoto}
            data-testid="button-use-photo"
          >
            Use this Photo
          </Button>
        </div>
      </div>
    );
  }

  // Show camera view
  return (
    <div className="fixed inset-0 z-[9999] bg-black">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 p-4 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex justify-between items-center">
          <h2 className="text-white text-xl font-semibold">Camera</h2>
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/20"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            data-testid="button-close-camera"
          >
            <X className="w-6 h-6" />
          </Button>
        </div>
      </div>

      {/* Camera Preview */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
        style={{
          filter: `brightness(${brightness}%)`
        }}
      />

      {/* Hidden canvas for capturing */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Zoom Control - Vertical on Right Side (positioned higher to avoid overlap in landscape) */}
      <div className="absolute right-3 top-16 z-20">
        <div className="bg-black/90 rounded-lg p-4 border-4 border-white/60 shadow-lg">
          <div className="flex flex-col items-center gap-2">
            <span className="text-white text-sm font-bold">Zoom</span>
            <div className="flex flex-col items-center gap-1">
              <span className="text-white text-xs font-bold">3x</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.1"
                value={zoom}
                onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
                className="h-32 landscape:h-24 cursor-pointer"
                style={{
                  WebkitAppearance: 'slider-vertical',
                  width: '28px',
                  accentColor: 'white'
                } as React.CSSProperties}
                data-testid="slider-zoom"
              />
              <span className="text-white text-xs font-bold">1x</span>
            </div>
            <span className="text-white text-lg font-bold">{zoom.toFixed(1)}x</span>
          </div>
        </div>
      </div>

      {/* Brightness Control - Horizontal at Bottom (closer to capture button) */}
      <div className="absolute bottom-24 left-4 right-4 z-20">
        <div className="bg-black/90 rounded-lg p-4 border-4 border-white/60 shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-white text-sm font-bold whitespace-nowrap">Brightness</span>
            <input
              type="range"
              min="50"
              max="250"
              step="5"
              value={brightness}
              onChange={(e) => setBrightness(parseInt(e.target.value))}
              className="flex-1 h-8 cursor-pointer"
              style={{
                accentColor: 'white'
              }}
              data-testid="slider-brightness"
            />
            <span className="text-white text-base font-bold w-16 text-right">{brightness}%</span>
          </div>
        </div>
      </div>

      {/* Capture Button */}
      <div className="absolute bottom-0 left-0 right-0 z-10 p-6 bg-gradient-to-t from-black/80 to-transparent">
        <div className="flex justify-center">
          <Button
            size="lg"
            className="w-20 h-20 rounded-full bg-white hover:bg-gray-200 text-black border-4 border-gray-300"
            onClick={capturePhoto}
            data-testid="button-capture-photo"
          >
            <Camera className="w-8 h-8" />
          </Button>
        </div>
      </div>
    </div>
  );
}
