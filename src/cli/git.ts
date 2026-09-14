/**
 * 仓库级 git 能力已下沉到 service 层（`src/service/git-repo.ts`），供 CLI 与
 * HTTP 路由共用。此处保留再导出，避免改动全部 CLI 调用点。
 */
export { isGitRepo, runGitInit, type RunGitInitOptions } from '../service/git-repo.js'
