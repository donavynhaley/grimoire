import { useEffect, useMemo, useRef, useState } from "react";
import type { DiscussionMessage, DiscussionThread, Member } from "../../shared/types";
import { DISCUSSION_BODY_MAX_LENGTH } from "../../shared/types";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";
import { relativeLabel } from "./activity-copy";

/**
 * The conversation on a page, in a column of its own beside the writing.
 *
 * The history is a trail the system wrote about the page; this is what people said to each
 * other about it. Keeping them in separate columns is what tells them apart, which is why a
 * thread needs no card, border or raised surface of its own - it is a name, a time, and what
 * was said, ruled off from the next one. No bubbles, no second typeface, nothing that would
 * turn a work board into a chat client.
 *
 * At rest a thread shows only that. Reply and answered are revealed on hover, because seven
 * open threads meant seven of each standing down a narrow column.
 *
 * It is a discussion and nothing more. It does not work out whose turn it is or mark a thread
 * as owing anybody an answer: a conversation between two people about one page does not need
 * to be told who should speak next, and saying so on every other thread turned reading it into
 * being chased.
 *
 * A thread carries exactly one piece of state: open, or answered. Answered threads fold away,
 * which is what keeps a page with forty messages on it showing you two. Nothing is deleted to
 * get there, and reopening costs one click.
 */

type Props = {
  threads: DiscussionThread[] | null;
  members: Member[];
  onAsk: (body: string) => Promise<void>;
  onReply: (threadId: string, body: string) => Promise<void>;
  onSetAnswered: (threadId: string, answered: boolean) => Promise<void>;
};

export function DiscussionSection({ threads, members, onAsk, onReply, onSetAnswered }: Props) {
  const [showingAnswered, setShowingAnswered] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const open = (threads ?? []).filter((thread) => thread.answeredAt === null);
  const answered = (threads ?? []).filter((thread) => thread.answeredAt !== null);
  const shown = showingAnswered ? [...open, ...answered] : open;

  /*
   * A column, not a section: the composer holds its height and the threads take everything
   * left over. That is what lets the list run as long as the conversation does without a cap,
   * and it is the whole reason this moved out from under the notes.
   *
   * It carries no heading of its own. The switch at the top of the column already says the
   * word and the unread count and is what turns to this, and the tab strip does the same job
   * on a narrow screen; a heading here would be a third place saying it.
   */
  return (
    <div className="page-discussion">
      {threads === null
        ? <p className="empty-dependencies">Reading the discussion...</p>
        : (
          <div className="discussion-threads">
            {shown.map((thread) => (
              <Thread
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
                {answered.length > 0 ? "Everything here has been answered." : "Nothing has been said here yet."}
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

      <Composer label="Start a thread" onSubmit={onAsk} placeholder="Say something about this page..." />
    </div>
  );
}

function Thread({ thread, members, replying, onReply, onReplyingChange, onSetAnswered }: {
  thread: DiscussionThread;
  members: Member[];
  replying: boolean;
  onReply: (body: string) => Promise<void>;
  onReplyingChange: (active: boolean) => void;
  onSetAnswered: (answered: boolean) => Promise<void>;
}) {
  const answered = thread.answeredAt !== null;
  // One clock per render of this thread, so every time in it agrees with the others.
  const now = useMemo(() => new Date(), [thread]);

  return (
    <Growing className={`discussion-thread${answered ? " answered" : ""}`}>
      <Message
        /*
         * Both actions in one cluster at the end of the head, revealed together rather than
         * standing under every thread. Seven open threads meant seven REPLY buttons and seven
         * MARK ANSWERED down a narrow column, which is more furniture than conversation.
         */
        action={(
          <span className="thread-actions">
            {!answered && !replying && (
              <button className="text-button" onClick={() => onReplyingChange(true)} type="button">reply</button>
            )}
            <button className="text-button" onClick={() => void onSetAnswered(!answered)} type="button">
              {answered ? "reopen" : "answered"}
            </button>
          </span>
        )}
        members={members}
        message={thread}
        now={now}
      />
      {thread.replies.map((message) => (
        <Message key={message.id} members={members} message={message} now={now} reply />
      ))}
      {answered && (
        <p className="thread-settled">
          Answered{thread.answeredByName ? ` by ${thread.answeredByName}` : ""} {relativeLabel(thread.answeredAt as string, now)}
        </p>
      )}
      {replying && (
        <Composer autoFocus label="Reply" onCancel={() => onReplyingChange(false)} onSubmit={onReply} placeholder="Reply..." reply />
      )}
    </Growing>
  );
}

function Message({ message, members, now, action, reply }: {
  message: DiscussionMessage;
  members: Member[];
  now: Date;
  action?: React.ReactNode;
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
    /*
     * Zero first, not "auto".
     *
     * A textarea sized `auto` inside a grid resolves its height from the row it is in, and
     * the row is sized from the textarea - so the measurement reads back whatever the box
     * already was and an empty field settles a hundred pixels tall. Collapsing it to nothing
     * breaks the circle, and `min-height` in the stylesheet decides the floor.
     */
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  /*
   * Measure again whenever the field changes width.
   *
   * The column it sits in can be folded away, and a textarea with no width wraps its
   * placeholder into a dozen lines and pins that height for when the column comes back. The
   * observer also covers the width travelling as the column opens, which is the same problem
   * arriving more slowly.
   */
  useEffect(() => {
    const element = field.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === 0) return;
      element.style.height = "0px";
      element.style.height = `${element.scrollHeight}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
