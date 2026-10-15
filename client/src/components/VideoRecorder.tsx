import { useEffect, useRef, useState } from "react";
import { Check, Circle, RotateCcw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export const MAX_VIDEO_SECONDS = 120;
const VIDEO_BITS_PER_SECOND = 2_500_000;

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export function canRecordInApp(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    pickMimeType() !== ""
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

interface VideoRecorderProps {
  onCapture: (file: File) => void;
  onClose: () => void;
}

export default function VideoRecorder({ onCapture, onClose }: VideoRecorderProps) {
  const { toast } = useToast();
  const liveRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [clip, setClip] = useState<File | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startStream = async () => {
    const video = { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      }
      streamRef.current = stream;
      if (liveRef.current) liveRef.current.srcObject = stream;
    } catch (err) {
      console.error("Error accessing camera:", err);
      toast({
        title: "Camera unavailable",
        description: "Could not access the camera. Please check permissions.",
        variant: "destructive",
      });
      onClose();
    }
  };

  useEffect(() => {
    void startStream();
    return () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!clipUrl) return;
    return () => URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_VIDEO_SECONDS) stopRecording();
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
    } catch (err) {
      toast({
        title: "Video recording isn't supported here",
        description: (err as Error).message,
        variant: "destructive",
      });
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const type = (recorder.mimeType || mimeType).split(";")[0] || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const file = new File(chunksRef.current, `video.${ext}`, { type });
      chunksRef.current = [];
      // The live camera isn't needed on the preview screen; releasing it saves memory on tablets.
      stopStream();
      if (file.size === 0) {
        toast({ title: "Nothing was recorded — try again", variant: "destructive" });
        void startStream();
        return;
      }
      setClip(file);
      setClipUrl(URL.createObjectURL(file));
    };
    recorderRef.current = recorder;
    recorder.start(1000);
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
  };

  function stopRecording() {
    setRecording(false);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  const retake = () => {
    setClip(null);
    setClipUrl(null);
    setElapsed(0);
    void startStream();
  };

  const useClip = () => {
    if (!clip) return;
    onCapture(clip);
    onClose();
  };

  const remaining = MAX_VIDEO_SECONDS - elapsed;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black text-white" data-testid="video-recorder">
      <div className="flex items-center justify-between p-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/20"
          onClick={() => {
            if (recording) stopRecording();
            onClose();
          }}
          aria-label="Close video recorder"
          data-testid="button-close-video"
        >
          <X className="h-6 w-6" />
        </Button>
        <div className="flex items-center gap-2 font-mono text-lg" data-testid="text-video-timer">
          {recording ? <span className="h-3 w-3 animate-pulse rounded-full bg-red-500" /> : null}
          {clock(elapsed)} / {clock(MAX_VIDEO_SECONDS)}
        </div>
        <div className="w-10" />
      </div>

      <div className="relative flex-1 overflow-hidden">
        {clipUrl ? (
          <video src={clipUrl} controls playsInline className="h-full w-full object-contain" />
        ) : (
          <video ref={liveRef} autoPlay muted playsInline className="h-full w-full object-contain" />
        )}
        {recording && remaining <= 10 ? (
          <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded bg-black/70 px-3 py-1 text-sm">
            Stops in {remaining}s
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-center gap-6 p-6">
        {clip ? (
          <>
            <Button type="button" variant="secondary" size="lg" className="min-h-14" onClick={retake} data-testid="button-video-retake">
              <RotateCcw className="mr-2 h-5 w-5" />
              Retake
            </Button>
            <Button type="button" size="lg" className="min-h-14 bg-green-600 hover:bg-green-700" onClick={useClip} data-testid="button-video-use">
              <Check className="mr-2 h-5 w-5" />
              Use Video
            </Button>
          </>
        ) : recording ? (
          <button
            type="button"
            onClick={stopRecording}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white"
            aria-label="Stop recording"
            data-testid="button-video-stop"
          >
            <Square className="h-8 w-8 fill-red-500 text-red-500" />
          </button>
        ) : (
          <button
            type="button"
            onClick={startRecording}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white"
            aria-label="Start recording"
            data-testid="button-video-record"
          >
            <Circle className="h-14 w-14 fill-red-500 text-red-500" />
          </button>
        )}
      </div>
      <p className="pb-4 text-center text-xs text-white/70">
        Up to {MAX_VIDEO_SECONDS / 60} minutes per clip. Recording stops automatically.
      </p>
    </div>
  );
}
