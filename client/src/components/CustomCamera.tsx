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
  
  const [zoom, setZoom] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [hasZoomSupport, setHasZoomSupport] = useState(false);

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

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    if (!context) return;

    // Set canvas size to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Apply brightness filter
    context.filter = `brightness(${brightness}%)`;
    
    // Draw video frame to canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert canvas to blob
    canvas.toBlob((blob) => {
      if (blob) {
        const timestamp = Date.now();
        const file = new File([blob], `photo-${timestamp}.jpg`, {
          type: "image/jpeg",
        });
        
        stopCamera();
        onCapture(file);
        onClose();
      }
    }, "image/jpeg", 0.95);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black">
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

      {/* Zoom Control - Vertical on Right Side */}
      <div className="absolute right-2 top-1/4 z-20">
        <div className="bg-black/80 rounded-lg p-4 border-2 border-white/40">
          <div className="flex flex-col items-center gap-2">
            <span className="text-white text-sm font-bold">Zoom</span>
            <div className="flex flex-col items-center gap-1">
              <span className="text-white text-xs">3x</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.1"
                value={zoom}
                onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
                className="h-48 cursor-pointer"
                style={{
                  WebkitAppearance: 'slider-vertical',
                  width: '30px'
                } as React.CSSProperties}
                data-testid="slider-zoom"
              />
              <span className="text-white text-xs">1x</span>
            </div>
            <span className="text-white text-base font-bold">{zoom.toFixed(1)}x</span>
          </div>
        </div>
      </div>

      {/* Brightness Control - Horizontal at Bottom */}
      <div className="absolute bottom-28 left-4 right-4 z-20">
        <div className="bg-black/80 rounded-lg p-4 border-2 border-white/40">
          <div className="flex items-center gap-3">
            <span className="text-white text-sm font-bold whitespace-nowrap">Brightness</span>
            <input
              type="range"
              min="50"
              max="150"
              step="5"
              value={brightness}
              onChange={(e) => setBrightness(parseInt(e.target.value))}
              className="flex-1 h-8 cursor-pointer"
              data-testid="slider-brightness"
            />
            <span className="text-white text-base font-bold w-14 text-right">{brightness}%</span>
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
