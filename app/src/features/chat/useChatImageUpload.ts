import type { ImageAttachment } from "@tavern/shared";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { uploadChatImage, uploadChatImageFromUrl } from "./uploadChatImage";

// Shared "upload an image and send it as a chat message" used by BOTH the composer paste handler and
// the chat drop zone. One in-flight guard per hook instance so a second image while one is uploading is
// ignored (rather than racing two uploads); `uploading` drives the caller's spinner/overlay. The send
// goes straight through the room store so this stays independent of the composer's local text state.
export function useChatImageUpload(serverId: string): {
  uploading: boolean;
  sendFile: (file: Blob) => void;
  sendUrl: (url: string) => void;
} {
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(
    (task: () => Promise<ImageAttachment>): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      setUploading(true);
      void task()
        .then((image) => {
          roomStore(serverId).getState().sendMessage("", undefined, image);
        })
        .catch(() => toast.error(m.chat_image_upload_failed()))
        .finally(() => {
          inFlight.current = false;
          setUploading(false);
        });
    },
    [serverId],
  );

  const sendFile = useCallback(
    (file: Blob): void => run(() => uploadChatImage(serverId, file)),
    [run, serverId],
  );

  // A `data:` URL already carries the bytes inline — decode it locally and take the byte path (no
  // server fetch). An http(s) URL goes to the Worker's from-url ingest (server-side fetch, no CORS).
  const sendUrl = useCallback(
    (url: string): void =>
      run(async () => {
        if (url.startsWith("data:")) {
          const blob = await (await fetch(url)).blob();
          return uploadChatImage(serverId, blob);
        }
        return uploadChatImageFromUrl(serverId, url);
      }),
    [run, serverId],
  );

  return { uploading, sendFile, sendUrl };
}
