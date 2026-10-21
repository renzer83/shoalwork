import type { SchemaViolation } from "@shoalwork/contracts"
import { Console, Effect, Schema } from "effect"
import { type Flags, parseArgs, resolveSettings, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

export type ProjectCommandError = UsageError | HttpError | SchemaViolation

const SETTINGS_FLAGS = ["url", "token"]

// Mirrors the /projects routes (services/core/src/http/routes/projects.ts).
const Project = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  repoUrl: Schema.String,
  defaultBranch: Schema.String,
  status: Schema.String,
  maxInProgress: Schema.Int,
})
const ProjectList = Schema.Struct({ projects: Schema.Array(Project) })
const ProjectCreated = Schema.Struct({ project: Project })
const SyncDone = Schema.Struct({
  report: Schema.Struct({ project: Schema.String, applied: Schema.Int, skipped: Schema.Int }),
})

export type ProjectType = typeof Project.Type
export type SyncReportType = (typeof SyncDone.Type)["report"]

// Body of POST /projects. The schema is the single check on the values before they cost a request.
const NewProjectBody = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  repoUrl: Schema.String,
  defaultBranch: Schema.String,
  maxInProgress: Schema.optionalKey(Schema.Int),
})

const DEFAULT_BASE = "main"

const requireFlags = (flags: Flags): Effect.Effect<void, UsageError> =>
  Effect.gen(function* () {
    if (flags.slug === undefined || flags.name === undefined || flags.repo === undefined) {
      return yield* Effect.fail(
        new UsageError({
          message:
            "usage: project add --slug <slug> --name <name> --repo <url> [--base <branch>] [--max <n>]",
        }),
      )
    }
  })

const buildProject = (flags: Flags): Effect.Effect<typeof NewProjectBody.Type, UsageError> => {
  const body = {
    slug: flags.slug,
    name: flags.name,
    repoUrl: flags.repo,
    defaultBranch: flags.base ?? DEFAULT_BASE,
    ...(flags.max === undefined ? {} : { maxInProgress: Number(flags.max) }),
  }
  return Schema.decodeUnknownEffect(NewProjectBody)(body).pipe(
    Effect.mapError((error) => new UsageError({ message: `invalid project: ${error.message}` })),
  )
}

export const projectAdd = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<ProjectType, ProjectCommandError> =>
  Effect.gen(function* () {
    yield* requireFlags(flags)
    const body = yield* buildProject(flags)
    const created = yield* new ApiClient(settings.url, settings.token).post("/projects", body, ProjectCreated)
    return created.project
  })

export const projectList = (
  settings: Settings,
): Effect.Effect<ReadonlyArray<ProjectType>, ProjectCommandError> =>
  Effect.gen(function* () {
    const list = yield* new ApiClient(settings.url, settings.token).get("/projects", ProjectList)
    return list.projects
  })

export const projectSync = (
  settings: Settings,
  slug: string,
): Effect.Effect<SyncReportType, ProjectCommandError> =>
  Effect.gen(function* () {
    const done = yield* new ApiClient(settings.url, settings.token).post(
      `/projects/${encodeURIComponent(slug)}/sync`,
      {},
      SyncDone,
    )
    return done.report
  })

const PROJECT_SUBCOMMANDS = "add|list|sync"

export const projectCommand = (argv: ReadonlyArray<string>): Effect.Effect<void, ProjectCommandError> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "add":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, ["slug", "name", "repo", "base", "max", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* projectAdd(settings, flags)))
      })
    case "list":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* projectList(settings), null, 2))
      })
    case "sync":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const [slug, ...extra] = positionals
        if (slug === undefined || extra.length > 0) {
          return yield* Effect.fail(new UsageError({ message: "usage: project sync <slug>" }))
        }
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* projectSync(settings, slug)))
      })
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? `missing project subcommand (${PROJECT_SUBCOMMANDS})`
              : `unknown project subcommand: ${sub}`,
        }),
      )
  }
}
