# gh-gradepush

gh-gradepush is a local GitHub CLI extension for downloading the submissions
in a Gradepush classroom or assignment. GitHub submissions are cloned with your
own GitHub login. Since version 1.2.0, `gh gradepush download` also downloads
file-upload submissions (files and ZIPs handed in through Gradepush) directly
from Gradepush, with or without a GitHub backup.

**Upgrade required for file uploads.** Versions 1.1.0 and earlier print
`SKIP ...: upload-backed submissions cannot be cloned from GitHub` for every
upload without a current GitHub backup. Run `gh extension upgrade gradepush`,
check `gh gradepush --version` reports 1.2.0 or later, and run the same
download command again. To get one student's files without the CLI, use the
**ZIP** button next to the submission in Gradepush.

## Install

The extension needs Node.js 20 or later, an authenticated GitHub CLI (gh), and Git:

    gh extension install mrjordash/gh-gradepush

If already installed, update it with `gh extension upgrade gradepush`.
Saved-session login and named downloads support macOS, Linux, and WSL. Native
Windows credential storage is not supported yet; use WSL for this workflow.

During local development, symlink this directory into the GitHub CLI extension
directory:

    mkdir -p ~/.local/share/gh/extensions
    ln -s "$(pwd)/tools/gh-gradepush" ~/.local/share/gh/extensions/gh-gradepush
    gh gradepush --help

## Clone from Gradepush

Sign in once on each computer:

    gh gradepush login

This opens Gradepush in your browser. Sign in as a teacher, compare the displayed
code with your terminal, and select **Authorize this terminal**. Never approve a
code sent by someone else. Use `--no-browser` to open the printed link yourself,
or `--server https://your-gradepush.example` for a self-hosted server. The default
is `https://gradepush.ca`. Login requests expire after ten minutes.

Then download by GitHub organization (or Gradepush workspace slug), classroom,
and optional assignment:

    gh gradepush download codewithjordy test test
    gh gradepush download codewithjordy test
    gh gradepush download codewithjordy test test --destination ./reviews
    gh gradepush download codewithjordy test test --update
    gh gradepush download codewithjordy test test --latest

Omit the assignment to download the whole classroom. **Clone locally** in the
web app provides the commands for the selected classroom or assignment. If the
same name matches multiple classrooms you teach, add `--workspace <workspace-slug>`.
The CLI does not guess which classroom you intended. Downloads use the server
saved during login and recheck your current teaching access every time.

Your session lasts 90 days. To revoke it on the server and remove it locally:

    gh gradepush logout

Log out before switching accounts or servers, or signing in again after expiry.
Logout requires a connection to the saved server so it can revoke the credential.
The session is stored in `$XDG_CONFIG_HOME/gradepush/session.json`, or
`~/.config/gradepush/session.json`, with owner-only file and directory permissions
on Unix. Keep this file private. The server stores only the credential's SHA-256
hash. Revoked sessions cannot be reactivated by replaying browser approval.
Repository cloning still uses your own authenticated GitHub CLI account.

The CLI sends its credential in an Authorization header over HTTPS (HTTP is
accepted only on localhost), rejects redirects, and limits the response to 1 MiB.
It never passes the Gradepush credential to Git/GitHub subprocesses or includes
it in a download command.

During development, install the local extension above; publishing the extension
and deploying the CLI session migration and application are separate release
steps before using the new commands with the public install.

### File-upload submissions

Each upload submission is stored as a Git repository on the Gradepush server.
`download` fetches it as a Git bundle over the same signed-in HTTPS session
(limited to 250 MiB per submission) and creates a local repository in the same
hierarchy as GitHub submissions, checked out detached at the latest submitted
revision. The local copy has no remote; its history is kept on the
`gradepush-latest` branch. `--update` replaces nothing: it only fetches a fresh
bundle into a clean copy previously created for the same submission. Students
who have not uploaded files yet are reported as skipped.

Downloaded submissions are untrusted student content, like any cloned
repository: review them before running scripts, and be careful with editors or
tools that run project configuration automatically (for example `.envrc` or
workspace tasks).

Manifest files and legacy clone URLs cannot authenticate to Gradepush, so they
still skip upload submissions; use `download` for those.

## Legacy clone URLs

Previously generated `gh gradepush clone '<url>'` commands continue to work until
their ten-minute expiry. These commands contain a private, selection-scoped
credential. The CLI sends it as a bearer header without storing it locally.

## Existing manifest files

    gh gradepush clone gradepush-clone-manifest.json
    gh gradepush clone gradepush-clone-manifest.json --destination ./reviews
    gh gradepush clone gradepush-clone-manifest.json --update
    gh gradepush clone gradepush-clone-manifest.json --latest

By default, each GitHub submission is placed in this hierarchy:

    ./gradepush-submissions/<classroom.slug>/<assignment.slug>/<identifier>-<student-login>--<stable-id>

The stable suffix prevents collisions while keeping a repeatable path. The
identifier is sanitized for a readable path and omitted when it is null.
Existing paths are never overwritten. --update only operates on an existing
clean Git worktree whose origin is the exact repository from the manifest. It
fetches and checks out the recorded SHA, or fast-forwards the default branch
with --latest. The extension never runs git reset or deletes files.

Without --latest, a GitHub submission with lastSyncedSha checks out that SHA
detached for reproducible review. If lastSyncedSha is null or omitted,
Gradepush has never synchronized the submission, so the extension skips it and
instructs the operator to rerun explicitly with --latest.

Every GitHub CLI and Git child process runs with LFS smudging disabled and
interactive prompts disabled. Before cloning, the extension verifies that each
GitHub repository declares no more than 250 MiB, the batch declares no more
than 5 GiB, and the destination can hold the declared batch with 25% checkout
overhead plus a 512 MiB safety reserve. Each command and all of its child
processes have a five-minute limit, and the complete run has a 30-minute limit.

## Clone manifest v1

The input is JSON smaller than 1 MiB, with no unrecognized fields:

    {
      "schemaVersion": 1,
      "generatedAt": "2026-08-30T12:00:00Z",
      "classroom": {
        "id": "classroom-id",
        "name": "Programming 1",
        "slug": "programming-1"
      },
      "assignments": [
        {
          "id": "assignment-id",
          "title": "Loops",
          "slug": "loops",
          "submissions": [
            {
              "student": {
                "login": "ada",
                "identifier": "student-id"
              },
              "source": "github",
              "repoFullName": "school/loops-ada",
              "lastSyncedSha": "0123456789012345678901234567890123456789"
            },
            {
              "student": {
                "login": "grace",
                "identifier": "student-id-2"
              },
              "source": "upload"
            }
          ]
        }
      ]
    }

repoFullName is required for source github. lastSyncedSha may be null or
omitted. An upload entry with repoFullName and lastSyncedSha is a GitHub
backup and is cloned like a GitHub submission. Other upload entries are
reported as skipped, not treated as failures.

Version 1.2.0 sends `X-Gradepush-Capabilities: upload-bundles` with `download`.
Only then does the server add `submissionId` (and the latest submitted
`lastSyncedSha`, which may be null) to every upload entry instead of a backup
repository. Clients without the capability keep receiving the entries above,
because they reject unknown fields.
