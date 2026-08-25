import { useEffect, useMemo, useRef, useState } from "react";
import type { DiscussionMessage, DiscussionThread, Member } from "../../shared/types";
import { DISCUSSION_BODY_MAX_LENGTH } from "../../shared/types";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";
import { relativeLabel } from "./activity-copy";

/**
 * The conversation on a page, kept visibly apart from the history under it.
 *
 * The history is a trail the system wrote about the page; this is what people said to each
 * other about it. They are different materials, so they read differently: history is flat
 * muted text, and a thread is a raised block on the same surface a board tile uses. That one
 * distinction is the whole visual vocabulary here - no bubbles, no second typeface, nothing
 * that would turn a work board into a chat client.
 *
 * A thread carries exactly one piece of state: open, or answered. Answered threads fold away,
 * which is what keeps a page with forty messages on it showing you two. Nothing is deleted to
 * get there, and reopening costs one click.
 */

type Props = {
  threads: DiscussionThread[] | null;
  members: Member[];
  currentUserId: string;
  onAsk: (body: string) => Promise<void>;
  onReply: (threadId: string, body: string) => Promise<void>;
  onSetAnswered: (threadId: string, answered: boolean) => Promise<void>;
  /** Folds the column away for this visit. The next page decides for itself again. */
  onClose: () => void;
};

export function DiscussionSection({ threads, members, currentUserId, onAsk, onReply, onSetAnswered, onClose }: Props) {
  const [showingAnswered, setShowingAnswered] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const open = (threads ?? []).filter((thread) => thread.answeredAt === null);
  const answered = (threads ?? []).filter((thread) => thread.answeredAt !== null);
  const shown = showingAnswered ? [...open, ...answered] : open;

  /*
   * A column, not a section: the head and the composer hold their height and the threads take
   * everything left over. That is what lets the list run as long as the conversation does
   * without a cap, and it is the whole reason this moved out from under the notes.
   */
  return (
    <div className="page-discussion">
      <div className="discussion-head">
        <span className="field-label">Discussion</span>
        {open.length > 0 && <span className="discussion-open">{open.length} open</span>}
        <button
          aria-label="Close discussion"
          className="text-button discussion-close"
          onClick={onClose}
          type="button"
        >
          hide
        </button>
      </div>

      {threads === null
        ? <p className="empty-dependencies">Reading the discussion...</p>
        : (
          <div className="discussion-threads">
            {shown.map((thread) => (
              <Thread
                currentUserId={currentUserId}
                key={thread.id}
                members={members}
                onReply={(body) => onReply(thread.id, body)}
                onReplyingChange={(active) => setReplyingTo(active ? thread.id : null)}
                onSetAnswered={(answer) => onSetAnswered(thread.id, answer)}
                replying={replyingTo === thread.id}
                thread={thread}
              />
            ))}
            {shown.length === 0 && (
              <p className="empty-dependencies">
                {answered.length > 0 ? "Nothing is waiting on anyone." : "Nothing has been asked here yet."}
              </p>
            )}
            {answered.length > 0 && (
              <button
                aria-expanded={showingAnswered}
                className="text-button discussion-fold"
                onClick={() => setShowingAnswered((showing) => !showing)}
                type="button"
              >
                {showingAnswered ? `hide ${answered.length} answered` : `show ${answered.length} answered`}
              </button>
            )}
          </div>
        )}

      <Composer label="Start a thread" onSubmit={onAsk} placeholder="Ask something about this page..." />
    </div>
  );
}

function Thread({ thread, members, currentUserId, replying, onReply, onReplyingChange, onSetAnswered }: {
  thread: DiscussionThread;
  members: Member[];
  currentUserId: string;
  replying: boolean;
  onReply: (body: string) => Promise<void>;
  onReplyingChange: (active: boolean) => void;
  onSetAnswered: (answered: boolean) => Promise<void>;
}) {
  const answered = thread.answeredAt !== null;
  // One clock per render of this thread, so every time in it agrees with the others.
  const now = useMemo(() => new Date(), [thread]);
  /*
   * Whose turn it is, said the same way the server says it: a thread nobody has answered in
   * words is waiting on whoever was asked, and one that has been replied to is back with the
   * person who asked. Only the accent edge marks it, and only when the turn is actually yours.
   */
  const last = thread.replies.at(-1) ?? thread;
  const yourTurn = !answered && last.authorId !== currentUserId;

  return (
    <Growing className={`discussion-thread${yourTurn ? " needs-you" : ""}${answered ? " answered" : ""}`}>
      <Message
        action={(
          <button className="text-button thread-answer" onClick={() => void onSetAnswered(!answered)} type="button">
            {answered ? "reopen" : "mark answered"}
          </button>
        )}
        members={members}
        message={thread}
        note={yourTurn ? "waiting on you" : null}
        now={now}
      />
      {thread.replies.map((message) => (
        <Message key={message.id} members={members} message={message} now={now} reply />
      ))}
      {answered
        ? (
          <p className="thread-settled">
            Answered{thread.answeredByName ? ` by ${thread.answeredByName}` : ""} {relativeLabel(thread.answeredAt as string, now)}
          </p>
        )
        : replying
          ? <Composer autoFocus label="Reply" onCancel={() => onReplyingChange(false)} onSubmit={onReply} placeholder="Reply..." reply />
          : (
            <button className="text-button thread-reply" onClick={() => onReplyingChange(true)} type="button">
              reply
            </button>
          )}
    </Growing>
  );
}

function Message({ message, members, now, action, note, reply }: {
  message: DiscussionMessage;
  members: Member[];
  now: Date;
  action?: React.ReactNode;
  note?: string | null;
  reply?: boolean;
}) {
  const member = members.find((candidate) => candidate.id === message.authorId);
  return (
    <div className={reply ? "discussion-message reply" : "discussion-message"}>
      <div className="message-head">
        <Avatar avatarUrl={member?.avatarUrl} className="avatar tiny" name={message.authorName} />
        <span className="message-who">{message.authorName}</span>
        {/* An agent never replaces the person it wrote for; it is named beside them. */}
        {message.agentName && <span className="via-agent">via {message.agentName}</span>}
        <time dateTime={message.createdAt}>{relativeLabel(message.createdAt, now)}</time>
        {note && <span className="message-note">{note}</span>}
        {action}
      </div>
      <p className="message-body">{message.body}</p>
    </div>
  );
}

/**
 * One place to write something.
 *
 * The textarea grows with what is typed rather than scrolling inside a fixed box, because a
 * question worth asking is usually two lines and a box sized for one makes people write less
 * than they meant to. Enter sends and shift-enter breaks the line, which is what everyone
 * expects from a field that looks like this.
 */
function Composer({ onSubmit, onCancel, placeholder, label, reply, autoFocus }: {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  placeholder: string;
  label: string;
  reply?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  const send = async () => {
    const body = value.trim();
    // A double press while the first one is still in flight would post the same thing twice.
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setValue("");
      onCancel?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={reply ? "discussion-composer reply" : "discussion-composer"}>
      <textarea
        aria-label={label}
        maxLength={DISCUSSION_BODY_MAX_LENGTH}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
          if (event.key === "Escape" && onCancel) onCancel();
        }}
        placeholder={placeholder}
        ref={field}
        rows={1}
        value={value}
      />
      <div className="composer-tools">
        {onCancel && <button className="text-button" onClick={onCancel} type="button">cancel</button>}
        <button className="text-button composer-send" disabled={!value.trim() || busy} onClick={() => void send()} type="button">
          {label.toLowerCase()}
        </button>
      </div>
    </div>
  );
}
