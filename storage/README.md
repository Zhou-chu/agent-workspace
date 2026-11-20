# AgentChat object storage

A standalone Node.js 24 module for the bytes behind a chat attachment, not
for chat records or user authorization. It has no runtime dependencies and
does not connect to a network.

```sh
cd storage
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
npm run build
```

`npm run build` packages `agentchat-storage-0.1.0.tgz`. A consumer needs only
that package and Node.js, not the web UI or backend source tree.

## Adapter contract

`createLocalStorage({directory, maxBytes})` returns this asynchronous adapter:

| Method | Contract |
| --- | --- |
| `put(key, bytes)` | Store a `Uint8Array` or `Buffer` snapshot. Return `{size}` after commit. Reject a duplicate with `EEXIST`; never overwrite. |
| `get(key)` | Return a `Buffer` or `null` for a missing key. |
| `delete(key)` | Return `true` when removed or `false` if already absent. |

Generate keys on the server (lowercase UUID v4 or 64 lowercase hex characters).
Original filenames, MIME validation, upload budgets, membership checks, and
retract/tombstone semantics belong to the application. Do not expose object
keys as authorization or create public download links to bypass these checks.
The default maximum is 10 MiB (exported as `MAX_OBJECT_BYTES`), and a smaller
positive cap can be configured; a too-large object is rejected with
`OBJECT_TOO_LARGE`.

The implemented adapter uses an application-owned private directory on a
filesystem supporting hard links (e.g. NTFS or common Linux filesystems).
It stages bytes in that same directory and publishes them atomically without
replacement. Keep the directory outside document roots and shared write paths,
with OS access limited to the backend account. Pending staging files after an
interrupted process are never addressable as objects. This adapter is local,
not distributed, and it does not manage multiple backends, backups, or
remote credentials.

A future object-store or enterprise-drive adapter can implement the same
three operations. Its policy must preserve conditional create, bounded read,
private access, and idempotent deletion. No distributed store or third-party
drive is activated or verified by this module.
