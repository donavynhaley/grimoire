import { useEffect, useState } from "react";
import type { PageAttachment } from "../../shared/attachments";
import { attachments } from "../api/client";
import { useSlowWait } from "../hooks/use-slow-wait";

/** Evidence has its own records, so receiving a file never changes a writer's notes. */
export function PageAttachments({ pageId, revision }: { pageId: string; revision: number }) {
  const [loaded, setLoaded] = useState<{ pageId: string; files: PageAttachment[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const files = loaded?.pageId === pageId ? loaded.files : null;
  const waiting = useSlowWait(files === null && failed !== pageId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and reloads invalidate the list after a live update or an explicit retry
  useEffect(() => {
    let alive = true;
    attachments(pageId)
      .then((result) => {
        if (alive) {
          setLoaded({ pageId, files: result.attachments });
          setFailed(null);
        }
      })
      .catch(() => {
        if (alive) setFailed(pageId);
      });
    return () => {
      alive = false;
    };
  }, [pageId, revision, reloads]);

  return (
    <section aria-label="Attachments" className="page-attachments">
      {failed === pageId && (
        <div role="alert">
          Attachments could not be loaded.{" "}
          <button className="text-button" onClick={() => setReloads((count) => count + 1)} type="button">
            Try again
          </button>
        </div>
      )}
      {waiting && <p role="status">Loading attachments...</p>}
      {files?.length === 0 && <p className="empty-note">No attachments yet.</p>}
      {files?.map((file) => (
        <figure className="page-attachment" key={file.id}>
          {file.mediaType === "video/mp4" ? (
            // User-provided evidence has no separate caption track. Native controls expose
            // pause, volume, seeking, and fullscreen without autoplaying a recording.
            // biome-ignore lint/a11y/useMediaCaption: recordings are user-provided evidence; no transcript was supplied
            <video aria-label={file.filename} controls playsInline preload="metadata" src={file.reference} />
          ) : (
            <a aria-label={`Open ${file.filename}`} href={file.reference} rel="noreferrer" target="_blank">
              <img alt={file.filename} loading="lazy" src={file.reference} />
            </a>
          )}
          <figcaption>
            <span className="attachment-filename">{file.filename}</span>
            <div className="attachment-actions">
              <span>
                {file.size < 1_000_000
                  ? `${Math.max(1, Math.round(file.size / 1000))} KB`
                  : `${(file.size / 1_000_000).toFixed(1)} MB`}
              </span>
              <a
                aria-label={`Download ${file.filename}`}
                download={file.filename}
                href={`${file.reference}&download=1`}
              >
                Download
              </a>
            </div>
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
