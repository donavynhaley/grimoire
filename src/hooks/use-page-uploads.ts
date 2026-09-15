import { useContext, useEffect, useMemo, useState } from "react";
import type { PageAttachment } from "../../shared/attachments";
import { ApiError } from "../api/client";
import type { UploadProgress } from "../api/upload-attachment";
import { AttachmentUploadContext } from "../components/AttachmentUploadContext";

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
};

export function usePageUploads(pageId: string) {
  const upload = useContext(AttachmentUploadContext);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a page owns its queue, even when the same dialog instance opens another page
  const session = useMemo(
    () => ({ jobs: [] as UploadItem[], controller: new AbortController(), running: false, nextId: 0 }),
    [pageId],
  );
  const [snapshot, setSnapshot] = useState({ session, jobs: session.jobs });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    session.controller = new AbortController();
    const controller = session.controller;
    return () => controller.abort();
  }, [session]);
  const publish = () => setSnapshot({ session, jobs: session.jobs.map((job) => ({ ...job })) });
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
          setRevision((value) => value + 1);
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
    items: snapshot.session === session ? snapshot.jobs : [],
    revision,
    add(
      files: File[],
      callbacks?: {
        complete: (index: number, attachment: PageAttachment) => void;
        dismiss: (index: number) => void;
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
          onDismiss: callbacks ? () => callbacks.dismiss(index) : undefined,
        });
      publish();
      void drain();
    },
    retry(id: string) {
      const job = session.jobs.find((item) => item.id === id);
      if (job?.state !== "failed") return;
      job.state = "queued";
      job.error = undefined;
      publish();
      void drain();
    },
    dismiss(id: string) {
      const job = session.jobs.find((item) => item.id === id);
      if (job && ["complete", "failed"].includes(job.state)) job.onDismiss?.();
      session.jobs = session.jobs.filter(
        (item) => item.id !== id || !["complete", "failed"].includes(item.state),
      );
      publish();
    },
  };
}
