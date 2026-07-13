import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmojiPicker } from "@/components/ui/emoji-picker";

describe("EmojiPicker", () => {
  it("fills the width of its popover container", () => {
    const { container } = render(
      <EmojiPicker>
        <div />
      </EmojiPicker>,
    );

    const picker = container.querySelector('[data-slot="emoji-picker"]');
    if (!(picker instanceof HTMLElement)) throw new Error("Emoji picker root was not rendered");
    expect(picker.classList.contains("w-full")).toBe(true);
    expect(picker.classList.contains("w-fit")).toBe(false);
  });
});
