import { useState } from "react";
import type { Chapter } from "../../shared/types";
import { mutate } from "../api/client";
import { Growing } from "./Growing";
import type { SettingsRun } from "../hooks/use-settings-action";

/**
 * Where a chapter's recap goes when it closes.
 *
 * The webhook is write-only from here, like the GitHub token: settings can tell one is held,
 * replace it, or clear it, and never reads it back. Posting by hand is offered beside the
 * automation because the first thing anyone wants after pasting a webhook is to see something
 * arrive in the channel.
 */
export function DiscordSection({
  busy,
  chapters,
  chaptersEnabled,
  onSetRecapOnClose,
  onSetWebhook,
  project,
  run,
}: {
  busy: boolean;
  chapters: Chapter[];
  chaptersEnabled: boolean;
  onSetRecapOnClose: (enabled: boolean) => Promise<void>;
  onSetWebhook: (webhook: string) => Promise<void>;
  project: { discordWebhookSet: boolean; recapOnClose: boolean };
  run: SettingsRun;
}) {
  const [webhook, setWebhook] = useState("");
  const [showingSetup, setShowingSetup] = useState(!project.discordWebhookSet);
  const [posted, setPosted] = useState<string | null>(null);
  const closed = chapters.filter((chapter) => chapter.state === "closed");

  const saveWebhook = () => {
    const next = webhook.trim();
    if (!next) return;
    setWebhook("");
    void run(() => onSetWebhook(next), "The webhook could not be saved");
  };

  // Deliberately not through `run`: posting a recap saves nothing, and the section's own
  // line - success or refusal - is the whole answer. The shared strip saying "saved" on
  // top of it would be two status voices announcing one act.
  const postNow = async (slug: string, name: string) => {
    setPosted(null);
    try {
      await mutate(`/api/chapters/${slug}/recap`, "POST");
      setPosted(`Posted the recap for ${name}.`);
    } catch {
      setPosted("Discord would not take the post. Check the webhook.");
    }
  };

  return (
    <div className="settings-section">
      <div className="github-intro">
        <p className="chapters-note">
          When a chapter closes, Grimoire posts what it delivered, what it carried onward, and who shipped
          what. Nothing is written on anyone&apos;s behalf - it is the board&apos;s own numbers.
        </p>
        <button
          aria-expanded={showingSetup}
          aria-label={showingSetup ? "Hide setup instructions" : "How do I set this up?"}
          className="github-help"
          onClick={() => setShowingSetup((showing) => !showing)}
          title="How do I set this up?"
          type="button"
        >
          ?
        </button>
      </div>

      <Growing className="github-setup-fold">
        {showingSetup && (
          <ol className="github-setup">
            <li>
              In Discord, open <em>Server Settings → Integrations → Webhooks</em>, make a webhook pointed at
              the channel you want recaps in, and copy its URL.
            </li>
            <li>Paste it below. It stays on the server and is never shown again.</li>
            <li>
              Leave <em>post on close</em> on, and every chapter you close announces itself.
            </li>
          </ol>
        )}
      </Growing>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-discord-webhook">
          Webhook URL
        </label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-discord-webhook"
            name="discordWebhook"
            onBlur={saveWebhook}
            onChange={(event) => setWebhook(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveWebhook();
              }
            }}
            placeholder={
              project.discordWebhookSet
                ? "A webhook is saved. Paste a new one to replace it."
                : "https://discord.com/api/webhooks/..."
            }
            type="password"
            value={webhook}
          />
        </div>
        {project.discordWebhookSet && (
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void run(() => onSetWebhook(""), "The webhook could not be cleared")}
            type="button"
          >
            forget the saved webhook
          </button>
        )}
      </div>

      <Growing className="settings-row">
        <div className="settings-row-top">
          <span className="field-label">Post on close</span>
          <label className="settings-toggle">
            <input
              aria-label="Post on close"
              checked={project.recapOnClose}
              disabled={busy || !project.discordWebhookSet}
              name="recapOnClose"
              onChange={(event) =>
                void run(() => onSetRecapOnClose(event.target.checked), "The setting could not be changed")
              }
              type="checkbox"
            />
            <span aria-hidden="true" className="settings-knob" />
            <span className="settings-toggle-label">{project.recapOnClose ? "on" : "off"}</span>
          </label>
        </div>
        <p className="settings-summary">
          {chaptersEnabled
            ? "Closing a chapter posts its recap. Turn this off to post only by hand."
            : "Chapters are off, so nothing closes and nothing posts. Turn them on to use this."}
        </p>
      </Growing>

      {project.discordWebhookSet && closed.length > 0 && (
        <div className="settings-row">
          <span className="field-label">Post one now</span>
          <div className="library-filters">
            {closed.slice(0, 6).map((chapter) => (
              <button
                disabled={busy}
                key={chapter.slug}
                onClick={() => void postNow(chapter.slug, chapter.name)}
                type="button"
              >
                {chapter.name}
              </button>
            ))}
          </div>
          {posted && (
            <p className="github-check-result ok" role="status">
              {posted}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
