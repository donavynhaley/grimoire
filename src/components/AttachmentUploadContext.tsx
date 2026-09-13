import { createContext } from "react";
import type { uploadPageAttachment } from "../api/client";

/** App owns writes; the page owns the queue, progress, and retry controls. */
export const AttachmentUploadContext = createContext<typeof uploadPageAttachment | null>(null);
