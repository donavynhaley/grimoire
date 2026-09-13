import { useRef } from "react";

export function MediaPicker({
  onFiles,
  label = "Add image or video",
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        disabled={disabled}
        aria-label={label}
        className="text-button notes-add-image"
        onClick={() => input.current?.click()}
        type="button"
      >
        <span aria-hidden="true">+</span> image/video
      </button>
      <input
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,.png,.jpg,.jpeg,.webp,.gif,.mp4"
        aria-hidden="true"
        className="sr-only"
        multiple
        ref={input}
        tabIndex={-1}
        type="file"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
