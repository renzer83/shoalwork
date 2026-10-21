import { readFileSync } from "node:fs"
import { DbLive, runMigrations } from "@shoalwork/db"
import { computeBaseline, importFactoryExport } from "@shoalwork/factory"
import { Cause, Console, Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { parseArgs, UsageError } from "../args.js"

const toUsageError = (cause: unknown): UsageError =>
  cause instanceof UsageError ? cause : new UsageError({ message: Cause.pretty(Cause.fail(cause)) })

const readExport = (file: string): Effect.Effect<unknown, UsageError> =>
  Effect.try({
    try: (): unknown => JSON.parse(readFileSync(file, "utf8")),
    catch: (cause: unknown) =>
      new UsageError({
        message: `cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

// Local commands: they operate on the SQLite database (DATABASE_PATH) directly, never on the API.
const provideDb = <A, E>(effect: Effect.Effect<A, E, SqlClient>): Effect.Effect<A, UsageError> =>
  effect.pipe(
    Effect.provide(DbLive),
    Effect.catch((cause) => Effect.fail(toUsageError(cause))),
  )

const factoryImport = (file: string): Effect.Effect<void, UsageError> =>
  provideDb(
    Effect.gen(function* () {
      yield* runMigrations
      const input = yield* readExport(file)
      const report = yield* importFactoryExport(input)
      yield* Console.log(JSON.stringify(report))
    }),
  )

// One baseline snapshot per project (plus "global" when no --project is given), printed as a table.
const factoryBaseline = (project: string | undefined): Effect.Effect<void, UsageError> =>
  provideDb(
    Effect.gen(function* () {
      yield* runMigrations
      const sql = yield* SqlClient
      const scopes =
        project === undefined
          ? [
              "global",
              ...(yield* sql<{ readonly slug: string }>`SELECT slug FROM projects ORDER BY slug`).map(
                (row) => row.slug,
              ),
            ]
          : [project]
      const rows = (yield* Effect.forEach(scopes, (scope) => computeBaseline(scope), {
        concurrency: 1,
      })).flat()
      const width = Math.max(...rows.map((row) => row.project.length), "project".length)
      yield* Console.log(`${"project".padEnd(width)}  metric  value`)
      for (const row of rows) {
        yield* Console.log(`${row.project.padEnd(width)}  ${row.metric}  ${Number(row.value.toFixed(2))}`)
      }
    }),
  )

export const factoryCommand = (argv: ReadonlyArray<string>): Effect.Effect<void, UsageError> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "import":
      return Effect.gen(function* () {
        const { positionals } = yield* parseArgs(rest, [])
        const [file, ...extra] = positionals
        if (file === undefined || extra.length > 0) {
          return yield* Effect.fail(new UsageError({ message: "usage: factory import <file>" }))
        }
        yield* factoryImport(file)
      })
    case "baseline":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, ["project"])
        yield* factoryBaseline(flags.project)
      })
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? "missing factory subcommand (import|baseline)"
              : `unknown factory subcommand: ${sub}`,
        }),
      )
  }
}
