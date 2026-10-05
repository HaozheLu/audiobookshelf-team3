<br />
<div align="center">
   <img alt="Audiobookshelf Banner" src="https://github.com/advplyr/audiobookshelf/raw/master/images/banner.svg" width="600">

  <p align="center">
    <br />
    <a href="https://audiobookshelf.org/docs">Documentation</a>
    ·
    <a href="https://audiobookshelf.org/support">Support</a>
    ·
    <a href="https://audiobooks.dev/">Demo</a>
  </p>
</div>

# 17-695 Team Project

This fork contains the team's combined changes to the Audiobookshelf course copy. The original instructions for running the project from source remain below.

# Team 3 — Podcast Download Queue

Three changes to audiobookshelf's podcast downloading: filtering what gets auto-downloaded (#7), reordering and removing what is waiting (#8), and retrying what failed (#9).

## Run it

```sh
npm run prod
```

Then open http://localhost:3333/audiobookshelf and create an admin account and a **Podcast** library.

Tests: `npm test`

## Check it

Add a podcast with auto-download off, then:

1. **#7** — Edit → Schedule, enable auto-download, set a limit, enable the trailer/bonus filters and a title phrase, click **Preview**. Excluded episodes are listed with a reason, and the limit applies after filtering.
2. **#8** — **Find Episodes**, select ~10. On **Download Queue**, move a waiting row to the front and remove another. Reload: the order holds, and episodes then download in that order. The removed one never downloads.
3. **#9** — Make a download fail (e.g. go offline mid-download). It appears in the failed list with its stage. **Retry** starts a new attempt; **Dismiss** clears it.

---

## Issue #7 — Filter automatic podcast downloads
**Kevin Huang** (@hzykevin)

**Change.** Per-podcast filters for automatic downloads: exclude trailers, exclude bonus episodes, and exclude titles containing a phrase (case-insensitive). A preview shows which episodes would be downloaded and why the others were excluded. Filtering runs before the max-download limit, and the preview and the real run share one selection path so they cannot disagree. Manual downloads are unchanged.

**Checks.** Server 437 passing; client 110 across 7 specs; Schedule component 5; client production build passed; manual end-to-end preview passed, covering the date cutoff, both type filters, case-insensitive title matching, and the limit applying after filtering.

**From the RFC.** The shared selection utility ended up owning the cutoff, duplicate, ordering and limit decisions too, not just the new filters. Title phrases are trimmed, and an empty phrase disables the title filter. The preview reuses the existing feed endpoint to fetch a normalized feed.

**Remaining.** New UI strings fall back to English in untranslated locales. A preview can differ from a later run if the remote feed changes in between.

---

## Issue #8 — Reorder and remove pending downloads
**Oliver Zhang** (@junhezhan)

**Change.** An admin can move a waiting episode to the front of the queue or remove it before it starts; the active download is never touched. The queue used to be a FIFO that only changed at its ends, so nothing ever addressed one entry, entries are now addressed by download id, since positions shift as downloads start and new episodes queue. The server owns order: `pending, front`, `pending, removed`, and `pending, active`, the last triggered only by the server. Anything aimed at an active, finished or already removed entry returns 404 meaning "no longer pending". Every change broadcasts the whole queue from the same function that serves a page load, so the browser only renders what it is sent and a refresh cannot disagree with a live update.

**Checks.** 368 passing, including 14 for the queue actions — middle-of-queue moves and removals, targeting the active download, unknown ids, an id from a different podcast, repeated removal, an episode queued mid-operation, and fresh-page order matching start order. End to end: four moves, then the server started those episodes in exactly the arranged order, including one that displaced an earlier move; six removed entries each had zero completions and zero rows; a removal 110 ms before a completion left it undisturbed.

**From the RFC.** The RFC left open whether to broadcast the affected id or the whole queue. After critique it broadcasts the whole queue, which also removed the need for a separate re-sync. Lookup now matches the podcast's library-item id as well as the download id, so a mismatched pair is rejected instead of changing the wrong queue. A reviewer's suggestion to add a status field was not adopted: it would not remove the lookup, since a move or removal needs the array index anyway, and it would add a second copy of state that can drift.

**Remaining.** The queue is in memory and does not survive a restart; that, pausing transfers, and parallel downloads are outside the request. A rejected action cannot tell an id that was pending a moment ago from one that never existed.

---

## Haozhe Lu — Issue #9: Retry failed podcast downloads

### Change

Failed podcast download attempts are now kept in a server-held list containing the latest 50 failures since startup. The administrator's podcast download-queue page shows the episode and whether it failed during transfer, audio inspection, or saving. An administrator can retry or dismiss each failure.

The existing download workflow was refactored so every download, including a retry, passes through the same duplicate checks, queue, fallback, completion, and cleanup logic. A retry creates a new attempt ID while episode identity is determined by podcast plus episode GUID, with the enclosure URL used when a GUID is unavailable. A retry is refused with an explanation when the episode is already active, queued, downloaded, or its podcast was removed. There are no automatic retry loops.

### How to check

Install the root dependencies and run the full server test suite:

```sh
npm ci
npm test
```

Build the web client:

```sh
cd client
npm ci
npm run generate
```

The podcast manager and library controller tests check the 50-item limit, failure categories, browser-reload snapshot, retry with a new attempt ID, successful and repeatedly failing retries, rapid duplicate requests, removed podcasts, active/queued/downloaded episodes, dismissal, queue continuation, and the existing untagged-download fallback.

### Results

- Full server suite: 389 passing, 0 failing.
- Client production build: successful.
- JSON and diff-format checks: successful.

### RFC changes and remaining work

The implementation follows the issue #9 RFC design. No issue #9 implementation work remains. Failed-download history intentionally resets when the server restarts, as specified in the RFC.

### Team integration

Issue #9 builds on issue #8's server-owned queue snapshot, adding failed attempts to the same snapshot without changing pending-download ordering. Downloads initiated by issue #7 use the same centralized download workflow, so their final failures are recorded and can be retried in the same way.

## ⚠️ Frontend pull requests are not being reviewed or merged for the existing Vue frontend. The frontend is currently being rewritten and migrated to React and should be available soon.

# About

Audiobookshelf is a self-hosted audiobook and podcast server.

### Features

- Fully **open-source**, including the [android & iOS app](https://github.com/advplyr/audiobookshelf-app) _(in beta)_
- Stream all audio formats on the fly
- Search and add podcasts to download episodes w/ auto-download
- Multi-user support w/ custom permissions
- Keeps progress per user and syncs across devices
- Auto-detects library updates, no need to re-scan
- Upload books and podcasts w/ bulk upload drag and drop folders
- Backup your metadata + automated daily backups
- Progressive Web App (PWA)
- Chromecast support on the web app and android app
- Fetch metadata and cover art from several sources
- Chapter editor and chapter lookup (using [Audnexus API](https://audnex.us/))
- Merge your audio files into a single m4b
- Embed metadata and cover image into your audio files
- Basic ebook support and ereader
  - Epub, pdf, cbr, cbz
  - Send ebook to device (i.e. Kindle)
- Open RSS feeds for podcasts and audiobooks

Is there a feature you are looking for? [Suggest it](https://github.com/advplyr/audiobookshelf/issues/new/choose)

Join us on [Discord](https://discord.gg/HQgCbd6E75)

### Demo

Check out the web client demo: https://audiobooks.dev/ (thanks for hosting [@Vito0912](https://github.com/Vito0912)!)

Username/password: `demo`/`demo` (user account)

### Android App (beta)

Try it out on the [Google Play Store](https://play.google.com/store/apps/details?id=com.audiobookshelf.app)

### iOS App (beta)

**Beta is currently full. Apple has a hard limit of 10k beta testers. Updates will be posted in Discord.**

Using Test Flight: https://testflight.apple.com/join/wiic7QIW **_(beta is full)_**

<br />

<img alt="Library Screenshot" src="https://github.com/advplyr/audiobookshelf/raw/master/images/DemoLibrary.png" />

<br />

# Organizing your media

#### Directory structure and folder names are important to Audiobookshelf!

See [library docs](https://audiobookshelf.org/docs/category/libraries) for supported directory structures, folder naming conventions, and audio file metadata usage.

<br />

# Installation

See [install docs](https://audiobookshelf.org/docs/category/installation)

<br />

# Reverse Proxy Set Up

#### Important! Audiobookshelf requires a websocket connection.

#### Note: Using a subfolder is supported with no additional changes but the path must be `/audiobookshelf` (this is not changeable). See [discussion](https://github.com/advplyr/audiobookshelf/discussions/3535)

See [reverse proxy docs](https://audiobookshelf.org/docs/category/reverse-proxy)

<br />

# Contributing

See [contributing docs](https://audiobookshelf.org/docs/contributing/general/)

### Localization

Thank you to [Weblate](https://hosted.weblate.org/engage/audiobookshelf/) for hosting our localization infrastructure pro-bono. If you want to see Audiobookshelf in your language, please help us localize. Additional information on helping with the translations [here](https://www.audiobookshelf.org/faq#how-do-i-help-with-translations). <a href="https://hosted.weblate.org/engage/audiobookshelf/"> <img src="https://hosted.weblate.org/widget/audiobookshelf/abs-web-client/multi-auto.svg" alt="Translation status" /> </a>

<br />

# Run from source

This application is built using [NodeJs](https://nodejs.org/).

### Dev Container Setup

The easiest way to begin developing this project is to use a dev container. An introduction to dev containers in VSCode can be found [here](https://code.visualstudio.com/docs/devcontainers/containers).

Required Software:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [VSCode](https://code.visualstudio.com/download)

_Note, it is possible to use other container software than Docker and IDEs other than VSCode. However, this setup is more complicated and not covered here._

<div>
<details>
<summary>Install the required software on Windows with <a href=(https://docs.microsoft.com/en-us/windows/package-manager/winget/#production-recommended)>winget</a></summary>

<p>
Note: This requires a PowerShell prompt with winget installed.  You should be able to copy and paste the code block to install.  If you use an elevated PowerShell prompt, UAC will not pop up during the installs.

```PowerShell
winget install -e --id Docker.DockerDesktop; `
winget install -e --id Microsoft.VisualStudioCode
```

</p>
</details>
</div>

<div>
<details>
<summary>Install the required software on MacOS with <a href=(https://snapcraft.io/)>homebrew</a></summary>

<p>

```sh
brew install --cask docker visual-studio-code
```

</p>
</details>
</div>

<div style="padding-bottom: 1em">
<details>
<summary>Install the required software on Linux with <a href=(https://brew.sh/)>snap</a></summary>

<p>

```sh
sudo snap install docker; \
sudo snap install code --classic
```

</p>
</details>
</div>

After installing these packages, you can now install the [Remote Development](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.vscode-remote-extensionpack) extension for VSCode. After installing this extension open the command pallet (`ctrl+shift+p` or `cmd+shift+p`) and select the command `>Dev Containers: Rebuild and Reopen in Container`. This will cause the development environment container to be built and launched.

You are now ready to start development!

### Manual Environment Setup

If you don't want to use the dev container, you can still develop this project. First, you will need to install [NodeJs](https://nodejs.org/) (version 20) and [FFmpeg](https://ffmpeg.org/).

Next you will need to create a `dev.js` file in the project's root directory. This contains configuration information and paths unique to your development environment. You can find an example of this file in `.devcontainer/dev.js`.

You are now ready to build the client:

```sh
npm ci
cd client
npm ci
npm run generate
cd ..
```

### Development Commands

After setting up your development environment, either using the dev container or using your own custom environment, the following commands will help you run the server and client.

To run the server, you can use the command `npm run dev`. This will compile the server and use the client that was built when you ran `npm run generate` in the client directory or when you started the dev container. Server changes are compiled and restarted automatically. If you make changes to the client, you will need to run the command `(cd client; npm run generate)` and then restart the server. By default the client runs at `localhost:3333`, though the port can be configured in `dev.js`.

You can also build a version of the client that supports live reloading. To do this, start the server, then run the command `(cd client; npm run dev)`. This will run a separate instance of the client at `localhost:3000` that will be automatically updated as you make changes to the client.

If you are using VSCode, this project includes a couple of pre-defined targets to speed up this process. First, if you build the project (`ctrl+shift+b` or `cmd+shift+b`) it will automatically generate the client. Next, there are debug commands for running the server and client. You can view these targets using the debug panel (bring it up with (`ctrl+shift+d` or `cmd+shift+d`):

- `Debug server`—Run the server.
- `Debug client (nuxt)`—Run the client with live reload.
- `Debug server and client (nuxt)`—Runs both the preceding two debug targets.
