#!/usr/bin/env node
// Set (or rotate) the dashboard username + password used by the browser login.
//
// The password is hashed with scrypt using Node's default parameters -- the
// SAME primitive as verifyPassword() in src/web/dashboard-auth.ts -- so the
// stored hash validates there without a rebuild. The plaintext password is
// never written anywhere; it is read from STDIN (not argv) so it does not land
// in the process list or shell history.
//
// Usage:
//   node scripts/dashboard-set-credentials.mjs <username>
//     -> prompts for the password on stdin (piped or typed)
//   printf '%s' 'the-strong-password' | node scripts/dashboard-set-credentials.mjs <username>
//   node scripts/dashboard-set-credentials.mjs <username> --generate
//     -> generates a strong random password, prints it ONCE, stores its hash
//
// Takes effect immediately on a running server: the auth module reloads the
// credentials file on the next verify (no restart needed).

import { randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRYPT_KEYLEN = 64
const MIN_PASSWORD_LENGTH = 12

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRED_PATH = join(ROOT, 'store', '.dashboard-credentials.json')

const username = (process.argv[2] || '').trim()
if (!username) {
  console.error('usage: node scripts/dashboard-set-credentials.mjs <username> [--generate]')
  process.exit(2)
}
const generate = process.argv.includes('--generate')

// A readable, strong generated password (avoids ambiguous chars).
function genPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(24)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  // group into 4x6 for readability
  return out.match(/.{1,6}/g).join('-')
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf-8')
}

function store(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`ERROR: password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    process.exit(1)
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN)
  const rec = {
    username,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: Math.floor(Date.now() / 1000),
  }
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  const tmp = CRED_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
  renameSync(tmp, CRED_PATH)
  console.log(`OK: credentials written for user "${username}" -> ${CRED_PATH} (0600)`)
}

if (generate) {
  const pw = genPassword()
  store(pw)
  console.log('')
  console.log('Generated password (shown once -- copy it now):')
  console.log('  ' + pw)
} else {
  const raw = await readStdin()
  // Trim only a single trailing newline (allow spaces inside the password).
  const password = raw.replace(/\r?\n$/, '')
  store(password)
}
