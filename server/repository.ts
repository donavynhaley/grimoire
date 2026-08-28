// The persistence facade: everything server code reads or writes about users,
// projects, categories, fields, members, chapters, GitHub links and pages lives
// in the modules under server/repository/, and this file only re-exports their
// public surface so existing import sites keep working. As route modules are
// carved out of app.ts, import the submodule directly instead of this facade.

export {
  advanceSeenCursor,
  defaultProjectIdForUser,
  findUserByEmail,
  findUserById,
  initializeSeenCursor,
  publicUser,
  seenCursor,
  userCount,
} from "./repository/users";

export {
  archiveProject,
  estimatesEnabled,
  listArchivedProjects,
  listProjectsForUser,
  projectById,
  projectRecapConfig,
  projectSlug,
  renameProject,
  restoreProject,
  setEstimatesEnabled,
  setProjectDescription,
  setProjectRecap,
  userCanAccessProject,
  userOwnsProject,
} from "./repository/projects";
export type { ArchiveProjectResult, RecapConfig } from "./repository/projects";

export {
  categoriesForProject,
  categorySlugFromName,
  createCategory,
  deleteCategory,
  updateCategory,
} from "./repository/categories";
export type { CreateCategoryResult } from "./repository/categories";

export {
  createField,
  deleteField,
  fieldKeyFromLabel,
  fieldsForProject,
  mergePageFields,
  updateField,
} from "./repository/fields";
export type { CreateFieldResult, FieldInput, UpdateFieldResult } from "./repository/fields";

export {
  addProjectMember,
  membersForProject,
  removeProjectMember,
  setMemberRole,
} from "./repository/members";
export type { AddProjectMemberResult, RemoveMemberResult, SetMemberRoleResult } from "./repository/members";

export {
  chapterSlugFromName,
  chaptersEnabled,
  chaptersForProject,
  closeChapter,
  createChapter,
  deleteChapter,
  nextChapterAfter,
  pagesInChapter,
  publicChapter,
  setChaptersEnabled,
  updateChapter,
} from "./repository/chapters";
export type {
  ChapterCloseResult,
  ChapterInput,
  CreateChapterResult,
  UpdateChapterResult,
} from "./repository/chapters";

export {
  clearGithubStatus,
  githubStatusesForProject,
  projectGithubConfig,
  saveGithubStatus,
  setProjectGithub,
} from "./repository/github";
export type { ProjectGithubConfig } from "./repository/github";

export {
  archivePage,
  createPage,
  findPage,
  getBoard,
  listPages,
  restorePage,
  updatePage,
} from "./repository/pages";

export { EditConflictError, PageDependencyError, requireUnchangedContent } from "./repository/errors";
