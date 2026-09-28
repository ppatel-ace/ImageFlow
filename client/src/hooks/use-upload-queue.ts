import { useEffect, useState } from "react";
import { listPhotos, subscribeQueue, type QueuedPhoto } from "@/lib/uploadQueue";

/** Live view of queued (non-draft) photos from IndexedDB. */
export function useUploadQueue(): QueuedPhoto[] {
  const [items, setItems] = useState<QueuedPhoto[]>([]);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        listPhotos()
          .then((all) => {
            if (!cancelled) setItems(all.filter((p) => p.status !== "draft"));
          })
          .catch(() => {});
      }, 50);
    };
    refresh();
    const unsubscribe = subscribeQueue(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return items;
}
