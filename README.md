# staged

<img src="public/brand/staged-icon.svg" width="64" alt="staged">

**Every change across your git repos, sorted into features, commits and releases.** staged reads the repos in `~/GitHub` and shows them on `localhost`. Nothing leaves your Mac, there is no account, and it has no dependencies.

## Quick start

You need [Node 18+](https://nodejs.org) and git. No install step, no dependencies.

```sh
git clone <repo-url> staged
node staged/server.mjs
```

staged finds the folder your repos live in (`~/GitHub`, `~/Developer`, `~/Projects`, `~/code` and similar), remembers it, and opens your browser. To point it somewhere else:

```sh
node staged/server.mjs ~/work ~/side-projects   # one or more folders, remembered next time
node staged/server.mjs --port 5000 --no-open
```

Settings and anything it learns from your corrections live in `~/.config/staged/` (on Windows, `%APPDATA%\staged`), never in your repos.

## What's inside

| View | What it shows |
| --- | --- |
| **Today** | Repos with work waiting, how long it has been sitting, what's ready to push, and a one-line recap of your week. |
| **By week** | Weekly drops with a type mix, lines changed and *Copy notes* for release notes in Markdown. |
| **By feature** | Changes grouped by the part of the site they touched. Each feature has a *story*: its timeline month by month. |
| **By release** | Commits between git tags, with *New release* and *Changelog*. |
| **Tree** | Every branch, merge and tag as lanes that draw themselves in. Hover a commit to light up its history; click it for the files. |
| **Health** | Site weight per week, the biggest jump and the commit behind it, heavy images, stale branches and stashes. |
| **Commit** | Your uncommitted files, already split into commits with messages written for you. |

Commit types come from gitmoji (✨ 🎉 Feature, 💄 💫 🎨 Design, 🐛 Fix, ⚡️ Perf, ♻️ 🔥 🔧 Chore) or conventional commits (`feat:`, `fix:`…). Commits with neither are guessed from their wording and shown with a hollow dot.

## Committing

The **Commit** tab groups every uncommitted file into suggested commits:

- **Connected files travel together.** A new script, its styles, and the files that include it or use its `data-*` hooks.
- **Content gets its own commit.** A collection like `_books/` plus its `Images/Books/`.
- **Files that usually change together stay together.** staged learns this from your past commits.
- **Small one-off edits** gather into one *Small tweaks* commit.

Each commit has a ready message in **Gitmoji** (`✨ Added book notes for …`, in your own voice), **Conventional** (`feat(books): add notes for …`) or **Both**. Then:

- Untick files, or pick individual **chunks** of a file. The rest stays in your working copy.
- **Move** a file to another commit. staged remembers the correction next time.
- Pick an emoji from the **gitmoji picker**.
- **Commit** one group, or **Commit all** to review, reorder and merge first.
- **Undo** puts the last commit made here back into your changes. **Push** appears when GitHub or GitLab is behind.

Secrets files, API keys, huge files, conflict markers, `console.log` and `debugger` are flagged before you commit.

## No AI needed

Grouping and messages come from your files and your history: imports, `data-*` hooks, folders, past co-changes and the verbs you use after each emoji. If Claude Code (`claude`) is installed, **Regroup with Claude** and **Write with Claude** read the actual diffs for sharper results. It uses Sonnet by default; set `CHANGES_CLAUDE_MODEL=haiku` for speed.

## Keys

| Key | Does |
| --- | --- |
| `⌘K` | Jump to any repo, view, action or commit |
| `/` | Search or filter |
| `R` | Re-read repos |
| Alt-click a legend item | Show only that type |

## Naming your own features

Areas are guessed from folder and file names. To name them yourself, add `.changes.json` to a repo:

```json
{
  "areas": {
    "Now page": ["_includes/now/**", "Images/now/**", "assets/audio/now/**", "_sass/_now*.scss"],
    "Books": ["_books/**", "Images/books/**"]
  },
  "ignore": ["package-lock.json"]
}
```

Rules are checked in order; files that match none fall back to the guess.

## Good to know

- Works with GitHub, GitLab (including self-hosted) and Bitbucket remotes. The repo button and commit links open the right site.
- The server only answers on `localhost`, and only to this page.
- Commits are built in a temporary index, so anything you staged yourself elsewhere is left alone. Git hooks don't run for these commits.
- Commit messages follow your repo: past tense (`Added …`) or imperative (`Add …`), whichever your history mostly uses.
- Lighthouse scores need a build step, so they're not in yet.
