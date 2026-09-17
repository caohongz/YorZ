/**
 * Windows 后台 Service 的中间 launcher（CommonJS，不参与打包，构建时原样复制到
 * dist/cli/）。
 *
 * 为什么需要它：后台 worker 若以 DETACHED_PROCESS 直接启动，进程没有任何控制台，
 * 它内部 SDK 裸 spawn 的 console 子程序（codex / opencode server 等）会被
 * Windows 分配**可见**控制台——这就是启动服务 / 切 session 时闪现空白 cmd 弹窗
 * 的根源。
 *
 * 解法：launcher 用 CREATE_NO_WINDOW（Node 的 windowsHide + 非 detached）拉起
 * worker。CREATE_NO_WINDOW 的进程持有一个"无窗口的控制台"，worker 内 SDK 裸
 * spawn 的 console 子程序继承它，不再新建可见窗口。
 *
 * launcher 随后**驻留为 worker 的父进程守卫**：不主动退出，直到 worker 退出才
 * 退出（并把 worker 的退出状态写入 stderr，即 serve-stdio.log）。这样 worker
 * 始终是有父进程的普通子进程，不依赖"孤儿进程在各类终端/安全软件环境下能否
 * 存活"的语义差异；`yorz serve stop` 终止 worker 后 launcher 自然退出，不残留。
 * 代价是常驻一个空闲的 node 进程。
 *
 * 用法：node serve-launcher.cjs -- <execPath> <workerArgs...>
 * worker 的 stdio 通过 'inherit' 接管 launcher 的 fd 0/1/2，而 launcher 自身的
 * stdio 由调用方（serve.ts）定向到服务日志文件——worker 的未捕获输出因此仍落
 * 到 serve-stdio.log，与旧的直接传 fd 语义一致。
 *
 * 已知坑（实测）：worker 的 stdio 不能用 `stdio: ['ignore', 1, 2]` 数字 fd
 * 形式——Windows 上该路径的 handle 传递会让 worker 静默死在初始化阶段；
 * 'inherit' 走 libuv 的专门路径，实测正常。
 */
'use strict'

const { spawn } = require('child_process')

const sep = process.argv.indexOf('--')
const workerArgv = sep === -1 ? [] : process.argv.slice(sep + 1)
if (workerArgv.length < 2) {
  process.stderr.write('[serve-launcher] missing worker argv after "--"\n')
  process.exit(1)
}
// workerArgv 形如 [execPath, ...args]；spawn 的 file 与 args 必须拆开——
// 若把 execPath 留在 args 里，node 会把它当作脚本路径执行而立即失败。
const [workerExecutable, ...workerArgs] = workerArgv

// 关键：非 detached + windowsHide => CREATE_NO_WINDOW => worker 拥有无窗口控制台。
const child = spawn(workerExecutable, workerArgs, {
  windowsHide: true,
  stdio: 'inherit',
})
child.once('error', (err) => {
  process.stderr.write(`[serve-launcher] failed to start worker: ${err}\n`)
  process.exit(1)
})
child.once('exit', (code, signal) => {
  // worker 无论正常停止还是崩溃，launcher 都随之退出，保持父进程树干净。
  process.stderr.write(`[serve-launcher] worker exited code=${code} signal=${signal}\n`)
  process.exit(0)
})
