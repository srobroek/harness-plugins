import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backoffDelayMs, type LeaseRecord, leaseAbandoned, withLease } from "./lease-lock.ts"

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "lease-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOST = "this-host"
const record = (over: Partial<LeaseRecord> = {}): LeaseRecord => ({
  host: HOST,
  pid: process.pid,
  owner: "someone",
  token: "theirs",
  taken: Date.now(),
  expires: Date.now() + 60_000,
  ...over,
})
const plant = (path: string, value: LeaseRecord | string) =>
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
const tokenOf = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as LeaseRecord).token
/** A promise and the function that settles it, for ordering concurrent steps by state instead of by sleeps. */
const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}
const recordExpires = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as LeaseRecord).expires
/**
 * `waitMs` is a wall-clock deadline `withLease` checks after every takeover attempt, so a starved runner that
 * overruns it turns a takeover that worked into a "busy" failure. A test that expects the lock to be gotten
 * therefore waits PATIENT (success returns at once, so it costs nothing); a test that expects "busy" waits
 * NO_WAIT, so its verdict does not depend on how long the wait is.
 */
const RENEWAL_CAP_MS = 2000
const PATIENT = 60_000
const NO_WAIT = 1
const base = { owner: "test", host: HOST, leaseMs: 60_000, waitMs: PATIENT }

describe("leaseAbandoned", () => {
  const facts = { now: 1000, host: HOST, alive: () => true, leaseMs: 100, ageMs: 0 }
  const rows: Array<[string, LeaseRecord | undefined, Partial<typeof facts>, boolean]> = [
    ["a holder on this host whose pid is gone: abandoned at once", record({ expires: 9999 }), { alive: () => false }, true],
    ["a live holder with an unexpired lease", record({ expires: 9999 }), {}, false],
    ["a live holder whose lease nobody renewed", record({ expires: 500 }), {}, true],
    ["another host, unexpired: the pid says nothing about it", record({ host: "other", expires: 9999 }), { alive: () => false }, false],
    ["another host, expired", record({ host: "other", expires: 500 }), {}, true],
    ["an unparseable record older than one lease", undefined, { ageMs: 101 }, true],
    ["an unparseable record younger than one lease", undefined, { ageMs: 50 }, false],
  ]
  for (const [name, rec, over, expected] of rows) {
    test(name, () => expect(leaseAbandoned(rec, { ...facts, ...over })).toBe(expected))
  }
})

test("backoff is jittered between half and the full delay, and capped", () => {
  expect(backoffDelayMs(0, () => 0)).toBe(10)
  expect(backoffDelayMs(0, () => 0.999)).toBe(20)
  expect(backoffDelayMs(30, () => 0.999)).toBe(400)
})

describe("withLease", () => {
  test("runs the work under the lock and removes it afterwards", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    let during = ""
    const out = await withLease(lock, base, () => {
      during = tokenOf(lock)
      return 7
    })
    expect(out).toEqual({ kind: "done", value: 7 })
    expect(during).not.toBe("")
    expect(() => readFileSync(lock)).toThrow()
  })

  test("releases when the work throws", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    await expect(
      withLease(lock, base, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect((await withLease(lock, base, () => 1)).kind).toBe("done")
  })

  test("a second holder waits for the first", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    const order: string[] = []
    const firstIn = gate()
    const release = gate()
    const secondWaiting = gate()
    const first = withLease(lock, base, async () => {
      order.push("a-in")
      firstIn.open()
      await release.opened
      order.push("a-out")
    })
    await firstIn.opened
    const second = withLease(
      lock,
      {
        ...base,
        // The second holder sleeps only after it found the lock busy, so its first sleep proves it is waiting.
        sleep: async (ms) => {
          secondWaiting.open()
          await new Promise((done) => setTimeout(done, ms))
        },
      },
      () => {
        order.push("b-in")
      },
    )
    await secondWaiting.opened
    release.open()
    await Promise.all([first, second])
    expect(order).toEqual(["a-in", "a-out", "b-in"])
  })

  test("a live, unexpired hold is kept: the waiter gives up busy and the hold is untouched", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, record())
    const out = await withLease(lock, { ...base, waitMs: NO_WAIT }, () => 1)
    expect(out).toMatchObject({ kind: "failed", busy: true })
    expect(tokenOf(lock)).toBe("theirs")
  })

  test("a holder on this host whose pid is gone is taken over at once", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, record({ pid: 999_999, token: "dead" }))
    const out = await withLease(lock, { ...base, alive: () => false }, () => tokenOf(lock))
    expect(out.kind).toBe("done")
    expect(out.kind === "done" && out.value).not.toBe("dead")
  })

  test("an expired lease is taken over even though the holder's pid is alive", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, record({ host: "other", expires: Date.now() - 1000 }))
    expect((await withLease(lock, base, () => 1)).kind).toBe("done")
  })

  test("an unparseable record is judged by its age", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, "{not json")
    expect((await withLease(lock, { ...base, waitMs: NO_WAIT }, () => 1)).kind).toBe("failed")
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    expect((await withLease(lock, base, () => 1)).kind).toBe("done")
  })

  test("a path that is not a regular file is never judged or taken over", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    mkdirSync(lock)
    const out = await withLease(lock, base, () => 1)
    expect(out).toMatchObject({ kind: "failed" })
  })

  test("the heartbeat renews the lease, so a long hold is not taken over while its holder works", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    const inside = gate()
    const done = gate()
    // Lease time is this injected clock, never the wall clock, so a starved runner cannot lapse the lease.
    let clock = Date.now()
    const now = () => clock
    const leaseMs = 80
    let holderToken = ""
    const holder = withLease(lock, { ...base, now, leaseMs, renewMs: 15 }, async () => {
      holderToken = tokenOf(lock)
      inside.open()
      await done.opened
    })
    await inside.opened
    // Three renewals in a row. Each round puts the clock past the current expiry, so only a renewal can keep
    // the hold alive; waiting for the expiry to move is waiting for that renewal. The cap only bounds a
    // heartbeat that stopped (a 15 ms heartbeat has 2 s to run once); a healthy one never gets near it.
    let expiry = recordExpires(lock)
    for (let round = 0; round < 3; round++) {
      clock = expiry + 1
      const capped = Date.now() + RENEWAL_CAP_MS
      while (recordExpires(lock) <= expiry) {
        if (Date.now() >= capped) throw new Error(`no renewal within ${RENEWAL_CAP_MS} ms (round ${round})`)
        await new Promise((tick) => setTimeout(tick, 5))
      }
      expect(recordExpires(lock)).toBeGreaterThan(expiry)
      expiry = recordExpires(lock)
      // The lease it started with is over, but renewed: a contender on the same clock must fail busy.
      // NO_WAIT ends its wait at once; the verdict is the same however long it would wait.
      const contender = await withLease(lock, { ...base, now, leaseMs, waitMs: NO_WAIT }, () => "stolen")
      expect(contender).toMatchObject({ kind: "failed", busy: true })
      expect(tokenOf(lock)).toBe(holderToken)
    }
    done.open()
    await holder
  })

  test("an owner whose lease lapsed cannot unlink or overwrite its successor", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    let successorToken = ""
    let seenAfterRelease = ""
    const stalledIn = gate()
    const stalledRelease = gate()
    const successorIn = gate()
    const successorRelease = gate()
    // Lease time is an injected clock: the stalled owner's lease lapses when the test says so, not after 40 wall ms.
    let clock = Date.now()
    const now = () => clock
    const stalled = withLease(lock, { ...base, now, leaseMs: 40, renewMs: 60_000 }, async () => {
      // No renewals: the lease lapses while this owner is stalled, until the successor holds the lock.
      stalledIn.open()
      await stalledRelease.opened
    })
    await stalledIn.opened
    clock += 41
    const successor = withLease(lock, { ...base, now, leaseMs: 60_000 }, async () => {
      successorToken = tokenOf(lock)
      successorIn.open()
      await successorRelease.opened
    })
    await successorIn.opened
    // The stalled owner releases in the middle of the successor's hold.
    stalledRelease.open()
    await stalled
    seenAfterRelease = tokenOf(lock)
    successorRelease.open()
    await successor
    expect(successorToken).not.toBe("")
    // The stalled owner released in the middle of the successor's hold, found a token that is not its
    // own, and left the file alone.
    expect(seenAfterRelease).toBe(successorToken)
  })

  test("re-entrant along one call chain: the inner call does not wait on the outer", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    const out = await withLease(lock, base, async () => (await withLease(lock, base, () => "inner")).kind)
    expect(out).toEqual({ kind: "done", value: "done" })
  })

  describe("forced interleavings", () => {
    test("a waiter that judged a hold abandoned cannot unlink the fresh hold a faster one created", async () => {
      const dir = scratch()
      const lock = join(dir, "a.lock")
      plant(lock, record({ host: "other", expires: Date.now() - 1000, token: "old" }))
      const out = await withLease(lock, {
        ...base,
        waitMs: NO_WAIT,
        seams: {
          // Between B judging the old hold abandoned and B opening the steal lock, A completes its own
          // takeover and holds a fresh lease (planted synchronously, as A's takeover would leave it).
          afterJudged: () => {
            writeFileSync(lock, JSON.stringify(record({ token: "fresh-from-A" })))
          },
        },
      }, () => "B ran")
      expect(out).toMatchObject({ kind: "failed", busy: true })
      expect(tokenOf(lock)).toBe("fresh-from-A")
    })

    test("steal-lock contention during a takeover: a live steal lock is neither cleared nor bypassed", async () => {
      const dir = scratch()
      const lock = join(dir, "a.lock")
      const steal = `${lock}.steal`
      plant(lock, record({ host: "other", expires: Date.now() - 1000, token: "stale" }))
      plant(steal, record({ token: "someone-mid-takeover" }))
      const out = await withLease(lock, { ...base, waitMs: NO_WAIT }, () => "ran")
      expect(out).toMatchObject({ kind: "failed", busy: true })
      expect(tokenOf(steal)).toBe("someone-mid-takeover")
      expect(tokenOf(lock)).toBe("stale")
    })

    test("a steal lock whose holder crashed is cleared like any abandoned hold, and the takeover then goes through", async () => {
      const dir = scratch()
      const lock = join(dir, "a.lock")
      const steal = `${lock}.steal`
      plant(lock, record({ host: "other", expires: Date.now() - 1000, token: "stale" }))
      plant(steal, record({ pid: 999_999, token: "crashed-stealer" }))
      const out = await withLease(lock, { ...base, alive: (pid) => pid !== 999_999 }, () => "ran")
      expect(out).toEqual({ kind: "done", value: "ran" })
    })
  })
})
