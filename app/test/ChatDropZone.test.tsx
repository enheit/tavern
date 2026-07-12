import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the hook's actions so we assert HOW a drop is routed (bytes vs URL) without touching the real
// upload (which needs canvas/fetch). ChatDropZone still runs the real firstImageFile/firstImageUrl
// extractors against the fake DataTransfer, so this exercises the actual routing decision.
const sendFile = vi.fn();
const sendUrl = vi.fn();
vi.mock("@/features/chat/useChatImageUpload", () => ({
  useChatImageUpload: () => ({ uploading: false, sendFile, sendUrl }),
}));

import { ChatDropZone } from "@/features/chat/ChatDropZone";

interface FakeDataTransfer {
  types: string[];
  files: File[];
  items: never[];
  dropEffect: string;
  getData: (type: string) => string;
}

function dt(over: Partial<FakeDataTransfer>): FakeDataTransfer {
  return {
    types: [],
    files: [],
    items: [],
    dropEffect: "",
    getData: () => "",
    ...over,
  };
}

function renderZone() {
  return render(
    <ChatDropZone serverId="s-1">
      <div data-testid="child">chat</div>
    </ChatDropZone>,
  );
}

afterEach(() => {
  cleanup();
  sendFile.mockClear();
  sendUrl.mockClear();
});

describe("ChatDropZone", () => {
  it("shows the drop overlay while an image drag is over the zone", () => {
    renderZone();
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
    fireEvent.dragEnter(screen.getByTestId("chat-dropzone"), {
      dataTransfer: dt({ types: ["Files"] }),
    });
    expect(screen.getByTestId("chat-drop-overlay")).toBeDefined();
  });

  it("routes a dropped image FILE to the byte-upload path", () => {
    renderZone();
    const file = new File([new Uint8Array([1, 2, 3])], "cat.png", { type: "image/png" });
    fireEvent.drop(screen.getByTestId("chat-dropzone"), {
      dataTransfer: dt({ types: ["Files"], files: [file] }),
    });
    expect(sendFile).toHaveBeenCalledWith(file);
    expect(sendUrl).not.toHaveBeenCalled();
  });

  it("routes a URL-only drop (no file bytes) to the from-url path", () => {
    renderZone();
    fireEvent.drop(screen.getByTestId("chat-dropzone"), {
      dataTransfer: dt({
        types: ["text/uri-list"],
        getData: (type) => (type === "text/uri-list" ? "https://cdn.example.com/cat.png" : ""),
      }),
    });
    expect(sendUrl).toHaveBeenCalledWith("https://cdn.example.com/cat.png");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("ignores a drag that carries neither files nor a URL (e.g. dragging text)", () => {
    renderZone();
    fireEvent.drop(screen.getByTestId("chat-dropzone"), {
      dataTransfer: dt({ types: ["text/plain"], getData: () => "just some text" }),
    });
    expect(sendFile).not.toHaveBeenCalled();
    expect(sendUrl).not.toHaveBeenCalled();
  });
});
