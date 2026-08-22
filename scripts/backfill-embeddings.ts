// One-shot embedding backfill (card ollama-hybrid-genesis, P2).
//
// New memories already get embedded fire-and-forget in saveAgentMemory, but rows
// created before that pipeline (or while Ollama was down) still have a NULL
// embedding and are invisible to vector search. This embeds them against the
// local Ollama (nomic-embed-text) so hybrid search covers the whole vault.
//
// Run once after the model is pulled:  npm run backfill-embeddings

import { initDatabase, backfillEmbeddings, getMemoryStats } from '../src/db.js'

async function main(): Promise<void> {
  initDatabase()
  const before = getMemoryStats()
  const missing = before.total - before.withEmbedding
  console.log(`Memories: ${before.total} total, ${before.withEmbedding} embedded, ${missing} missing embedding.`)
  if (missing === 0) {
    console.log('Nothing to backfill.')
    return
  }

  const started = Date.now()
  const r = await backfillEmbeddings({
    onProgress: (done, total) => {
      if (done === total || done % 10 === 0) process.stdout.write(`\r  embedding ${done}/${total} ...`)
    },
  })
  process.stdout.write('\n')

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `Done in ${secs}s: ${r.succeeded} embedded, ${r.failed} failed` +
      `${r.aborted ? ' (ABORTED -- embedder unreachable)' : ''} of ${r.total}.`,
  )
  if (r.aborted) process.exitCode = 1
}

main().catch((err) => {
  console.error('backfill failed:', err)
  process.exit(1)
})
