import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** A reviewed source fixture makes E2E independent of repository visibility. */
export function brokerSource(work: string): string {
  if (process.env.HERALD_DIR) return resolve(process.env.HERALD_DIR)
  const archive = resolve('e2e/vendor/herald-source.tar.gz')
  const provenance = readFileSync(resolve('e2e/vendor/PROVENANCE.txt'), 'utf8')
  const expected = provenance.match(/^archive_sha256=([0-9a-f]{64})$/m)?.[1]
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (!expected || actual !== expected) throw new Error('Broker fixture checksum mismatch')
  const directory = resolve(work, 'broker-source')
  mkdirSync(directory, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', directory])
  return resolve(directory, 'herald')
}
