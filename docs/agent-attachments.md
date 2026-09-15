# Attaching images and videos

Signed-in project members and write-scoped project tokens can upload PNG, JPEG, WebP, GIF, and MP4 evidence to a page.
Images and recordings can be embedded among the page's notes, where recordings play with native controls, seeking, and fullscreen.
The **Files** tab retains the stored originals and offers **Insert in notes** for evidence uploaded previously.
Attachments retain independent Markdown records and bytes.
Uploading the bytes does not rewrite notes; browser insertion edits the current notes document and uses its existing autosave and conflict protection.

## In the browser

Choose **+ image/video** in the page's Notes toolbar, or in **Files**, to select one or more files.
You can also drag images and videos onto any part of the open page modal, including the notes and header.
Completed media is inserted directly into Notes at the remembered caret, or at the end if the editor has not been focused.
Uploads keep Notes open, and multiple files can appear between paragraphs.
The insertion position tracks typing during the upload without saving temporary markers.
Deleting that position prevents a late completion from restoring removed content.
Existing inline image embeds continue to render.
The picker accepts PNG, JPEG, WebP, and GIF images up to 10 MB, and MP4 videos up to 100 MB.
Recordings must meet the codec and duration limits below.

Files upload sequentially with individual progress, validation errors, and retry controls.
A failed file does not prevent the rest of the selection from uploading.
**Retry** resumes the same file, including when the server saved it but the completion response was lost.
Choosing the same file with the same name again returns the existing attachment.
Notes remain editable during uploads.
Closing the modal stops the local queue and aborts outstanding requests; an already committed attachment remains saved.
Choose unfinished files again on the original page to resume them before their 24-hour staging expiry.
Browser uploads require HTTPS or localhost for SHA-256 hashing.

The demo holds selected media only in the current tab's memory, with a 100 MB total limit.
It sends no upload requests, does not run server-side media validation, and releases these files on reload or playground reset.

## Embedded media syntax

Images use Markdown image syntax with the stable attachment reference.
Recordings use the same syntax with a `"video/mp4"` title so the notes renderer can recognize authenticated URLs without filename extensions:

```markdown
Before the recording.

![Reproduction](/api/attachments/ATTACHMENT_ID?project=PROJECT_ID "video/mp4")

What happened next.
```

The server's `embed` value already escapes the filename and includes the media type.
Source mode exposes the reference for moving, editing the label, or removing it from the notes.
Removing an embed leaves the stored original available in Files.
An explicit second insertion may reuse the same stored file at another position; transport retries do not duplicate its stored bytes.

## From the machine holding the file

Build `packages/grimoire-mcp` and run its companion uploader on the agent's machine:

```sh
node /path/to/grimoire/packages/grimoire-mcp/dist/upload.js <page-id> /local/path/recording.mp4
```

An installed package also provides `grimoire-upload <page-id> <local-file>`.
Use the same `GRIMOIRE_URL`, `GRIMOIRE_TOKEN`, and optional `GRIMOIRE_PROJECT` environment variables as the MCP server.
Keep tokens out of command arguments and reports.
The uploader reads the local file, computes its SHA-256, sends bounded chunks, and prints the completed attachment as JSON.
Progress goes to stderr.
Rerunning the exact command resumes an interrupted upload, or returns the already attached file.
The helper retries temporary network failures, busy validation, and rate limits with backoff.

The file does not need to exist on the MCP server or the Grimoire host.
For a remote MCP host, use the tools below to send the bytes from the machine that can read the file.
No MCP tool accepts a filesystem path or fetches a supplied remote URL.

## MCP workflow

1. Read the board, page, and discussion to confirm the destination and permission to attach the evidence.
2. Compute the file's SHA-256 and byte length locally.
3. Call `grimoire_begin_attachment` with `pageId`, `filename`, `mediaType`, `size`, `sha256`, and a stable `key`.
   Use the SHA-256 as the key unless the same file intentionally needs a separate attachment.
4. Follow the returned `offset` and `chunkLimit`.
   Call `grimoire_upload_attachment_chunk` with `id`, the byte `offset`, and canonical base64 `data` containing at most 512000 decoded bytes.
   Omit data URL prefixes and whitespace.
5. Call `grimoire_complete_attachment` after every byte has arrived.
   Only a response with `state: "complete"` confirms attachment to the page.
6. Confirm the returned `attachment.pageId`, filename, media type, stable `reference`, and `embed` Markdown.
7. Read the latest page notes and insert `attachment.embed` at the requested position using `grimoire_update_page` with the exact `expectedNotes`.
   Preserve the surrounding text and reconcile a conflict against the latest notes instead of overwriting another writer.
   After an interrupted notes update, check for the same attachment reference before inserting it again.
8. Read the page back and verify the embed is in the intended position.
   Upload completion confirms stored bytes; successful notes insertion confirms embedded evidence.

`grimoire_attachment_status` returns the durable offset after a lost response.
Repeating begin with the original metadata and key also resumes safely.
A repeated chunk must contain identical bytes; an already received prefix is verified before appending its remainder.
The final directory rename publishes the record and bytes together, so retrying completion after a lost response returns the same attachment ID.
A different filename, size, media type, or digest with the same key returns a conflict instead of silently creating another attachment.

`grimoire_cancel_attachment_upload` deletes the caller's unfinished bytes.
It cannot delete committed attachments.
An interrupted initialization can be restarted with the same key.
Incomplete or rejected uploads remain private, expire 24 hours after begin, and are removed on server startup or the next begin in that project.
At most eight unfinished uploads may exist per project, limiting staged storage to 800 MB.
Expired uploads must begin again with the same key and metadata.
Successful attachments do not expire.

## Limits and errors

| Limit | Value |
| --- | --- |
| Images | 10 MB, decimal bytes |
| MP4 recordings | 100 MB, decimal bytes |
| Decoded chunk | 512000 bytes |
| Image or video dimensions | At most 16777216 pixels |
| Recording or animation duration | At most 10 minutes |
| MP4 codecs | One H.264 video track, optional AAC audio |
| Validation | Up to 15 seconds probing plus 60 seconds decoding |
| Concurrent validation | Two files per server process |

Configure MCP tool timeouts above 75 seconds when completing recordings.
If a tool times out, check status before retrying completion.
The existing token write rate limit applies to begin, chunks, complete, and cancellation.
Large uploads can take several minutes under that limit; wait and retry the same operation on HTTP 429.

Content must match the declared media type and decode successfully.
Grimoire verifies the full SHA-256 and uses FFmpeg's maintained decoders, with a forced input format, network protocols disabled, external MOV references disabled, bounded dimensions, execution time, and decoder concurrency.
A format mismatch, corrupt media, unsupported codec, or decode timeout returns HTTP 415 with an actionable error.
A checksum mismatch returns HTTP 422; cancel and begin with the correct file.
Incomplete uploads, conflicting bytes, and reused keys with different metadata return HTTP 409.
Oversize bodies/images return HTTP 413, and invalid metadata returns HTTP 400 with field details.
Unavailable validators or occupied validation slots return HTTP 503; retain the upload and retry completion after correcting the cause.

## Private storage and operations

Every list, status, upload, playback, and download request checks project access.
Agent credentials remain pinned to their project; read-only tokens can list and read committed files but cannot upload or cancel.
Only the issuing person can resume or cancel their upload.
A stable reference includes the project ID and still requires a valid session or matching bearer token.
It is not a public sharing URL.
Membership and the agent credential are checked again after validation before committing.
Archived pages stop serving their attachments.

The binary route supports `HEAD` and a single HTTP byte range for video seeking.
Add `&download=1` to its project-qualified reference for a named download.
Responses use `private, no-store` caching and `nosniff`.

Files live under `<pages-root>/<project-slug>/attachments/<attachment-id>/` with `attachment.md` and `content`.
Unfinished uploads live under the sibling `.uploads/` directory.
The attachment ID is derived from the page ID and retry key within that project's storage.
Back up the whole project directory along with the SQLite database.
SQLite records attachment activity, while the Markdown record and bytes remain the canonical evidence.

The Docker image includes FFmpeg and ffprobe.
For a Node deployment, install both commands on `PATH` and keep the operating system's FFmpeg packages updated.
The application can start without them, but attachment completion reports that validation is unavailable.

## HTTP transport

| Method and route | Payload or result |
| --- | --- |
| `GET /api/pages/:page/attachments` | `{ attachments: [...] }` |
| `POST /api/pages/:page/attachments/uploads` | Begin metadata; upload state |
| `GET /api/attachment-uploads/:id` | Durable upload state |
| `POST /api/attachment-uploads/:id/chunks` | `{ offset, data }`; updated state |
| `POST /api/attachment-uploads/:id/complete` | Validated attachment in upload state |
| `POST /api/attachment-uploads/:id/cancel` | `{ ok: true }` |
| `GET` or `HEAD /api/attachments/:id?project=:project` | Authenticated image/video bytes |

Browser clients send their session cookie and project header; agents send their bearer token.
The legacy `/api/images` route remains outside the agent allowlist.
