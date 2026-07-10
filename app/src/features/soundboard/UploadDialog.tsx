import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LIMITS, Sound } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages.js";

// The name form reuses the shared Sound schema's `name` constraint (1..32) via `.pick` — no zod is
// imported into the app and shared/api.ts stays untouched.
const NameForm = Sound.pick({ name: true });
type NameFormValues = { name: string };

// Default duration seam (FR-34 client-side check): decode the mp3 and read its duration. Injectable so
// tests stub it without a large fixture. Never runs when a stub is supplied.
async function decodeDurationMs(file: File): Promise<number> {
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return Math.round(buffer.duration * 1000);
  } finally {
    void ctx.close();
  }
}

interface UploadDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onUpload(input: { file: File; name: string; durationMs: number }): Promise<unknown>;
  measureDurationMs?: (file: File) => Promise<number>;
}

// FR-34 upload dialog: pick an mp3, name it (1..32), client-side reject clips over the max duration,
// then hand the file + name + measured duration to `onUpload` (SoundboardPanel wires useSounds).
export function UploadDialog({
  open,
  onOpenChange,
  onUpload,
  measureDurationMs = decodeDurationMs,
}: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [tooLong, setTooLong] = useState(false);
  const [missingFile, setMissingFile] = useState(false);
  const form = useForm<NameFormValues>({
    resolver: zodResolver(NameForm),
    defaultValues: { name: "" },
  });

  const onSubmit = form.handleSubmit(async ({ name }) => {
    setTooLong(false);
    setMissingFile(false);
    if (file === null) {
      setMissingFile(true);
      return;
    }
    const durationMs = await measureDurationMs(file);
    if (durationMs > LIMITS.soundMaxDurationMs) {
      setTooLong(true);
      return;
    }
    await onUpload({ file, name, durationMs });
    form.reset();
    setFile(null);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.soundboard_upload_title()}</DialogTitle>
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-file">{m.soundboard_upload_file()}</Label>
            <Input
              id="upload-file"
              data-testid="upload-file"
              type="file"
              accept="audio/mpeg"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setMissingFile(false);
              }}
            />
            {missingFile && (
              <p role="alert" data-testid="upload-file-error" className="text-sm text-destructive">
                {m.soundboard_upload_file_required()}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-name">{m.soundboard_upload_name()}</Label>
            <Input
              {...form.register("name")}
              id="upload-name"
              data-testid="upload-name"
              autoComplete="off"
            />
            {form.formState.errors.name !== undefined && (
              <p role="alert" data-testid="upload-name-error" className="text-sm text-destructive">
                {m.soundboard_upload_name_invalid()}
              </p>
            )}
          </div>
          {tooLong && (
            <p role="alert" data-testid="upload-error" className="text-sm text-destructive">
              {m.soundboard_upload_too_long()}
            </p>
          )}
          <Button type="submit" data-testid="upload-submit">
            {m.soundboard_upload_submit()}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
