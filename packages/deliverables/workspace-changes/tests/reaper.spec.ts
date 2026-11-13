/** Reclamation of scratch directories abandoned by an exited Host. */
import { spawn } from 'node:child_process'
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { leaseContent, leaseName, reapStaleScratch, scratchPrefix } from '../src/reaper.ts'
import { scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const warn = (): void => undefined

/** A scratch directory under the root, named as `mkdtemp` names one; the root's own cleanup removes it. */
async function scratchUnder(root: string, suffix: string): Promise<string> {
  const dir = join(root, `${scratchPrefix}${suffix}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** A process id that has exited, so its lease reads as abandoned. */
async function deadPid(): Promise<number> {
  const child = spawn('sh', ['-c', 'exit 0'])
  const exited = new Promise<number>((resolve) => { child.on('exit', () => { resolve(child.pid ?? 1) }) })
  return exited
}

describe('reapStaleScratch', () => {
  it('keeps a live owner, an unclaimed directory inside the grace period, and anything outside the prefix', async () => {
    const root = await scratchDir('dsh-reap-root-', cleanups)
    const live = await scratchUnder(root, 'live')
    await writeFile(join(live, leaseName), leaseContent(Date.now()))
    await scratchUnder(root, 'unclaimed-fresh')
    const other = join(root, 'not-a-scratch')
    await mkdir(other)
    cleanups.push(() => import('node:fs/promises').then(({ rm }) => rm(other, { recursive: true, force: true })))

    const outcome = await reapStaleScratch({ tempRoot: root, orphanTtlMs: 60_000, warn })
    expect(outcome).toEqual({ scanned: 2, removed: 0 })
    expect((await readdir(root)).sort()).toEqual(['dsh-workspace-changes-live', 'dsh-workspace-changes-unclaimed-fresh', 'not-a-scratch'])
  })

  it('reclaims a directory whose owning process has exited, whatever its age', async () => {
    const root = await scratchDir('dsh-reap-root-', cleanups)
    const abandoned = await scratchUnder(root, 'dead')
    await writeFile(join(abandoned, leaseName), `${await deadPid()}\n${Date.now()}\n`)
    const keep = await scratchUnder(root, 'live')
    await writeFile(join(keep, leaseName), leaseContent(Date.now()))

    const outcome = await reapStaleScratch({ tempRoot: root, orphanTtlMs: 7 * 24 * 60 * 60 * 1000, warn })
    expect(outcome).toEqual({ scanned: 2, removed: 1 })
    expect(await readdir(root)).toEqual(['dsh-workspace-changes-live'])
  })

  it('reclaims an unleased directory older than the grace period', async () => {
    const root = await scratchDir('dsh-reap-root-', cleanups)
    const stale = await scratchUnder(root, 'unleased-stale')
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(stale, longAgo, longAgo)

    const outcome = await reapStaleScratch({ tempRoot: root, orphanTtlMs: 7 * 24 * 60 * 60 * 1000, warn })
    expect(outcome).toEqual({ scanned: 1, removed: 1 })
    expect(await readdir(root)).toEqual([])
  })

  it('scans nothing when the temporary root cannot be read', async () => {
    const outcome = await reapStaleScratch({ tempRoot: '/dsh-reap-missing-root', orphanTtlMs: 1000, warn })
    expect(outcome).toEqual({ scanned: 0, removed: 0 })
  })
})
