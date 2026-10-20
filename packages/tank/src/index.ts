export {
  ensureClone,
  type GitEnv,
  type WorktreeInfo,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "./git.js"
export {
  type BaseEnv,
  buildBotEnv,
  makeBotTank,
  makeTankLocal,
  slugRepoUrl,
  type TankLayout,
  type TankLocalConfig,
  TankLocalLive,
} from "./local.js"
export { type BotOps, localOps } from "./ops.js"
export {
  type ProcessOptions,
  type RunOptions,
  runProcess,
  spawnProcess,
  type TrackedProcess,
  trackedProcesses,
} from "./process.js"
export { BOT_HOMES_ROOT, makeTankServer, type TankServerConfig, TankServerLive } from "./server.js"
export { botUserName, type LaunchPlan, planLaunch, type SudoRequest, sudoArgv, sudoRefusal } from "./sudo.js"
export {
  type ExecOptions,
  type ExecResult,
  type OwnedWorktree,
  type RunningProcess,
  Tank,
  type TankContext,
  type TankShape,
} from "./tank.js"
