/* 端到端逻辑验证：用 esbuild 把源码打包后在 Node 中驱动 mock 适配器。
 * 覆盖：依据冻结、单页隔离、规则/截图失效、复议、跨窗口写锁+草稿、
 * 同修订原子生效、写入失败检查点恢复与幂等重放。 */
const { build } = require('esbuild')
const path = require('path')
const fs = require('fs')

const ENTRY = path.resolve(__dirname, 'e2e-entry.ts')
const OUT = path.resolve(__dirname, '.e2e-bundle.cjs')

async function main() {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUT,
    logLevel: 'silent',
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
    },
  })
  require(OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
