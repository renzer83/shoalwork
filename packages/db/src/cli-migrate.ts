import { Cause, Console, Effect, Exit } from "effect"
import { DbLive } from "./client.js"
import { runMigrations } from "./migrator.js"

// Reads DATABASE_PATH (default ./data/shoalwork.db) through DbLive.
const program = Effect.gen(function* () {
  const applied = yield* runMigrations
  if (applied.length === 0) {
    yield* Console.log("applied: none")
  }
  for (const name of applied) {
    yield* Console.log(`applied: ${name}`)
  }
}).pipe(Effect.provide(DbLive))

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit)) {
  await Effect.runPromise(Console.error(Cause.pretty(exit.cause)))
  process.exitCode = 1
}
