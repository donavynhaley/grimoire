import { z } from "zod";
import {
  AGENT_TOKEN_SCOPES,
  BODY_MAX_LENGTH,
  CHAPTER_STATES,
  DISCUSSION_BODY_MAX_LENGTH,
  FIELD_TYPES,
  IDEA_STATES,
  PAGE_STATUSES,
  PROJECT_ROLES,
} from "../shared/types";
import { isCalendarDay } from "./markdown-chapters";

/*
 * Every request body and query string the API accepts, validated before any effect.
 *
 * The schemas are strict where the shape is small enough to enumerate, and every enum
 * derives from the tuple in shared/types rather than restating it. They live apart from
 * the routes so the contract can be read in one place - and so the routing layer stays
 * registration, not definition.
 */

export const accountSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
});

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
});

export const registerSchema = accountSchema.extend({
  inviteCode: z.string().min(20).max(200),
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .refine((input) => input.currentPassword !== input.newPassword, {
    message: "New password must be different from the current password",
    path: ["newPassword"],
  });

export const displayNameSchema = accountSchema.pick({ name: true });

/**
 * The provider settings screen, field by field.
 *
 * Every field is optional because the screen saves as it goes rather than as one form: an
 * operator pastes an address, checks it, pastes a client id, and each of those is a save. A
 * missing `clientSecret` therefore has to mean "leave the stored one alone" rather than
 * "clear it", or every other edit would silently forget the secret.
 */
export const oidcSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  issuer: z.string().trim().max(400).optional(),
  clientId: z.string().trim().max(300).optional(),
  clientSecret: z.string().trim().max(600).optional(),
  scopes: z.string().trim().max(300).optional(),
  label: z.string().trim().max(60).optional(),
  autoRegister: z.boolean().optional(),
  allowedEmailDomains: z.string().trim().max(500).optional(),
  redirectUri: z.string().trim().max(400).optional(),
  signupProject: z.string().trim().max(100).optional(),
});

export const oidcProbeSchema = z.object({
  issuer: z.string().trim().min(1).max(400),
  clientId: z.string().trim().max(300).optional(),
});

export const pageStatus = z.enum(PAGE_STATUSES);
export const categorySlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(40);
export const chapterSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(60);
export const calendarDay = z.string().refine(isCalendarDay, "Expected a YYYY-MM-DD day");
/**
 * Values for the project's own fields, as a patch. `null` clears one; an absent key is left
 * alone. The shapes are checked here and the meanings against the project's definitions,
 * because only the project knows what `priority` is allowed to say.
 */
export const pageFieldPatch = z.record(
  z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(40),
  z.union([z.string().trim().max(200), z.number().finite(), z.boolean(), z.null()]),
);
export const pageSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(BODY_MAX_LENGTH).optional(),
  category: categorySlug.nullable().optional(),
  chapter: chapterSlug.nullable().optional(),
  fields: pageFieldPatch.optional(),
  blockedBy: z.array(z.string().uuid()).max(20).optional(),
  status: pageStatus.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  // A whole number, because the page file's scalar parser reads nothing else back (SRV-1, ARCH-3).
  estimate: z.number().int().min(0).max(100_000).nullable().optional(),
});
/**
 * Compare-and-swap fields, sent only for the content a client is actually rewriting.
 * A save that omits them keeps the previous last-writer-wins behaviour, which is what
 * ordering and column moves want - a drag has no content to lose.
 */
export const contentPreconditions = {
  expectedTitle: z.string().trim().max(240).optional(),
  expectedDescription: z.string().trim().max(BODY_MAX_LENGTH).optional(),
};
export const pageUpdateSchema = pageSchema.partial().extend({
  /** A pasted reference - PR URL, #123, branch, or branch URL - or null to unlink. */
  github: z.string().trim().max(400).nullable().optional(),
  position: z.number().int().min(0).optional(),
  ...contentPreconditions,
});
export const projectSchema = z.object({
  name: z.string().trim().min(2).max(80),
});
export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(2000).optional(),
    chaptersEnabled: z.boolean().optional(),
    discordWebhook: z.string().trim().max(500).optional(),
    recapOnClose: z.boolean().optional(),
    githubRepo: z.string().trim().max(200).optional(),
    githubToken: z.string().trim().max(300).optional(),
    estimatesEnabled: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.chaptersEnabled !== undefined ||
      input.githubRepo !== undefined ||
      input.githubToken !== undefined ||
      input.estimatesEnabled !== undefined ||
      input.discordWebhook !== undefined ||
      input.recapOnClose !== undefined,
    { message: "Nothing to update" },
  );
export const chapterState = z.enum(CHAPTER_STATES);
export const chapterCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(BODY_MAX_LENGTH).optional(),
  startsOn: calendarDay.nullable().optional(),
  endsOn: calendarDay.nullable().optional(),
  state: chapterState.optional(),
});
/**
 * How a closing chapter disposes of what it did not finish. "next" is the planned chapter
 * after it, "release" sets the work loose, "keep" leaves it where it is, and a slug names
 * somewhere exactly.
 */
export const chapterCloseSchema = z.object({
  rollover: z.union([z.literal("next"), z.literal("release"), z.literal("keep"), chapterSlug]).optional(),
});
export const chapterUpdateSchema = chapterCreateSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  expectedDescription: z.string().trim().max(BODY_MAX_LENGTH).optional(),
});
export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(32),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export const categoryUpdateSchema = categoryCreateSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});
export const fieldCreateSchema = z.object({
  label: z.string().trim().min(1).max(40),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
  showOnTile: z.boolean().optional(),
});
/**
 * The type is here only so a choice field can change how it asks. Every other type change is
 * still refused - `updateField` settles which pairings are safe, since it is the one that
 * knows what the stored values would have to survive.
 */
export const fieldUpdateSchema = fieldCreateSchema
  .partial()
  .extend({ position: z.number().int().min(0).optional() });
export const ideaState = z.enum(IDEA_STATES);
export const ideaSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(BODY_MAX_LENGTH).optional(),
  state: ideaState.optional(),
});
export const ideaUpdateSchema = ideaSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  ...contentPreconditions,
});

export const memberRoleSchema = z.object({ role: z.enum(PROJECT_ROLES) }).strict();
/** Naming an account outright, because the alternative is listing everyone to choose from. */
export const memberAddSchema = z.object({ email: z.string().trim().email().max(320) }).strict();

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(240),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Query strings validate through zod like every body does; hand-rolled parsing drifted. */
export const activityQuerySchema = z.object({
  entity: z
    .string()
    .regex(/^[0-9a-z-]{1,64}$/i, "Invalid activity filter")
    .optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

export const eventsQuerySchema = z.object({
  client: z.string().max(100).optional(),
});

/**
 * One chapter is open at a time, so the second one has to be an explicit decision.
 * The interface turns this into a single confirm that closes the current chapter first.
 */
export const ALREADY_OPEN_MESSAGE = "Another chapter is already open. Close it before opening this one.";

/** Omitting the sequence means "advance to whatever is newest right now". */
export const seenSchema = z.object({ sequence: z.number().int().min(0).optional() }).strict();

export const discussionBodySchema = z
  .object({ body: z.string().trim().min(1).max(DISCUSSION_BODY_MAX_LENGTH) })
  .strict();
export const discussionAnswerSchema = z.object({ answered: z.boolean() }).strict();
export const agentTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(AGENT_TOKEN_SCOPES),
  /** Optional, because an agent that runs indefinitely is a legitimate thing to want. */
  expiresAt: z.string().datetime().nullable().optional(),
});
