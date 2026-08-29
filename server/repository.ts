// The persistence facade: everything server code reads or writes about users,
// projects, categories, fields, members, chapters, GitHub links and pages lives
// in the modules under server/repository/, and this file only re-exports their
// public surface so existing import sites keep working. As route modules are
// carved out of app.ts, import the submodule directly instead of this facade.

export type { CreateCategoryResult } from "./repository/categories";
export {
  categoriesForProject,
  categorySlugFromName,
  createCategory,
  deleteCategory,
  updateCategory,
} from "./repository/categories";
export type {
  ChapterCloseResult,
  ChapterInput,
  CreateChapterResult,
  UpdateChapterResult,
} from "./repository/chapters";
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
export { EditConflictError, PageDependencyError, requireUnchangedContent } from "./repository/errors";
export type { CreateFieldResult, FieldInput, UpdateFieldResult } from "./repository/fields";
export {
  createField,
  deleteField,
  fieldKeyFromLabel,
  fieldsForProject,
  mergePageFields,
  updateField,
} from "./repository/fields";
export type { ProjectGithubConfig } from "./repository/github";
export {
  clearGithubStatus,
  githubStatusesForProject,
  projectGithubConfig,
  saveGithubStatus,
  setProjectGithub,
} from "./repository/github";
export type { AddProjectMemberResult, RemoveMemberResult, SetMemberRoleResult } from "./repository/members";
export {
  addProjectMember,
  membersForProject,
  removeProjectMember,
  setMemberRole,
} from "./repository/members";
export {
  archivePage,
  createPage,
  findPage,
  getBoard,
  listPages,
  restorePage,
  updatePage,
} from "./repository/pages";
export type { ArchiveProjectResult, RecapConfig } from "./repository/projects";
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
