/** Reclaiming of scratch directories left behind by processes that exited without disposing their Sessions. */
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Prefix of every scratch directory a {@link TurnRecorder} creates under the temporary root. */
export const scratchPrefix = 'dsh-workspace-changes-'

/** Name of the file inside a scratch directory naming the process that owns it. */
export const leaseName = 'lease'

/**
 * Content of a scratch lease: the owning process id, then the milliseconds since the epoch it was written.
 * @param writtenAt - milliseconds since the epoch.
 * @returns the file content.
 */
export function leaseContent(writtenAt: number): string {
  return `${process.pid}\n${writtenAt}\n`
}

/**
 * Whether a process id currently exists. `EPERM` means it exists but belongs to another user.
 * @param pid - the id to probe.
 * @returns true when the process is still there.
 */
function isLiveProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The owner recorded by a scratch directory.
 * @param dir - the scratch directory.
 * @returns the owning process id, or null when no readable lease names one.
 */
async function readLease(dir: string): Promise<number | null> {
  let text: string
  try {
    text = await readFile(join(dir, leaseName), 'utf8')
  } catch {
    return null
  }
  const pid = Number.parseInt(text.trim().split('\n')[0] ?? '', 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** What one reclamation pass needs. */
export interface ReapOptions {
  /** Directory that receives each Session's scratch directory; the same root the recorders write to. */
  tempRoot: string
  /** Grace period for a directory carrying no lease, which covers one not yet claimed by its owner. */
  orphanTtlMs: number
  /** Failure reporter; an unreadable or busy directory is left in place. */
  warn: (message: string) => void
}

/** Counts of one reclamation pass. */
export interface ReapOutcome {
  /** Directories matching the prefix that were examined. */
  scanned: number
  /** Directories removed. */
  removed: number
}

/**
 * Remove the scratch directories under `tempRoot` whose owning process is gone. A Host that exits
 * abnormally never disposes its Sessions, so its directories would otherwise stay in the temporary
 * root forever; a lease written at creation names the owner, so a directory whose owner no longer
 * exists is reclaimed on the next load. A directory carrying no lease predates leases or has not
 * claimed itself yet, so it is only reclaimed once it is older than `orphanTtlMs`.
 * @param options - the root to scan, the grace period, and the failure reporter.
 * @returns how many directories were examined and removed.
 */
export async function reapStaleScratch(options: ReapOptions): Promise<ReapOutcome> {
  const { tempRoot, orphanTtlMs, warn } = options
  let names: string[]
  try {
    names = await readdir(tempRoot)
  } catch {
    return { scanned: 0, removed: 0 }
  }
  const candidates = names.filter(name => name.startsWith(scratchPrefix))
  const now = Date.now()
  let removed = 0
  for (const name of candidates) {
    const path = join(tempRoot, name)
    try {
      const owner = await readLease(path)
      if (owner !== null) {
        if (isLiveProcess(owner)) continue
      } else if (now - (await stat(path)).mtimeMs < orphanTtlMs) {
        continue
      }
      await rm(path, { recursive: true, force: true })
      removed += 1
    } catch (error: unknown) {
      warn(`workspace-changes: could not reclaim ${path}: ${String(error)}`)
    }
  }
  return { scanned: candidates.length, removed }
}
