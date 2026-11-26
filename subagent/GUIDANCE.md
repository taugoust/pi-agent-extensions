# Coordinator guidance

Workers have two ways to ask a question:

- **`request_guidance`** asks the direct coordinator a work question and waits
  for the answer. The coordinator answers with the `guidance` tool (`list`,
  `reply`, `escalate`). Each request has a `handle` that names one revision of
  it, so an old handle never answers a newer request.
- **`questionnaire`** is for real human decisions. It is forwarded up to the
  top-level coordinator, which asks the human with `guidance operation=human`.
  A model can never answer in the human's place.

`notify_parent` and `subagent operation=prompt` never answer a waiting request.
Guidance never grants permissions. Permissions keep their own channel.

## Files

- `guidance.ts`: the owner's broker, a private Unix socket plus a journal.
- `guidance-binding.ts`: the worker's binding (socket, token, scope), kept in
  `PI_SUBAGENT_GUIDANCE_V1`.
- `guidance-worker.ts`: the worker's `request_guidance` tool and the
  questionnaire forwarding.
- `guidance-extension.ts`: installs the broker and the `guidance` tool.

The launcher gives every native worker a binding at launch, or an explicit
"unavailable" marker. A worker without a working binding fails. It never
falls back to asking the human directly.

## Restarts

Pending requests are journaled under `state/coordinator-guidance-v1`. When the
owner restarts, its pending requests become `unavailable`. Answers are never
replayed.

Each owner runtime listens on a new socket with new tokens. While the owner is
down, a worker's request fails with "Owning coordinator restarted". Once the new
owner sees the live worker in its regular status poll, it sends the worker a
fresh binding (`rebind_guidance`). The worker accepts it only if it names the
same task, child, attempt and worker epoch. A restarted owner also deletes the
socket directory its crashed predecessor left in `/tmp`.

## Limits

At most 1024 records and 64 waiting requests per owner. When full, new
requests are refused rather than old ones dropped.

## Tests

```
node --experimental-transform-types --test \
  subagent/guidance.test.ts subagent/guidance-integration.test.ts
```

`guidance.test.ts` runs in the `subagent` check. `guidance-integration.test.ts`
does not, so run it by hand.
