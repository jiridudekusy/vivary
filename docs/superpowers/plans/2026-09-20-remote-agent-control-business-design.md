# Business design: controlling sandboxed agents from anywhere

Status: design, not committed. Supersedes the framing of
`2026-09-15-paseo-in-sandbox-intent.md`, which is now the technical annex.

---

## 1. Why this exists

Coding agents work in long turns. You give one a task, it runs for ten or forty
minutes, and during that time there is nothing to do but wait — or leave, and
come back to find it finished, stuck, or blocked on a question nobody answered.

vivary already solved where those agents run: each sits in its own sandbox, with
its own workspace, its own logins, its own network policy. That was the safety
problem, and it is done.

What it did not solve is **reach**. A sandbox is driven from the Mac that
started it. Step away from the desk and the agents keep working but become
unreachable — you cannot see what they are doing, answer a permission prompt,
redirect a turn that went the wrong way, or start the next one.

The gap is not capability. It is presence.

## 2. Who this is for

**The owner** — one person, running several sandboxes at once, on their own
hardware, with their own subscriptions. Not a team product, not multi-tenant.
Every design choice follows from that: no accounts, no shared servers, no
vendor in the middle.

Their devices are a Mac (where the work is), a phone and an iPad (where they
are the rest of the time), all on one private network they already trust.

## 3. What we want to be true

> The owner can see and steer every sandboxed agent from whichever device is in
> their hand, without the work moving off their own machines.

Unpacked into what that means in practice:

- **Visible.** What is each agent doing right now — running, waiting, finished?
- **Steerable.** Answer it, redirect it, stop it, start the next one.
- **Reachable.** From the phone, the iPad, the couch, another city.
- **Private.** Nothing routes through anyone else's infrastructure.
- **Effortless to keep.** No per-device setup, no per-sandbox enrolment ritual.

## 4. How people would actually use it

Told as situations, because that is how the value shows up.

**S1 — The commute.** Work starts a refactor before leaving. On the train, opens
the phone, watches the turn stream, answers one question, lets it finish.

**S2 — The blocked agent.** An agent has been idle twenty minutes waiting for a
decision. A glance at the phone shows it; one reply unblocks it. Today that
silence lasts until the next time someone sits at the Mac.

**S3 — The idea at dinner.** Something occurs to them. They start an agent on it
from the phone rather than losing the thought or typing a note to themselves.

**S4 — The morning triage.** Several sandboxes ran overnight. One screen shows
which finished, which failed, which is still going.

**S5 — Getting in properly.** Sometimes the phone is not enough and they want a
real terminal from the iPad. The connection details are one tap away and the
device is already trusted.

S5 is worth calling out: it is the only one that works today, and only because
of the SSH and device-key work already done. The rest is the gap.

## 5. What we are not doing

- **Not a team tool.** One owner. Sharing, roles and audit are out of scope.
- **Not a new client.** No app of our own for phone or desktop; existing ones
  are better than anything worth building here.
- **Not moving the work.** Agents keep running in their sandboxes on the owner's
  machines. This is about reach, not relocation.
- **Not replacing the desk.** The Mac stays the place for real work. Remote is
  for watching, answering and starting — not for a full day's coding.
- **Not creating sandboxes remotely.** Deliberate, already decided: a workspace
  is a raw host-directory mount, which is too much authority to hand to whatever
  reaches the network. Creation stays at the Mac.

## 6. The approach, in business terms

Buy the reach, keep the control.

An existing open-source project (Paseo) already provides exactly the missing
half: phone, tablet and desktop clients for driving coding agents, self-hosted,
no vendor backend, and it speaks to agents over the private network the owner
already runs. Building an equivalent would be months and would be worse.

vivary's part is to make a sandbox a place that software can talk to — the same
job it already does for SSH — so those clients see a sandbox as just another
machine of the owner's.

The split matters: **we own the sandbox and its boundary; they own the
experience.** If the third-party client turns out to be wrong, the sandbox-side
work is not wasted — it is the same plumbing any other client would need.

## 7. What it costs

Roughly half a day of build, on top of machinery that already exists (per-
sandbox ports, tailnet publishing, SSH, device keys). It is small because the
foundations were laid by other work, not because the feature is trivial.

The ongoing costs are the honest ones to weigh:

- **A dependency on someone else's project.** Their release cadence, their
  decisions, their security posture.
- **A new way in.** Every sandbox becomes reachable from more places. That is
  the point, and it is also the risk — it has to be authenticated and encrypted
  by construction, never as a later hardening pass.
- **Resource appetite.** More things running in each sandbox, on a machine that
  has already been pushed to its memory limit this month.

## 8. How we will know it worked

- The owner answers a blocked agent from the phone, and it was faster than
  walking to the Mac.
- A week passes without opening a sandbox from anywhere but the phone at least
  once.
- No sandbox becomes reachable without authentication, and nothing is exposed
  beyond the owner's own private network.
- Adding a new device is one action, not one per sandbox.
- If the third-party client were removed tomorrow, the sandbox-side work would
  still stand on its own.

## 9. Open decision

**Does the chosen client actually drive an agent inside a sandbox?**

Everything else is settled: the transport reaches in, it authenticates, it is
encrypted, the phone connects. What has not been demonstrated is one real agent
turn started remotely and completed inside a sandbox.

Until that is shown, this design is sound but unproven, and nothing should be
committed to it. It needs a sandbox with a live agent login and about ten
minutes.

---

Technical feasibility, measurements and the traps found along the way:
`2026-09-15-paseo-in-sandbox-intent.md`.
