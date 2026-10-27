# pi-rooms

Rooms, direct messages and reply-all for [pi](https://pi.dev) coding-agent sessions.
File-based: no daemon, no server, no database.

A room is a named set of agents with an append-only history. A leader creates the
room, everyone in it can post, and any agent can read the history forward from a
sequence number — so a lane that joins late can catch up without replaying
everything.

## What this is not

Deliberately not included: task orchestration, planning, worker spawning, file
reservations, activity feeds. This is a messaging layer only. If you want a
PRD-to-parallel-workers orchestrator, this is the wrong package.

## Install

```sh
pi install /path/to/pi-rooms          # local checkout
pi install git:github.com/you/pi-rooms  # once pushed
```

State lives in `~/.pi/agent/rooms` unless `PI_ROOMS_DIR` says otherwise.

## Identity

Each session registers one name. Precedence:

1. `PI_ROOMS_NAME`
2. `PI_AGENT_NAME` (so existing pi tooling and this extension agree)
3. a name derived from the working directory plus a short hash, e.g. `m2-core-1a2f`

### Pin `PI_ROOMS_NAME` if you use rooms

**This is the supported way to get stable identity, and rooms are not durable
without it.** The directory-derived fallback is stable across restarts only while
the name is unchallenged. If two sessions in the same directory claim it at once,
the second gets a pid suffix (`overlord-18c7-46525`), and after a restart neither
name comes back: the hash is the same but the pid is new, so the lane returns as
`overlord-18c7-72208`.

The consequence is silent: **a room's membership empties across a restart.** Room
members are stored by name, so every member that comes back under a different name
is simply no longer that room's member — `rooms_post` pushes to nobody, and
`rooms_who` shows a lane the room has never heard of. Nothing errors, because from
the extension's point of view the old member is gone and a new agent has arrived.

Pin the name per pane and none of that happens:

```sh
# in each lane's environment
PI_ROOMS_NAME=dxdb-core
```

Treat the name as a durable lane identity, like a hostname, not as a label. If you
rename a lane, it leaves its rooms and must be re-added; there is no rename
alias.

### Pinning a running fleet: `names.json`

`PI_ROOMS_NAME` only takes effect at process start, so pinning a fleet that is
already running would mean restarting every lane. `<base>/names.json` assigns names
without that:

```json
{
  "pins": {
    "pane:wE:p1B":    { "name": "dxdb-core" },
    "session:01a1b2c3": { "name": "sysops-leader" },
    "cwd:/home/me/Code/dxdb": { "name": "dxdb-lead" }
  }
}
```

Pins are read on **every tool call**, so a pin written now applies to a running
lane on its next call — no restart, no signal. `rooms_pins` shows every pin and
whether it is claimed.

Precedence, highest first:

1. `PI_ROOMS_NAME`, then `PI_AGENT_NAME` — a pin **never** overrides an explicit
   environment name. This is deliberate: the environment is a per-process
   instruction, and a file cannot speak for a process that already said what it
   is.
2. `session:<PI_SESSION_ID>` — survives restarts of that session.
3. `pane:<HERDR_PANE_ID>` — what you can see in the UI, but herdr **recycles pane
   ids**, so it is the convenient key and not the durable one.
4. `cwd:<path>` — easy to write, but cannot tell two lanes in one directory apart.

Session before pane is not arbitrary: a session id survives its pane being moved,
closed or recreated, and a pane id survives nothing.

**A pin is bound to the process that claimed it.** On first use the entry is
stamped with that process's start time, and afterwards it only applies to a
process matching that stamp. So a pin you wrote for `wE:p1B` is *not* silently
inherited by the next process to occupy `wE:p1B`: the new occupant falls through
to the next key, `rooms_pins` shows the pin as `claimed`, and you can free it by
deleting the entry. Without that stamp, recycling a pane id would transfer one
lane's identity to another, which is the failure this file exists to prevent.

Renaming is a leave-and-join, not an alias: a lane that changes name stops being a
member of its old identity's rooms. Pin before you create rooms over a lane.

### Correlating a name with a pane

When pi runs under herdr, its process environment carries `HERDR_PANE_ID`,
`HERDR_TAB_ID` and `HERDR_WORKSPACE_ID`. These are recorded at registration and
shown by `rooms_who`, so a name can be matched to the pane you are looking at
without comparing directories:

```
* dxdb-core    wE:p1B    /home/me/Code/dxdb    wE:t19
```

The pane id is a **correlation attribute, not an identity**. It is positional and
recycled, so on its own it says nothing about when; it means "this name is this
pane, right now" only because it is paired with the process identity recorded
beside it, and the liveness checks invalidate the pairing when that process goes
away. Off herdr the fields are simply absent and nothing changes — there is no
herdr dependency, no socket, no polling.

### Liveness

The roster reports *running* processes, not *registered* ones. A registration is
considered gone when its pid is missing, when it was written during an earlier
boot, when the pid's start time does not match the one recorded, or when the
process is a zombie. Reused pids and post-reboot ghosts are therefore reaped rather
than listed.

**Platform caveat, stated plainly.** The start-time and zombie checks read
`/proc/<pid>/stat` and are **Linux only**. Elsewhere — macOS included — there is no
`/proc`, so the extension degrades to `process.kill(pid, 0)` and the boot-id file
is absent too. On those platforms a reused pid is *not* detectable, and a zombie
answers `kill(pid, 0)` successfully, so presence can outlive the process. The
fallback is deliberate: reporting everything dead on a platform without `/proc`
would be worse than reporting a stale entry. If you run a long-lived fleet on
macOS, treat `rooms_who` as advisory and confirm a lane with the multiplexer.

## Tools

| Tool | Purpose |
|---|---|
| `rooms_who` | Live agents, their directories and models |
| `rooms_dm` | Message one agent, or several by passing an array |
| `rooms_reply_all` | Answer every recipient of a message you received |
| `rooms_create` | Create a room with a fixed member list |
| `rooms_join` | Join an existing room |
| `rooms_post` | Post into a room |
| `rooms_read` | Read room history, `since` a sequence number |
| `rooms_list` | Rooms, members and post counts |
| `rooms_pins` | Name pins, and whether each is claimed |

### Delivery status

Every message gets a receipt file at `<base>/receipts/<message-id>.json`, recording
what the extension could actually observe:

- **`queuedAt`** — the recipient's inbox accepted the message. `rooms_dm` reports
  this the moment it returns.
- **`deliveredAt`** — the recipient's own session was handed the message through
  `pi.sendMessage`. This is the last moment the extension can see anything.

There is deliberately **no read or acknowledged state**. The extension cannot see
what a model does with a message once its session holds it, and a receipt that
claimed more than it observed would be worse than no receipt at all. "Queued but
not delivered" is a real and useful signal: it means the recipient's session is
not running, or its inbox watcher never fired.

### Rooms

```text
rooms_create({ room: "dxdb", members: ["core", "testkit", "browser"] })
rooms_post({ room: "dxdb", message: "m2-core green, taking testkit next" })
rooms_read({ room: "dxdb" })              // #1..#20
rooms_read({ room: "dxdb", since: 20 })   // only what is new
```

History is the file's line order — posts carry no stored sequence number, so two
agents appending at the same moment cannot disagree about what came next. The
number you see is the line's position, which is why `since` is stable.

`rooms_post` appends to the history and pushes a copy to every other member.
Members who are not running receive nothing until they start; the history is
still there for them.

### Reply all

`rooms_dm` records its recipient list on the message. A recipient can then answer
everyone without re-deriving the list:

```text
rooms_dm({ to: ["core", "testkit"], message: "who owns the migration?" })
// in core's session, from the delivered message id:
rooms_reply_all({ messageId: "0b773ed9-…", message: "mine, until Friday" })
```

The reply goes to the original sender plus everyone else who was addressed,
minus yourself. For a message that came from a room, `rooms_reply_all` posts into
the room instead, so the answer lands in the history.

## Configuration

`<base>/config.json`, all fields optional:

```json
{
  "autoJoin": true,
  "maxSendsPerSession": null,
  "dmDelivery": "steer",
  "roomDelivery": "followUp",
  "pollMs": 2000
}
```

| Field | Default | Meaning |
|---|---|---|
| `autoJoin` | `true` | Register presence on session start |
| `maxSendsPerSession` | `null` | **Unbounded.** Set a positive number to cap outbound messages per session |
| `dmDelivery` | `"steer"` | A DM interrupts the receiver now |
| `roomDelivery` | `"followUp"` | A room post is delivered when the receiver is idle |
| `pollMs` | `2000` | Inbox fallback poll, for filesystems where `watch` is unreliable |

The send cap is off by default and is structural when on: it is enforced on the
only path that can send, so an agent cannot route around it. A cap is the
pragmatic brake on two agents volleying indefinitely; a fleet that would rather
not have one should leave it `null` and rely on delivery modes instead.

## Storage

```
<base>/registry/<name>.json      presence: name, pid, proc identity, pane, cwd, model
<base>/inbox/<name>/*.json       undelivered messages
<base>/inbox/<name>/read/*.json  delivered messages, kept for reply_all lookup
<base>/receipts/<id>.json        per-recipient queued/delivered timestamps
<base>/names.json                name pins (pane, session, cwd)
<base>/rooms/<room>/room.json    members, creator
<base>/rooms/<room>/log.jsonl    append-only history
```

Presence is pruned by process liveness, so a killed lane disappears from the
roster rather than lingering as a ghost. Nothing here is a database: `tail -f`
on a room log is a complete view of that room.

## Notes for fleets

- One `PI_ROOMS_DIR` shared by every lane is one namespace. A room is the unit of
  grouping; you do not need to partition directories to keep conversations apart.
- **Pin `PI_ROOMS_NAME` on every lane.** See [Identity](#identity). Without it a
  room's membership silently empties across a restart, which is the kind of thing
  a user discovers at the worst possible moment — mid-recovery, when a reliable
  roster matters most.
- `roomDelivery: "followUp"` is the safer default for a fleet: room chatter waits
  for an idle boundary instead of interrupting work.
- Messages are delivered into the receiver's context. Anyone in a room can
  therefore put text in front of every other member — treat room membership as a
  trust boundary, the same as giving someone a prompt.
- Treat `rooms_who` as the live roster on Linux, and as advisory on macOS where
  the `/proc` checks are unavailable.

## Development

```sh
npm test        # store, config and extension integration tests
```

Tests run against temp directories; no pi process and no model are needed.
