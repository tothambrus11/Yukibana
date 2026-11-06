# `yukibana.json`

The contract between a course repository and Yukibana. It lives at the
project root, and it is read by two programs: the student's IDE (our Theia
fork), for how the workspace looks and which files are read-only, and the
CLI, for what a student must never receive and what a submission holds.
Its JSON Schema is generated from the parser's own schema into
`docs/cloud/yukibana.schema.json` and served at
`https://cloud.yukibana.dev/schema/yukibana.json`; name it as `$schema` and
an editor checks the file as you type.

```json
{
  "$schema": "https://cloud.yukibana.dev/schema/yukibana.json",
  "version": 1,
  "kind": "scala-sbt",
  "features": { "codeSuggestions": true, "squiggles": true, "ai": false },
  "layout": {
    "widgets": { "files": false, "search": false, "vcs": false, "debug": false, "testing": false, "outline": false, "aiChat": false },
    "containers": { "metals-explorer": false }
  },
  "openFiles": ["README.md", "src/main/scala/Main.scala"],
  "readOnly": ["src/test/**", "README.md", "yukibana.json"],
  "hidden": ["src/test/scala/hidden"],
  "submission": { "exclude": ["notes"] }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Always `1` for now. A future shape gets a new number, not a silent reinterpretation. |
| `kind` | yes | `rust-cargo` or `scala-sbt`. Chooses the build output no archive carries (`target/`, `project/target/`, `.bsp`, `.metals`, …) and the manifest checks below. |
| `assignmentFile` | no | The file the IDE opens as the assignment. Default `ASSIGNMENT.md`. |
| `features`, `layout`, `openFiles` | no | For the IDE: which helpers are on, which views show, which files open. Everything is on unless set `false`. Checked, and copied into the starter as written. |
| `readOnly` | no | Globs of files the student receives and may not change. The IDE stops them being edited; an assembly replaces whatever a submission holds under them with the teacher's version, and reports every change. |
| `hidden` | no | Globs of files the student never receives. Removed from the starter and from the starter's copy of this file; put back by an assembly. |
| `submission.include` | no | When present, only matching paths are submitted (and `yukibana.json`, always). |
| `submission.exclude` | no | Globs never submitted. |
| `submission.respectGitignore` | no | Whether what the project's `.gitignore` files ignore is left out of a submission too, as git would leave it out of a commit. Default `true`. |
| `submission.target` | no | Where the IDE sends a submission: `cloud`, the registry (the default), or `file`, an archive the student saves. The CLI always sends to the registry. |
| `submission.filename` | no | What `yukibana pack` calls the archive it writes (into a fresh folder under the system's temporary directory, unless told `--out`). Default `submission.tar.gz`. The bytes are always a gzipped tar, whatever the name. |
| `submission.maxBytes` | no | The largest submission this project expects. Default 32 MiB; the registry has its own cap above which this cannot go. |
| `projectId` | no | A uuidv7, as the registry makes them. Written by `publish` (or `build --project`, which refuses anything else) into the starter's copy, so `yukibana submit` and the IDE know where a submission from that folder goes without the student choosing. A course repository leaves it out; a starter built without a project has none, and its students name the project when they submit. The registry does not trust it: a submission is accepted only where the student's enrolment allows. |
| `releaseId` | no | Written by `publish` and `build` into the starter's copy: the release this starter is. The CLI chooses the id before building and the release row is given the same one, so it cannot name a different release however late a student downloads. `submit` and the IDE send it with the submission. The registry keeps it only when it is a release of the same project, and grading uses it to tell what the student changed from what a later release changed. A course repository leaves it out. |

Globs are relative to the project root. `*` stays inside a path segment, `**`
crosses segments, `?` is one character, and a pattern that names a directory
covers everything under it, so `tests/*` covers `tests/a/b.rs` too. There is
no negation. A field this version does not know is passed through to the
starter with a warning, so a misspelt `"hiden"` is printed rather than
shipping the tests in silence.

Never in any archive or submission, whatever the file says: `.git/`, and
`.theia/`, because everything the IDE is set up with is declared here.
Never in a submission either: `node_modules/`, at any depth, and the
kind's build output (`target/` and the like). A submission leaves out what
the project's `.gitignore` files ignore, unless
`submission.respectGitignore` is `false`; `yukibana.json` always goes.
The IDE and `yukibana submit` apply the same rules, through the same
library function.

## What a release is

`yukibana build` (or the GitHub Action, or `publish`) reads the checkout and
produces two archives, each unpacking into one folder (`--folder`, by
default the directory's name). Only a plain `tar -x` uses that name; the
IDE and `yukibana starter` put the folder's contents into a folder the
student chooses. The two archives are:

* **the teacher archive**: the project as it is, hidden tests and this file
  included, minus `.git/`, `.theia/` and the build output. Staff download it
  from the release list, and assemblies take the read-only and hidden files
  from it; students never can;
* **the starter**: the same minus `.github/` and everything `hidden`
  matches, plus a copy of `yukibana.json` with `hidden` removed and
  `projectId` and `releaseId` added. Only `publish` (and the Action) upload
  a release, with the same id; the archives `build` writes are for a look
  inside, and their id names a release that will not exist.

The build fails, with every reason on the terminal and a non-zero exit, when:

* there is no `yukibana.json`, or it does not parse, or a field is wrong;
* `hidden` names paths and none of them matches anything (a typo would
  otherwise ship the tests);
* `Cargo.toml` names a hidden path in a `path = "…"` or a workspace member,
  or the kind's manifest (`Cargo.toml`, `build.sbt`) is missing. Hidden tests
  must be auto-discovered, because deleting a file a manifest points at
  leaves a starter that does not build;
* a symlink points outside the repository (it could carry a hidden file out
  under another name).

## What a submission is

A `.tar.gz` of the student's project folder, paths relative to its root,
`yukibana.json` at the top, holding what the rules above let through. The
CLI's `submit` and the IDE extension make it with the same library function,
so both send the same files. It is sent as the body of
`POST /api/projects/{projectId}/submissions` with `Content-Type:
application/gzip` and a `Content-Length`, and `?release=<releaseId>` when
the folder's `yukibana.json` has one, authenticated by an
`Authorization: Bearer <access token>` header (or the session cookie). The
response is `201` with the submission id, size and SHA-256. Every submission
is kept and the newest is the one that counts. Submissions are accepted
while the project's window is open (from `available_after` until
`closes_at`, both set on the project page); one that arrives after the
deadline is accepted and listed as late.

## What an assembly is

What a teacher grades: the student's files, except that `yukibana.json`,
every `readOnly` path and every `hidden` path are deleted from the
submission and taken from the teacher archive of a release. By default that
is the release the submission started from (the newest, when that is not
known); `download --assemble --release newest` uses the newest for everyone,
so a fixed hidden test reaches every submission, and `--release <id>` any
one release of the project. The teacher's `yukibana.json` decides what is
protected, never the student's copy. What the student changed is always
measured against the release they started from, so a read-only file fixed in
a later release is not reported as theirs. An assembly reports, per student:

* **modified**: a read-only file (or `yukibana.json`, `projectId`,
  `releaseId` and formatting aside) with contents other than the starter
  had;
* **deleted**: a read-only file (or `yukibana.json`) the starter had and the
  submission does not;
* **added**: a file under a read-only or hidden path that the teacher's
  project does not have, such as a test written into the hidden folder.

Each is undone in the assembled folder either way, as long as the release
assembled with protects the path too. When it does not (a path that was
read-only in the student's release and no longer is), the student's version
stays and the download says so. A student file that only the release
assembled with protects is replaced, and is listed as such: it was no rule
of theirs that it broke.
