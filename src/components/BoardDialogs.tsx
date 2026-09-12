import type { ComponentProps } from "react";
import type {
  AgentReview,
  AuditPage,
  AwayState,
  BoardWorkspace,
  DiscussionThread,
  Page,
  ProjectRole,
} from "../../shared/types";
import { revokeAgentToken } from "../api/client";
import { deferComponent } from "./Deferred";

const AccountDialog = deferComponent<ComponentProps<typeof import("./AccountDialog")["AccountDialog"]>>(
  () => import("./AccountDialog").then((module) => ({ default: module.AccountDialog })),
  { exportName: "AccountDialog", label: "account settings", close: (props) => props.onClose },
);

import { ActivityDialog } from "./ActivityDialog";
import { AgentReviewDialog } from "./AgentReviewDialog";
import { BacklogDialog } from "./BacklogDialog";
import type { CategoryActions } from "./CategoriesSection";
import { type ChapterFilter, NO_CHAPTER } from "./ChapterPicker";
import type { ChapterActions } from "./ChaptersSection";
import { DoneHistoryDialog } from "./DoneHistoryDialog";
import type { FieldActions } from "./FieldsSection";

const PageDialog = deferComponent<ComponentProps<typeof import("./PageDialog")["PageDialog"]>>(
  () => import("./PageDialog").then((module) => ({ default: module.PageDialog })),
  { exportName: "PageDialog", label: "page editor", close: (props) => props.onClose },
);

import type { ProjectSettingsActions, SettingsSection } from "./ProjectSettingsDialog";
import { SearchDialog } from "./SearchDialog";

const ProjectSettingsDialog = deferComponent<
  ComponentProps<typeof import("./ProjectSettingsDialog")["ProjectSettingsDialog"]>
>(() => import("./ProjectSettingsDialog").then((module) => ({ default: module.ProjectSettingsDialog })), {
  exportName: "ProjectSettingsDialog",
  label: "project settings",
  close: (props) => props.onClose,
});

type Props = {
  accountOpen: boolean;
  activityOpen: boolean;
  agentReview: AgentReview | null;
  agentReviewOpen: boolean;
  away: AwayState | null;
  backlogOpen: boolean;
  backlogPages: Page[];
  board: BoardWorkspace;
  busy: boolean;
  categoryActions: CategoryActions;
  chapter: ChapterFilter;
  chapterActions: ChapterActions;
  completedPages: Page[];
  fieldActions: FieldActions;
  historyOpen: boolean;
  /** Seeds the search dialog with whatever the board's own search box holds. */
  initialQuery: string;
  online: ReadonlySet<string>;
  projectSettingsActions: ProjectSettingsActions;
  revision: number;
  searchOpen: boolean;
  selectedPage: Page | null;
  settingsSection: SettingsSection | null;
  onAddMember: (email: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onAsk: (pageId: string, body: string) => Promise<void>;
  onChangeAvatar: (file: File) => Promise<void>;
  onChangeMemberRole: (id: string, role: ProjectRole) => Promise<void>;
  onChangeName: (name: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onCloseAccount: () => void;
  onCloseActivity: () => void;
  onCloseAgentReview: () => void;
  onCloseBacklog: () => void;
  onCloseHistory: () => void;
  onCloseSearch: () => void;
  onCreateInvite: () => Promise<string>;
  onLoadActivity: (options: { entityId?: string; before?: number; limit?: number }) => Promise<AuditPage>;
  onLoadDiscussion: (pageId: string) => Promise<{ threads: DiscussionThread[] }>;
  onLogout: () => Promise<void>;
  onMoveBacklogToNext: (id: string) => Promise<void>;
  onOpenIdeaFromSearch: (id: string) => void;
  onOpenPageFromSearch: (id: string) => void;
  onReloadAgentReview: () => void;
  onRemoveAvatar: () => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onReply: (pageId: string, threadId: string, body: string) => Promise<void>;
  onRestorePage: (id: string) => Promise<void>;
  onSectionChange: (section: SettingsSection | null) => void;
  onSeeDiscussion: (pageId: string) => Promise<void>;
  onSelectPage: (id: string | null) => void;
  onSetAnswered: (pageId: string, threadId: string, answered: boolean) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
};

/** Every dialog the board can open, mounted in one place so the board itself reads as a board. */
export function BoardDialogs({
  accountOpen,
  activityOpen,
  agentReview,
  agentReviewOpen,
  away,
  backlogOpen,
  backlogPages,
  board,
  busy,
  categoryActions,
  chapter,
  chapterActions,
  completedPages,
  fieldActions,
  historyOpen,
  initialQuery,
  online,
  projectSettingsActions,
  revision,
  searchOpen,
  selectedPage,
  settingsSection,
  onAddMember,
  onArchive,
  onAsk,
  onChangeAvatar,
  onChangeMemberRole,
  onChangeName,
  onChangePassword,
  onCloseAccount,
  onCloseActivity,
  onCloseAgentReview,
  onCloseBacklog,
  onCloseHistory,
  onCloseSearch,
  onCreateInvite,
  onLoadActivity,
  onLoadDiscussion,
  onLogout,
  onMoveBacklogToNext,
  onOpenIdeaFromSearch,
  onOpenPageFromSearch,
  onReloadAgentReview,
  onRemoveAvatar,
  onRemoveMember,
  onReply,
  onRestorePage,
  onSectionChange,
  onSeeDiscussion,
  onSelectPage,
  onSetAnswered,
  onUpdate,
}: Props) {
  const chaptersOn = board.project.chaptersEnabled;
  const isOwner = board.viewerIsOwner;
  return (
    <>
      {searchOpen && (
        <SearchDialog
          initialQuery={initialQuery}
          onClose={onCloseSearch}
          onOpenPage={onOpenPageFromSearch}
          onOpenIdea={onOpenIdeaFromSearch}
          onRestorePage={onRestorePage}
        />
      )}
      {selectedPage && (
        <PageDialog
          pages={board.pages}
          page={selectedPage}
          categories={board.categories}
          chapters={chaptersOn ? board.chapters : []}
          fields={board.fields}
          currentUserId={board.currentUser.id}
          estimatesEnabled={board.project.estimatesEnabled}
          githubRepo={board.project.githubRepo}
          members={board.members}
          revision={revision}
          onArchive={async () => {
            await onArchive(selectedPage.id);
            onSelectPage(null);
          }}
          onClose={() => onSelectPage(null)}
          onLoadActivity={onLoadActivity}
          onLoadDiscussion={onLoadDiscussion}
          onAsk={onAsk}
          onReply={onReply}
          onSetAnswered={onSetAnswered}
          onSeeDiscussion={onSeeDiscussion}
          onUpdate={(input) => onUpdate(selectedPage.id, input)}
        />
      )}
      {agentReviewOpen && agentReview && (
        <AgentReviewDialog
          board={board}
          review={agentReview}
          onClose={onCloseAgentReview}
          onOpenPage={(id) => {
            if (!board.pages.some((page) => page.id === id)) return;
            onCloseAgentReview();
            onSelectPage(id);
          }}
          onRevoke={async (id) => {
            // Straight to the client, the way the settings section does it: a credential
            // is not board state, so the perform family's board reload buys nothing.
            await revokeAgentToken(id);
            onReloadAgentReview();
          }}
        />
      )}
      {activityOpen && (
        <ActivityDialog
          awaySince={away?.since}
          members={board.members}
          revision={revision}
          onClose={onCloseActivity}
          onLoad={onLoadActivity}
          onOpenPage={(id) => {
            if (!board.pages.some((page) => page.id === id)) return;
            onCloseActivity();
            onSelectPage(id);
          }}
        />
      )}
      {backlogOpen && (
        <BacklogDialog
          allPages={board.pages}
          busy={busy}
          pages={backlogPages}
          categories={board.categories}
          chapters={chaptersOn ? board.chapters : []}
          members={board.members}
          onClose={onCloseBacklog}
          onMoveToNext={onMoveBacklogToNext}
          onOpenPage={(id) => {
            onCloseBacklog();
            onSelectPage(id);
          }}
          onSetChapter={(id, value) => onUpdate(id, { chapter: value })}
          targetChapter={chaptersOn && chapter !== NO_CHAPTER ? chapter : null}
        />
      )}
      {historyOpen && (
        <DoneHistoryDialog
          busy={busy}
          pages={completedPages}
          categories={board.categories}
          members={board.members}
          onClose={onCloseHistory}
          onOpenPage={(id) => {
            onCloseHistory();
            onSelectPage(id);
          }}
          onReopen={async (id) => {
            onCloseHistory();
            await onUpdate(id, {
              status: "ready",
              position: board.pages.filter((page) => page.status === "ready").length,
            });
          }}
        />
      )}
      {settingsSection && (
        <ProjectSettingsDialog
          actions={projectSettingsActions}
          busy={busy}
          canArchive={board.projects.length > 1}
          categories={board.categories}
          categoryActions={categoryActions}
          chapterActions={chapterActions}
          chapters={board.chapters}
          chaptersEnabled={chaptersOn}
          velocity={board.velocity}
          currentUser={board.currentUser}
          fieldActions={fieldActions}
          fields={board.fields}
          isOwner={isOwner}
          members={board.members}
          onChangeMemberRole={onChangeMemberRole}
          onClose={() => onSectionChange(null)}
          onAddMember={onAddMember}
          onCreateInvite={onCreateInvite}
          online={online}
          onRemoveMember={onRemoveMember}
          onSectionChange={onSectionChange}
          pages={board.pages}
          project={board.project}
          section={settingsSection}
        />
      )}
      {accountOpen && (
        <AccountDialog
          onChangeAvatar={onChangeAvatar}
          onChangeName={onChangeName}
          onChangePassword={onChangePassword}
          onClose={onCloseAccount}
          onLogout={onLogout}
          onRemoveAvatar={onRemoveAvatar}
          user={board.currentUser}
        />
      )}
    </>
  );
}
