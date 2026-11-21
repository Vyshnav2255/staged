# staged

<img src="public/brand/staged-icon.svg" width="64" alt="staged">

**Every change across your git repos, sorted into features, commits and releases.** staged reads the git repos on your computer and shows them on `localhost`. It also runs each project's own commands from one button. Nothing leaves your computer, there is no account, no AI, and no dependencies. It works on macOS, Windows and Linux.

## Quick start

You need [Node 18+](https://nodejs.org) and git. No dependencies.

```sh
git clone --branch v1.0.0 https://github.com/Vyshnav2255/staged.git
cd staged
npm start
```

This clones the latest release. staged updates itself from there, so you don't need to clone again.

It asks how you want to run it:

- **Keep it running** (recommended): in the background and at every login, until you stop it. You never start it again, and it picks up updates by itself. On a Mac it shows up as **staged**, with its icon, in System Settings › General › Login Items. On Linux it's a systemd user service (`staged.service`), and on Windows it's in your Startup folder.
- **Just for now**: in that Terminal window. Press `o` to open it, `r` to restart and `q` to quit.

It lives at http://localhost:4321. Run `npm start` again any time to open it, stop it, or switch modes. To stop the background copy for good: `npm run remove`. If you move or rename staged's folder, run `npm run setup` once in the new place.

Use your browser's **Install app** (Chrome, Edge, Arc) or **File › Add to Dock** (Safari) to give it its own window and icon.

Settings and anything it learns from your corrections live in `~/.config/staged/` (on Windows, `%APPDATA%\staged`), never in your repos.

## Your repos

The first time it runs, staged looks for the folder your repos live in (`~/GitHub`, `~/Developer`, `~/Projects`, `~/code` and similar) and remembers it. Every git repo directly inside that folder shows up. New repos you clone there appear on their own.

To change what it shows, open **Settings › Repos**:

- **Add** a folder of repos, or a single repo from anywhere. Type its path, like `~/work` or `~/code/my-app`.
- **Remove** a folder or a single repo you added.
- **Untick** a repo to hide it from the sidebar, Home and everything else. Nothing in the repo is touched, and you can tick it again any time.

You can also pass folders when starting it: `npm start -- ~/work ~/side-projects`. Once you've changed folders in Settings, the Settings list wins.

## Updates

staged updates itself. When a new version is out, a card in the sidebar says so. Open it to see what's new, press **Update now**, and staged restarts in place in a few seconds. You stay on the page you were on. You can also look for updates any time from `⌘K`.

This works when you installed with `git clone`. If you changed staged's own files, commit or undo those changes first.

To ship a version (for maintainers): run `npm run release` (or `npm run release -- 1.1.0`). It bumps `package.json`, commits, tags and pushes. Then publish it as a GitHub Release, from staged's **Releases** screen (*New release*) or on GitHub under **Releases › Draft a new release**. The notes show up in staged's *What's new*. Only published releases reach people, a tag on its own doesn't.

## What's inside

| View | What it shows |
| --- | --- |
| **Home** | This week against last week, your streak, what's **waiting on you** (files to commit and commits to push) and six months of activity. Click the logo to get here. |
| **Settings** | Repos, sound and updates. Each repo's commit message style is in its own **Project settings** (the gear next to the repo name). |
| **Weeks** | Weekly drops with a type mix, lines changed and *Copy notes* for release notes in Markdown. |
| **Features** | Changes grouped by the part of the site they touched. Each feature has a *story*: its timeline month by month, which you can copy as notes. |
| **Releases** | Commits between git tags, with *New release* (publishes a GitHub Release) and *Changelog*. |
| **Tree** | Every branch, merge and tag as lanes. Hover a commit to light up its history; click it for the files. Other branches and stashes show above it. |
| **Commit** | Your uncommitted files, already split into commits with messages written for you. |
| **Run** | The project's own commands on a cassette deck: serve the site, build, test. See [Run](#run). |

Commit types come from gitmoji (✨ 🎉 Feature, 💄 💫 🎨 Design, 🐛 Fix, ⚡️ Perf, ♻️ 🔥 🔧 Chore) or conventional commits (`feat:`, `fix:`…). Commits with neither are guessed from their wording and shown with a hollow dot.

## Committing

The **Commit** tab groups every uncommitted file into suggested commits:

- **Connected files travel together.** A new script, its styles, and the files that include it or use its `data-*` hooks.
- **Content gets its own commit.** A collection like `_books/` plus its `Images/Books/`.
- **Files that usually change together stay together.** staged learns this from your past commits.
- **Unrelated small edits stay separate.** Small changes join only when another signal links them.

staged remembers each repo's commits as you work: the groups, the messages, your edits and the files you unticked. Leave the tab, switch repos or reload, and it picks up where you left off. Files you've committed drop out; new ones land in a *New changes* card.

Each commit has a ready message in **Gitmoji** (`✨ Added book notes for …`, in your own voice), **Conventional** (`feat(books): add notes for …`) or **Both**. Then:

- Untick files, or pick individual **chunks** of a file. The rest stays in your working copy.
- **Move** a file to another commit with the move button on its row, or drag it onto another card. staged remembers the correction next time.
- Pick an emoji from the **gitmoji picker**: suggestions for that change first, your recent picks, then everything by kind. Search by meaning or `:code:`, arrow keys and Enter work.
- Click a message to edit it.
- A **description** is optional, so it stays tucked away. Pick *Add description* from a commit's ⋯ menu to write one.
- **Discard** throws away changes to a file, a single chunk or a whole suggested commit (hold the button for a whole commit). A copy goes to `.git/staged-trash/` first, and the note that pops up has **Undo**.
- **Add to cart** commits one group, or **Add all to cart** to review, reorder and merge first.
- The **Cart** on the right holds commits waiting to be pushed. **Hold to push**, and a receipt prints. **Undo** puts the last commit made here back into your changes.
- **Rename** the last commit from its cart row, the Tree or `⌘K`. If it's already pushed, staged warns you and pushes the new name with `--force-with-lease`.
- Every push prints a **receipt**, and every week gets a **statement**. Save either as an image.

Secrets files, API keys, huge files, conflict markers, `console.log` and `debugger` are flagged before you commit.

## Run

Press **Run** in the header and a side panel opens with a cassette deck for the project. staged finds the commands from files the project already has:

| Project has | Commands |
| --- | --- |
| `Gemfile` / `_config.yml` (Jekyll) | Serve site (`bundle exec jekyll serve --livereload`), Build site |
| `package.json` | Its scripts, run with npm, pnpm, yarn or bun (from the lockfile) |
| `Makefile` | Each `make` target |
| `Cargo.toml` / `go.mod` | Run and test |
| `manage.py` (Django) | Run server |
| Just an `index.html` | Serve folder (`python3 -m http.server`) |

The main command sits in the deck, the rest are under **More commands**. Keys: Run, Stop, Open, output and ⋯ (make main, hide, remove). When a dev server prints its address, staged opens the page for you. Add your own commands with **Add a command**. They're saved in `~/.config/staged/run.json`, not in the repo.

Commands run in your login shell on macOS and Linux, so rbenv, nvm and the rest of your `PATH` work, and in `cmd` on Windows. Stopping a command stops everything it started. So does quitting staged.

## Commit plans for scripts

Coding agents and scripts can inspect the same proposed groups shown in the Commit tab without starting the web app:

```sh
staged plan --json
staged plan /path/to/repo --json
```

The command prints JSON using the `staged.commit-plan.v1` schema, including each commit subject in Gitmoji and Conventional formats, recommended emoji, group confidence and evidence, and changed file or hunk assignments. It does not commit or edit the repository. Use `--include-diff` only when an agent also needs local diff context; diffs are omitted by default. The output can be passed to an agent to review, compare with its own grouping, and suggest changes to the grouping.

Grouping and messages come from your files and your history: imports, `data-*` hooks, folders, past co-changes and the verbs you use after each emoji. Messages also read the diffs, so they say what changed (`Replaced Geist font with Akt`, `Added Haskoy Italic and Medium Italic fonts`, a new section or function), with a short list of the details underneath.
staged always groups locally from rules and an incremental index of recent Git commit subjects and changed paths, plus an inverted term index for the current diff. The history index lives under `~/.config/staged/group-index/` and stores commit IDs, subjects and paths, never source contents or diffs. Groups staged isn't sure about are marked *Check grouping*. Moving files between groups teaches staged which paths belong together or apart.
staged also learns your message grammar across the repos it knows about, while letting a repo's own history take priority. It adapts Gitmoji/plain/conventional style, tense, common verbs and category emojis, and learns repeated path pairs across projects as a weak grouping hint. General commit guidance supplies only a fallback: coherent, independently useful changes and subjects about behavior rather than filenames.
It drafts messages from diffs, repo history, imports, paths and change types. Grouping and naming use deterministic local rules and repository history; no model service is required.

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

- Runs on macOS, Windows and Linux. On Linux the folder picker uses `zenity`; without it, type the path.
- Works with GitHub, GitLab (including self-hosted) and Bitbucket remotes. The repo button and commit links open the right site.
- The server only answers on `localhost`, and only to this page.
- Commits are built in a temporary index, so anything you staged yourself elsewhere is left alone. Git hooks don't run for these commits.
- Commit messages follow your repo: past tense (`Added …`) or imperative (`Add …`), whichever your history mostly uses.
