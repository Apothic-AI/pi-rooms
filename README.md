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
3. a stable name derived from the working directory, e.g. `m2-core-1a2f`

The directory-derived fallback is stable across restarts and distinct per
worktree, which matters when several lanes run from sibling checkout directories.
A name already held by another live process is never taken over; the newcomer
gets a suffixed variant instead, so two agents cannot merge into one inbox.

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
<base>/registry/<name>.json      presence: name, pid, cwd, model
<base>/inbox/<name>/*.json       undelivered messages
<base>/inbox/<name>/read/*.json  delivered messages, kept for reply_all lookup
<base>/rooms/<room>/room.json    members, creator
<base>/rooms/<room>/log.jsonl    append-only history
```

Presence is pruned by process liveness, so a killed lane disappears from the
roster rather than lingering as a ghost. Nothing here is a database: `tail -f`
on a room log is a complete view of that room.

## Notes for fleets

- One `PI_ROOMS_DIR` shared by every lane is one namespace. A room is the unit of
  grouping; you do not need to partition directories to keep conversations apart.
- Give each lane an explicit `PI_ROOMS_NAME` when names matter. Generated
  directory names are stable but not meaningful.
- `roomDelivery: "followUp"` is the safer default for a fleet: room chatter waits
  for an idle boundary instead of interrupting work.
- Messages are delivered into the receiver's context. Anyone in a room can
  therefore put text in front of every other member — treat room membership as a
  trust boundary, the same as giving someone a prompt.

## Development

```sh
npm test        # store, config and extension integration tests
```

Tests run against temp directories; no pi process and no model are needed.
