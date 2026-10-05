import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ADMIN, DATABASE_URL, DEMO_ORIGIN, HERALD_URL, POSTGRES, STATE_FILE, type HarnessState } from './harness'

// Runs a real Herald from source (HERALD_DIR, default ../herald) against a
// throwaway Postgres container.
const heraldDir = resolve(process.env.HERALD_DIR ?? '../herald')
const work = resolve('.e2e')
const bin = (name: string) => resolve(work, 'bin', name)

function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: 'utf8',
  })
}

function field(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}:\\s*(\\S+)`, 'm'))
  if (!match) throw new Error(`heraldctl output has no ${name}:\n${output}`)
  return match[1]
}

function removePostgres() {
  try {
    execFileSync('docker', ['rm', '-f', POSTGRES.container], { stdio: 'ignore' })
  } catch {
    // not running
  }
}

function startPostgres() {
  removePostgres()
  run('docker', [
    'run', '-d', '--rm', '--name', POSTGRES.container,
    '-e', 'POSTGRES_USER=herald', '-e', 'POSTGRES_PASSWORD=herald', '-e', 'POSTGRES_DB=herald',
    '-p', `${POSTGRES.port}:5432`, 'postgres:17-alpine',
  ])
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      // The image's first-boot server listens only on its socket; TCP answers
      // once the real server is up.
      run('docker', ['exec', POSTGRES.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'herald'])
      return
    } catch {
      execFileSync('sleep', ['1'])
    }
  }
  throw new Error('Postgres container did not become ready')
}

async function waitForHealth(child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Herald exited with ${child.exitCode}; see .e2e/herald.log`)
    try {
      if ((await fetch(`${HERALD_URL}/health`)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('Herald did not become healthy; see .e2e/herald.log')
}

export default async function globalSetup() {
  mkdirSync(resolve(work, 'bin'), { recursive: true })
  run('go', ['build', '-o', resolve(work, 'bin'), './cmd/herald', './cmd/heraldctl'], { cwd: heraldDir })

  startPostgres()

  const env = {
    DATABASE_URL: DATABASE_URL,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  }
  run(bin('heraldctl'), ['migrate'], { env })
  run(bin('heraldctl'), ['create-application', '-slug', 'demo', '-name', 'Demo', '-origin', DEMO_ORIGIN, '-subject', 'mailto:e2e@herald.test'], { env })
  const producer = run(bin('heraldctl'), ['create-producer', '-application', 'demo', '-name', 'e2e'], { env })
  const passwordHash = run(bin('heraldctl'), ['hash-password'], { input: `${ADMIN.password}\n` }).trim()

  const child = spawn(bin('herald'), [], {
    env: {
      ...process.env,
      ...env,
      PORT: new URL(HERALD_URL).port,
      ENV: 'development',
      LOG_LEVEL: 'debug',
      CORS_ALLOWED_ORIGINS: DEMO_ORIGIN,
      ADMIN_ORIGIN: ADMIN.origin,
      ADMIN_USERNAME: ADMIN.username,
      ADMIN_PASSWORD_HASH: passwordHash,
      WEBPUSH_DISPATCH_INTERVAL: '250ms',
      EXPIRY_SWEEP_INTERVAL: '1s',
    },
    stdio: ['ignore', openSync(resolve(work, 'herald.log'), 'w'), openSync(resolve(work, 'herald.log'), 'a')],
  })
  await waitForHealth(child)

  const state: HarnessState = { producerToken: field(producer, 'token') }
  writeFileSync(STATE_FILE, JSON.stringify(state))

  return async () => {
    child.kill('SIGTERM')
    await new Promise((done) => child.once('exit', done))
    removePostgres()
  }
}
