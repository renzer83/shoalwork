import type { NewBot, NewTide, SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { loadBotEntries } from "./loader.js"

// A factory template: a Bot whose name is the role, plus the Tides the role runs. The same file shape as a
// regular bots/*.yaml (a NewBot plus optional `tides:`), so the loader validates every field.
export interface BotTemplate {
  readonly bot: NewBot
  readonly tides: ReadonlyArray<NewTide>
}

export interface InstantiateOptions {
  // Filesystem-safe project slug; the instantiated name is `<role>-<project>` (e.g. worker-sandbox).
  readonly project: string
  // Fields that win over the template. The name is always derived and cannot be overridden.
  readonly overrides?: Partial<NewBot>
}

// Instantiates a template for one project. The name is `<role>-<project>`; overrides win over the template
// fields, but never over the derived name.
export const instantiate = (template: BotTemplate, options: InstantiateOptions): NewBot => ({
  ...template.bot,
  ...options.overrides,
  name: `${template.bot.name}-${options.project}`,
})

// Loads every template of a directory (bots/templates): each file is a Bot named by its role, plus its tides.
export const loadTemplates = (dir: string): Effect.Effect<ReadonlyArray<BotTemplate>, SchemaViolation> =>
  Effect.map(loadBotEntries(dir), (entries) => entries.map(({ bot, tides }) => ({ bot, tides })))
