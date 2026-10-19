# Del-Discord

Delete your Discord messages, remove reactions, and save conversations from one browser toolbar.

[![Version: v2.5.0][version-badge]][script]
[![License: MIT][license-badge]][license]

[![Install from Greasy Fork][greasyfork-button]][greasyfork] [![Install from GitHub][manual-button]][script]

https://github.com/user-attachments/assets/4feff1ed-a4c5-4532-8b0d-e33aaccc0011

Found this useful? [Star the repository](https://github.com/azhomy/Del-Discord).

[How to use](#how-to-use) · [Install](#install) · [Build](#build-from-source) · [Uninstall](#uninstall) · [Help][bug-report] · [License](#license)

## Summary

Del-Discord adds cleanup tools to Discord in your browser. Use it to manage your messages in direct messages (DMs), server channels, and forum threads.

- Delete messages or replace their text.
- Remove text while keeping links and attached files.
- Choose messages by date, text, or file type.
- Set up several cleanups and run them in order.
- Remove your reactions from messages.
- Save a copy of a conversation, including its attached files.
- Find older DMs and reopen them.

Del-Discord works on the Discord website. It does not work in the desktop or mobile app.

> [!CAUTION]
> [Discord does not allow this kind of automation][self-bot-policy] and may ban your account. Deleted messages cannot be restored. Save anything you want to keep before you delete it.

## Install

### 1. Install a userscript manager

A userscript manager is a browser extension that lets Del-Discord run. Install one from the table below. Skip this step if you already have one.

| Browser | Userscript manager |
| :--- | :--- |
| Chrome / Brave | [Tampermonkey][tampermonkey] or [Violentmonkey][violentmonkey] |
| Firefox | [Greasemonkey][greasemonkey], [Tampermonkey][tampermonkey], or [Violentmonkey][violentmonkey] |
| Edge | [Tampermonkey][tampermonkey] |

### 2. Install Del-Discord

Open [Del-Discord on Greasy Fork][greasyfork]. Click Install this script and confirm when your userscript manager asks.

To install from GitHub instead:

1. Open [the script][script] and click Raw.
2. Copy all of the text.
3. Open your userscript manager and choose Create a new script.
4. Replace the sample text with the text you copied. Save it.

Make sure Del-Discord is turned on. Allow the extension to run on Discord. If your browser shows an Allow User Scripts setting, turn it on.

<img src="./.github/assets/allow-user-scripts.png" alt="Tampermonkey extension settings showing where to turn on Allow User Scripts" width="760">

### 3. Open Discord

Open [Discord in your browser][discord] and refresh the page. Enter a DM or channel, then click the trash-can button at the top.

Installing Del-Discord does not delete anything. You choose when to start.

## How to use

### Clean up messages

Open the conversation you want to clean up, then open Del-Discord and go to Messages. Choose DMs, Channel, Server, or Forum/Thread. Check the person and conversation under Conversation & authorization. Under Action, choose whether to delete messages, replace their text, or remove text while keeping links and files. Add any filters you need and leave Scan all matches before cleanup checked. Pinned messages are kept by default. Click Start, review the messages, and confirm. For a forum, load and select its threads, then click Clean selected threads. Use Stop to end a cleanup. It does not undo changes already made.

### Save a conversation

Click Export Conversation, choose your dates and a file type, then click Export. Leave the dates blank to save all available messages. Pick CSV to open the file in a spreadsheet app. The saved copy includes other people's messages and does not use your cleanup filters. Turn on Download actual attachments (ZIP) to save the files too. Without it, the saved copy only includes links to them.

### Run several cleanups

Set up each cleanup in Messages and click Add to Queue. Review the list in Queue and click Start Queue. These jobs use the settings you already approved and run without another confirmation. Use Stop Queue to stop them. You can continue a saved queue when you reopen Del-Discord. To target specific messages, open Message IDs in Queue, paste message links or use Import ID file, then click Run IDs.

### Remove reactions

Open Reactions, check the channel, and leave Author(s) blank to target your own reactions. Click Scan and remove, review the result, and confirm.

### Find older DMs

Open DM History and click Refresh & Verify. Search for a person and click Open DM. If you have a Discord data package, unzip it and use Import Data Package to add its conversations. Select DMs and click Delete All to delete your messages in them, including pinned messages. Other people's messages and the conversations stay. Clear Saved only removes the saved DM list from your browser.

## Build from source

This section is for people who want to change the code. To use Del-Discord, follow [Install](#install) above.

Install Git, Node.js 24 or later, and npm. Then run:

```bash
git clone https://github.com/azhomy/Del-Discord.git
cd Del-Discord
npm ci
npm run build
```

The finished script is in [`dist/Del-Discord-v1.user.js`][script]. Copy its contents into your userscript manager to install it. Run `npm run verify` to check your code changes.

## Uninstall

1. Stop any cleanup that is running.
2. Open your userscript manager and remove Del-Discord.
3. Refresh any open Discord tabs.

You can turn the script off instead if you only want a break.

To remove saved settings before uninstalling, use Clear Filters in Messages, Clear Queue in Queue, and Clear Saved in DM History. Some browser settings and downloaded files may remain.

Uninstalling does not bring back deleted messages or undo text changes.

Need help? [Report a problem][bug-report]. Keep login details and private messages out of your report.

## Contributing

[Report bugs or suggest improvements][issues]. For code changes, open a pull request to `staging` and run `npm run verify` before submitting.

## License

[MIT License][license] © 2026 Del-Discord contributors.

[version-badge]: https://img.shields.io/badge/version-v2.5.0-5865F2?style=flat-square
[license-badge]: https://img.shields.io/badge/license-MIT-22C55E?style=flat-square
[greasyfork-button]: ./.github/assets/install-greasyfork.svg
[manual-button]: ./.github/assets/manual-script.svg
[script]: ./dist/Del-Discord-v1.user.js
[license]: ./LICENSE
[discord]: https://discord.com/channels/@me
[greasyfork]: https://greasyfork.org/en/scripts/599469-del-discord
[tampermonkey]: https://www.tampermonkey.net/
[violentmonkey]: https://violentmonkey.github.io/
[greasemonkey]: https://addons.mozilla.org/firefox/addon/greasemonkey/
[self-bot-policy]: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
[bug-report]: https://github.com/azhomy/Del-Discord/issues/new?template=bugreport.yml
[issues]: https://github.com/azhomy/Del-Discord/issues
