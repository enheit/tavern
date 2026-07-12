import { ImageIcon } from "lucide-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { m } from "@/paraglide/messages.js";
import { firstImageFile, firstImageUrl } from "./uploadChatImage";
import { useChatImageUpload } from "./useChatImageUpload";

// During dragenter/over the actual data is unreadable (browser security) — decide droppability from the
// advertised `types`: file bytes ("Files") or a URL ("text/uri-list").
function isImageDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.some((t) => t === "Files" || t === "text/uri-list");
}

// § chat image paste (drag path): a drop target wrapping the whole chat pane (message list + composer)
// so a member can drag an image into ANY part of the chat to send it — from Finder/Explorer OR from a
// separate browser window. A drag that delivers file bytes takes the byte-upload path; one that carries
// only a URL takes the Worker's from-url ingest (never a browser cross-origin fetch → no CORS). A
// dragenter/leave depth counter keeps the overlay from flickering as the pointer crosses child nodes.
export function ChatDropZone({ serverId, children }: { serverId: string; children: ReactNode }) {
  const { sendFile, sendUrl } = useChatImageUpload(serverId);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  function onDragEnter(e: DragEvent): void {
    if (!isImageDrag(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: DragEvent): void {
    if (!isImageDrag(e)) return;
    // preventDefault marks this a valid drop target (else the browser rejects the drop / navigates).
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: DragEvent): void {
    if (!isImageDrag(e)) return;
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setDragging(false);
    }
  }
  function onDrop(e: DragEvent): void {
    if (!isImageDrag(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    // Read the transfer SYNCHRONOUSLY (it's only valid during dispatch): bytes first, then a URL.
    const file = firstImageFile(e.dataTransfer);
    if (file) {
      sendFile(file);
      return;
    }
    const url = firstImageUrl(e.dataTransfer);
    if (url) sendUrl(url);
  }

  return (
    <div
      data-testid="chat-dropzone"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {children}
      {dragging ? (
        <div
          data-testid="chat-drop-overlay"
          className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-background/80 text-primary backdrop-blur-sm"
        >
          <ImageIcon className="size-8" />
          <p className="text-sm font-medium">{m.chat_image_drop_hint()}</p>
        </div>
      ) : null}
    </div>
  );
}
