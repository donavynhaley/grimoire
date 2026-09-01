import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DiscussionMessage, DiscussionThread, Member } from "../../shared/types";
import { DISCUSSION_BODY_MAX_LENGTH } from "../../shared/types";
import { relativeLabel } from "../lib/activity-copy";
import { withMentions } from "../lib/mention-text";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";

/**
 * The conversation on a page, in a column of its own beside the writing. A thread is a name,
 * a time, and what was said - one piece of state, open or answered - and the reasons it looks
 * and behaves this way are design record, in docs/architecture.md under "Discussion".
 */

type Props = {
  threads: DiscussionThread[] | null;
  /** True when the conversation could not be fetched, so an empty column is not a lie. */
  failed?: boolean;
  members: Member[];
  /** Only so your own name can light up when somebody writes it. */
  currentUserId: string;
  onAsk: (body: string) => Promise<void>;
  onReply: (threadId: string, body: string) => Promise<void>;
  onSetAnswered: (threadId: string, answered: boolean) => Promise<void>;
};

export function DiscussionSection({
  threads,
  failed,
  members,
  currentUserId,
  onAsk,
  onReply,
  onSetAnswered,
}: Props) {
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
      {failed ? (
        <p className="empty-dependencies">
          The conversation could not be loaded. Close the page and open it again.
        </p>
      ) : threads === null ? (
        <p className="empty-dependencies">Reading the discussion...</p>
      ) : (
        <Growing className="discussion-threads">
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
        </Growing>
      )}

      <Composer
        label="Start a thread"
        members={members}
        onSubmit={onAsk}
        placeholder="Say something about this page..."
        sendLabel="post"
      />
    </div>
  );
}

function Thread({
  thread,
  members,
  currentUserId,
  replying,
  onReply,
  onReplyingChange,
  onSetAnswered,
}: {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: thread is the trigger for taking one clock per render of this thread, so every time shown in it agrees with the others
  const now = useMemo(() => new Date(), [thread]);

  return (
    <Growing className={`discussion-thread${answered ? " answered" : ""}`}>
      <Message
        /*
         * Both actions in one cluster at the end of the head, revealed together rather than
         * standing under every thread. Seven open threads meant seven REPLY buttons and seven
         * MARK ANSWERED down a narrow column, which is more furniture than conversation.
         */
        action={
          <span className="thread-actions">
            {!answered && !replying && (
              <button className="text-button" onClick={() => onReplyingChange(true)} type="button">
                reply
              </button>
            )}
            <button className="text-button" onClick={() => void onSetAnswered(!answered)} type="button">
              {answered ? "reopen" : "answered"}
            </button>
          </span>
        }
        currentUserId={currentUserId}
        members={members}
        message={thread}
        now={now}
      />
      {thread.replies.map((message) => (
        <Message
          currentUserId={currentUserId}
          key={message.id}
          members={members}
          message={message}
          now={now}
          reply
        />
      ))}
      {answered && (
        <p className="thread-settled">
          Answered{thread.answeredByName ? ` by ${thread.answeredByName}` : ""}{" "}
          {relativeLabel(thread.answeredAt as string, now)}
        </p>
      )}
      {replying && (
        <Composer
          autoFocus
          label="Reply"
          members={members}
          onCancel={() => onReplyingChange(false)}
          onSubmit={onReply}
          placeholder="Reply..."
          reply
          sendLabel="reply"
        />
      )}
    </Growing>
  );
}

function Message({
  message,
  members,
  currentUserId,
  now,
  action,
  reply,
}: {
  message: DiscussionMessage;
  members: Member[];
  currentUserId: string;
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
      <p className="message-body">{withMentions(message.body, message.mentions, members, currentUserId)}</p>
    </div>
  );
}

/**
 * Sizes a textarea to exactly what is written in it.
 *
 * Zero first, not "auto": a textarea sized `auto` inside a grid resolves its height from the
 * row it is in, and the row is sized from the textarea, so the measurement reads back whatever
 * the box already was and an empty field settles a hundred pixels tall. Collapsing it to
 * nothing breaks the circle, and `min-height` in the stylesheet decides the floor.
 *
 * The borders are added back on. `scrollHeight` measures the padding and the content and
 * nothing else, while under `box-sizing: border-box` the height it is assigned to has to
 * contain the borders too - so setting one to the other leaves the content two pixels short
 * of its own text, and a field that is exactly full scrolls.
 */
function fitToContent(element: HTMLTextAreaElement): void {
  const style = getComputedStyle(element);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight + borders}px`;
}

/**
 * One place to write something.
 *
 * The textarea grows with what is typed rather than scrolling inside a fixed box, because a
 * question worth asking is usually two lines and a box sized for one makes people write less
 * than they meant to. Enter sends and shift-enter breaks the line, which is what everyone
 * expects from a field that looks like this.
 */
function Composer({
  onSubmit,
  onCancel,
  placeholder,
  label,
  sendLabel,
  members,
  reply,
  autoFocus,
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  placeholder: string;
  /** What a screen reader calls the field. */
  label: string;
  /** What the button says. Shorter than the field's name, because it sits beside it. */
  sendLabel: string;
  members: Member[];
  reply?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  /*
   * The half-written name under the caret, if there is one.
   *
   * Only ever looked for behind the caret and only back to the `@` that started it, so typing
   * an address does not open a picker and moving the caret elsewhere closes one.
   */
  const [naming, setNaming] = useState<{ query: string; at: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  /*
   * A half-written name the picker has been told to leave alone.
   *
   * Escape cannot simply close it: the caret is still sitting behind the same `@Mar`, and the
   * next key would derive it all over again. Remembering which one was dismissed keeps it shut
   * until the writing moves on.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);
  // One id per composer, so the reply's picker and the page's never claim the same one.
  const pickerId = useId();

  const matches = naming
    ? members.filter((member) => member.name.toLowerCase().startsWith(naming.query.toLowerCase())).slice(0, 6)
    : [];

  const readCaret = (element: HTMLTextAreaElement) => {
    const caret = element.selectionStart ?? 0;
    const before = element.value.slice(0, caret);
    // A name runs from the last `@` to the caret, and only if that `@` starts a word.
    const match = before.match(/(?:^|[^\w@])@([\w'-]*(?: [\w'-]*)?)$/);
    if (!match) {
      setNaming(null);
      setDismissed(null);
      return;
    }
    const at = caret - match[1]!.length - 1;
    const key = `${at}:${match[1]!}`;
    if (key === dismissed) {
      setNaming(null);
      return;
    }
    setDismissed(null);
    setNaming({ query: match[1]!, at });
    setHighlighted(0);
  };

  const choose = (member: Member) => {
    const element = field.current;
    if (!element || !naming) return;
    const caret = element.selectionStart ?? 0;
    const next = `${value.slice(0, naming.at)}@${member.name} ${value.slice(caret)}`;
    setValue(next);
    setNaming(null);
    /*
     * The name is written with a space after it, and that space is still inside what reads as
     * a half-written name - "@Maren " is a plausible start for "Maren Voss". Left alone the
     * picker reopens on the space it just typed, and the next Enter picks somebody instead of
     * sending. Dismissing exactly that state closes it until the writing moves on.
     */
    setDismissed(`${naming.at}:${member.name} `);
    // Put the caret after the name that was just written, not back at the end of everything.
    const to = naming.at + member.name.length + 2;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(to, to);
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect measures the field through a ref; value is what should make it measure again, not something it reads
  useEffect(() => {
    if (field.current) fitToContent(field.current);
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
      fitToContent(element);
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
        aria-activedescendant={matches.length > 0 ? `${pickerId}-${highlighted}` : undefined}
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? pickerId : undefined}
        aria-expanded={matches.length > 0}
        aria-label={label}
        maxLength={DISCUSSION_BODY_MAX_LENGTH}
        onChange={(event) => {
          setValue(event.target.value);
          readCaret(event.target);
        }}
        onKeyDown={(event) => {
          /*
           * While a name is being picked those keys belong to the picker. Enter especially:
           * it would otherwise post a message with half a name in it.
           */
          if (matches.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((index) => (index + 1) % matches.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((index) => (index - 1 + matches.length) % matches.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              choose(matches[highlighted]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              // The drawer closes on Escape too, and it must not hear this one.
              event.stopPropagation();
              setDismissed(`${naming?.at}:${naming?.query}`);
              setNaming(null);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
          /*
           * Backing out of a reply is not closing the page.
           *
           * The drawer listens for Escape as well, so without stopping this one here a reply
           * somebody had half written took the whole dialog down with it.
           */
          if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onKeyUp={(event) => readCaret(event.currentTarget)}
        onBlur={() => setNaming(null)}
        placeholder={placeholder}
        ref={field}
        role="combobox"
        rows={1}
        value={value}
      />
      {matches.length > 0 && (
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a ul carrying role=listbox is the standard markup for this pattern, and docs/ui-standards.md asks for a listbox that contains options and nothing else, which is exactly what this is
        <ul className="mention-picker" id={pickerId} role="listbox">
          {matches.map((member, index) => (
            /*
             * The option is the row itself rather than a control inside it, so the listbox
             * really owns its options; a list item in between would break that ownership and
             * leave a reader with a listbox that appears to hold nothing.
             */
            // biome-ignore lint/a11y/useFocusableInteractive: the options are deliberately not focusable: focus stays in the input and aria-activedescendant names the active row, which is the combobox pattern docs/ui-standards.md specifies
            <li
              aria-selected={index === highlighted}
              className={index === highlighted ? "mention-option on" : "mention-option"}
              id={`${pickerId}-${index}`}
              key={member.id}
              // The field blurs before a click lands, which would close the picker first.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(member);
              }}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a ul carrying role=listbox is the standard markup for this pattern, and docs/ui-standards.md asks for a listbox that contains options and nothing else, which is exactly what this is
              role="option"
            >
              <Avatar avatarUrl={member.avatarUrl} className="avatar tiny" name={member.name} />
              {member.name}
            </li>
          ))}
        </ul>
      )}

      {/*
        The same shape the capture field at the top of the board has: a button that is always
        there and comes alive when there is something to send. It is the one control on this
        panel that commits something, and the product already has a look for that.
      */}
      <div className="composer-tools">
        {onCancel && (
          <button className="text-button" onClick={onCancel} type="button">
            cancel
          </button>
        )}
        <button
          className="primary-button compact"
          disabled={!value.trim() || busy}
          onClick={() => void send()}
          type="button"
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
