import { useContext, useEffect, useMemo } from "react";
import type { PageAttachment } from "../../shared/attachments";
import { ApiError } from "../api/client";
import type { UploadProgress } from "../api/upload-attachment";
import { AttachmentUploadContext } from "../components/AttachmentUploadContext";
import type { MediaUploadStatus } from "../lib/media-insertion";

type UploadItem = {
  id: string;
  filename: string;
  file: File | null;
  state: "queued" | "uploading" | "complete" | "failed";
  progress: UploadProgress;
  error?: string;
  retryable?: boolean;
  onComplete?: (attachment: PageAttachment) => void;
  onDismiss?: () => void;
  onUpdate?: (status: MediaUploadStatus) => void;
};

export function usePageUploads(pageId: string) {
  const upload = useContext(AttachmentUploadContext);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a page owns its queue, even when the same dialog instance opens another page
  const session = useMemo(
    () => ({ jobs: [] as UploadItem[], controller: new AbortController(), running: false, nextId: 0 }),
    [pageId],
  );
  useEffect(() => {
    session.controller = new AbortController();
    const controller = session.controller;
    return () => controller.abort();
  }, [session]);
  const publish = () => {
    for (const job of session.jobs) {
      if (job.state === "complete") continue;
      job.onUpdate?.({
        filename: job.filename,
        failed: job.state === "failed",
        message:
          job.state === "failed"
            ? job.error!
            : job.state === "queued"
              ? "Waiting to add to notes"
              : `${job.progress.phase}${job.progress.phase === "Uploading" ? ` ${job.progress.percent}%` : ""} - adding to notes`,
        percent:
          job.state === "uploading" && job.progress.phase === "Uploading" ? job.progress.percent : undefined,
        retry: job.state === "failed" && job.retryable ? () => retry(job.id) : undefined,
        dismiss: job.state === "failed" ? () => dismiss(job.id) : undefined,
      });
    }
  };
  const drain = async () => {
    if (session.running || !upload) return;
    session.running = true;
    const { signal } = session.controller;
    try {
      while (!signal.aborted) {
        const job = session.jobs.find((item) => item.state === "queued" && item.file);
        if (!job?.file) break;
        job.state = "uploading";
        publish();
        try {
          const attachment = await upload(pageId, job.file, signal, (progress) => {
            if (signal.aborted) return;
            job.progress = progress;
            publish();
          });
          if (signal.aborted) return;
          job.onComplete?.(attachment);
          job.state = "complete";
          job.file = null;
        } catch (error) {
          if (signal.aborted) return;
          job.state = "failed";
          job.error = error instanceof Error ? error.message : "Upload failed. Try again.";
          job.retryable =
            !(error instanceof ApiError) || error.status >= 500 || [409, 429].includes(error.status);
        }
        publish();
      }
    } finally {
      session.running = false;
    }
  };
  return {
    available: upload !== null,
    add(
      files: File[],
      callbacks?: {
        complete: (index: number, attachment: PageAttachment) => void;
        dismiss: (index: number) => void;
        update?: (index: number, status: MediaUploadStatus) => void;
      },
    ) {
      for (const [index, file] of files.entries())
        session.jobs.push({
          id: String(session.nextId++),
          filename: file.name,
          file,
          state: "queued",
          progress: { phase: "Preparing", percent: 0 },
          onComplete: callbacks ? (attachment) => callbacks.complete(index, attachment) : undefined,
          onUpdate: callbacks?.update ? (status) => callbacks.update?.(index, status) : undefined,
          onDismiss: callbacks ? () => callbacks.dismiss(index) : undefined,
        });
      publish();
      void drain();
    },
    retry,
    dismiss,
  };

  function retry(id: string): void {
    const job = session.jobs.find((item) => item.id === id);
    if (job?.state !== "failed") return;
    job.state = "queued";
    job.error = undefined;
    publish();
    void drain();
  }
  function dismiss(id: string): void {
    const job = session.jobs.find((item) => item.id === id);
    if (!job || !["complete", "failed"].includes(job.state)) return;
    job.onDismiss?.();
    session.jobs = session.jobs.filter((item) => item.id !== id);
    publish();
  }
}
