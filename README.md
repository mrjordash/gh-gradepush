# gh-gradepush

gh-gradepush is a local GitHub CLI extension for cloning the GitHub-backed
submissions listed in a Gradepush clone manifest. It never clones upload-backed
submissions because they do not have a GitHub remote.

## Local install

The extension needs an authenticated GitHub CLI (gh) and Git. During local
development, symlink this directory into the GitHub CLI extension directory:

    mkdir -p ~/.local/share/gh/extensions
    ln -s "$(pwd)/tools/gh-gradepush" ~/.local/share/gh/extensions/gh-gradepush
    gh gradepush --help

The planned packaged installation is:

    gh extension install mrjordash/gh-gradepush

## Clone a manifest

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
than 5 GiB, and the destination has at least 512 MiB free. Each command has a
five-minute limit and the complete run has a 30-minute limit.

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
omitted. Upload entries are reported as skipped, not treated as failures.
