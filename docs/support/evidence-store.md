# Evidence Store reference

## Storage and source identity

One worker owns each SQLite connection. The binding must report SQLite 3.53.4 or newer. WAL, FULL synchronization, foreign keys, trusted-schema restrictions and startup integrity checks are explicit.

Original UTF-8 bytes deduplicate by SHA-256 within a workspace. Event occurrences remain session scoped. Objects contain up to 256 KiB, with independently addressable spans of at most 4 KiB. Contentless-delete FTS indexes original spans. Reads validate hashes and availability. Deletion hides sources and invalidates dependent atoms and jobs.

Archive schema version 5 rejects unsupported experimental archives without migration. This library provides storage and assembly; [Evidence Compactor](../plugins/evidence-compactor.md) activates the native DSH integration.

## Atoms and extraction jobs

Host controls and extraction policy are versioned. Jobs persist source coverage, attempts, reservations, usage, unknown billing and failure gaps. Late publication under changed controls or policy is rejected. Exact constraints and decisions render original statements with adjacent qualifiers; model proposals cannot assign authority or control fields.

Atom identity includes provider/model IDs, extractor instruction hash and implementation version, and captured source head, source revision, control revision and policy revision. Rehydration preserves derivation history. Maintenance rejects mismatched instruction/implementation versions before egress. Rendered memory includes derivation, authority and sequence.

The assembler preserves mandatory instructions, pins, latest input and open protocol groups, counting the final request through an adapter. The extractor sends original windows without action tools, caps output at 1,500 tokens and allows at most one retry. Assembly does not wait for fresh extraction.

## Manifests and replay

Manifests record selected sources and atoms, modes, renderer/adapter versions, source state and request hash. References are self-contained.

Original text and structural blocks use scoped spans and UTF-8 slices. Headers, tool schemas and bounded derived text stay in the replay recipe. Publication validates the reconstructed canonical JSON hash. `replayRequest(scope, id)` reconstructs it without a model call and refuses unavailable sources or memory.

Recipes are limited to 1 MiB, 32,768 nodes, depth 64 and 256 KiB of inline string values. Materialization is limited to 16 MiB.

## Cold objects

Objects become eligible after 24 hours without access and two newer generations. A separate worker writes independent Zstandard level-3 frames, or gzip when selected or unavailable. Objects below 4 KiB or saving less than 10%, including frame headers, remain raw.

Publication verifies length and hash, syncs the file, renames it, syncs the directory, then updates the SQLite pointer. Platforms without a directory durability barrier use a FULL SQLite blob transaction. Blob replacement is transactional; readers already own decoded bytes. Foreground access invalidates stale compression publication. The decoded cache is bounded to eight objects and 2 MiB.

Logical original bytes, representation bytes and allocated filesystem bytes are separate diagnostics. Allocated-byte enumeration stops at 10,000 files and marks incomplete results.

## Retention and bounds

Idle maintenance scans at most 32 archive entries per pass. After a 24-hour grace period it can remove unreferenced valid frames and abandoned writer temporary files. Referenced paths remain protected, including when their sources are hidden. File/directory identity checks, regular-file checks and hard-link/symlink rejection restrict deletion to the archive namespace. Invalid frame-shaped and unrelated files are retained.

Configurable session retirement invalidates complete inactive sessions and reclaims unreferenced bytes in bounded passes. Shared live objects and active ledgers are protected. SQLite pages and unrelated DSH logs are not securely erased.

Capture accepts at most 8 MiB of original text and 64 KiB of metadata per event. The worker queue admits at most 64 requests and 32 MiB of serialized pending commands. Recovery fixtures cover capture and compressed-pointer transactions around commit, file sync and rename.
