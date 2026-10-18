# Pinned context files

When an orchestrator works across several projects, each project agent needs its specification and current plan throughout the work. Pinning keeps those files complete and current while conversation history continues through OptChat's normal memory system. It extends the AGENTS.md lifecycle and historical archive.

## Agent tools

For a stable specification shared by a project's sessions:

```json
{"path":"SPEC.md","block":"pre-memory","kind":"requirements","purpose":"Authoritative system behavior and constraints","scope":"project"}
```

For a task's evolving plan:

```json
{"path":"PLAN.md","block":"post-memory","kind":"plan","purpose":"Current implementation steps"}
```

Pass these arguments to `pin_file`. `kind` is `requirements`, `plan` or `reference`; `purpose` explains why the agent needs the file. The agent is told to use pins only for important continuing context, keep them while needed, and freely release them afterward. The files themselves and `pinned_files()` identify the effective set and its scopes. Ordinary one-off reads do not need pins.

Calling `pin_file` again with the other block moves the registration and reports the move. The same block creates no duplicate. `unpin_file({"path":"PLAN.md"})` removes a task pin from either block. `unpin_file({"path":"SPEC.md","scope":"project"})` removes the project's shared registration. Neither action deletes the document, revokes requirements, or erases its history. Automatic AGENTS.md guidance is always before memory and cannot be moved or unpinned with these tools.

## Scope and paths

- **Project** registrations persist across sessions within one profile and canonical Git worktree root. A linked worktree is a separate project. Outside Git, the exact working directory is the project; subdirectories do not implicitly share registrations. Project files must be inside that project.
- **Task** is the default. Registrations persist for a Pi session or resumed subagent and are inherited by descendants working in that same project. A task can pin an external reference by its absolute path. Descendants in unrelated projects do not inherit it.
- Project pins are shared and can be changed by any agent in that project. Task overrides replace inherited placement/metadata locally. Unpinning in task scope suppresses an inherited pin for that task and its descendants; it leaves parents and siblings alone. A parent's change/removal reaches descendants unless they have an explicit override. Removing a project registration does not remove another task's explicit override.

Relative paths resolve against the registering agent's working directory; `~` is supported. Registration saves the absolute canonical target, so a later symlink change cannot silently switch the document to another project or branch. Missing paths remain visible as unavailable registrations. Restore the source, or unpin its displayed old path and register the new one. Files inside this profile's guidance archive cannot be registered as current pins.

## Current context and history

The request order is:

`stable instructions → automatic guidance + pre-memory pins → memory → post-memory pins → recent work`

After Pi subagent compaction, post-memory pins follow its compacted summary. Placement expresses expected change frequency, not authority: a reference stays a reference, and explicit user instructions still take precedence. OptChat never moves pins on its own.

Each request reads a fixed revision. A real edit supplies the full replacement and an anchored transition with brief differences and a preserved previous-version path. The notice makes clear that earlier work may reflect earlier requirements. Timestamp touches and unchanged text create no new notices or copies; a placement-only move reuses the same content version. Reading an old copy does not activate it.

Injected bodies and notices are absent from canonical conversation logs and summaries. Detailed `zoom` recall exposes their original request's historical references, even after unpinning or source deletion. Explicit pin/unpin tool calls and user discussion remain ordinary conversation. Summarizers still summarize that conversation normally; pinning does not enable an experiment in omitting more from summaries.

## Limits and recovery

Pins accept complete UTF-8 text files, with optional leading BOM. Invalid UTF-8, binary/control bytes, unreadable files and files over 1 MB are rejected on registration. Files that later become unreadable, unsupported, missing or too large are explicitly marked **UNAVAILABLE**, with no stale or partial body. The agent is instructed to pause dependent work and repair or release the pin. Its recovery tools remain available.

At most 32 effective pins and 1 MB of rendered manual pin context are admitted. Before each request, both blocks also share a model-dependent budget. It accounts for Pi's estimate of existing context (including images and tool schemas), automatic guidance, transition notices and framing, then reserves output space and headroom. Pin text uses a conservative two-bytes-per-token estimate. This allows substantial specifications and plans on large models and reassesses them after edits, memory growth and model changes; it is an estimate rather than a provider tokenizer guarantee.

If the combined readable pins exceed that request's allowance, all of those manual pins are marked unavailable together, with their registrations intact. OptChat does not choose a silent subset or truncate a file. Unpin unnecessary material, shorten the source deliberately, start a fresh turn to reduce recent work, or select a larger model. Already unavailable files remain individually identified. Automatic guidance errors, registry corruption and failures to preserve/archive request data stop dispatch instead of weakening their guarantees.

## Validation

Offline tests exercise real main/subagent sessions, refresh, restart, Pi compaction, parallel projects, worktree isolation, inheritance/overrides, moves, removal, source failure and smaller-model recovery. Provider tests inspect actual Anthropic, OpenAI Responses and Chat Completions payloads for placement and prefix stability.

`npm run test:pins:live` sends only synthetic files and work to a real provider. It checks file awareness, pin lifetime, requirement/plan updates and interpretation of earlier work. On one OpenAI `gpt-6.1-sol` run, changing memory or the post-memory plan each retained 7,808 cached input tokens; a subsequent unchanged request reused 8,448; changing the pre-memory specification read zero cached tokens. These are observations, not promised savings. `OPTCHAT_GUIDANCE_PROVIDER` and `OPTCHAT_GUIDANCE_MODEL` select another available model.
