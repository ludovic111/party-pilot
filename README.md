<p align="center"><img src="icons/logo.svg" width="128" alt="Party Pilot logo"></p>

<h1 align="center">Party Pilot</h1>

<p align="center"><b>BombParty · PopSauce · Krillion</b><br>
A browser extension that plays word and trivia party games with you.</p>

> [!WARNING]
> **For educational purposes only.** This project shows how a browser extension can read a web game's state,
> react to its live events and call an AI model. Using it against other people spoils their game and may break
> the rules of jklm.fun or krillion.io. Use it in your own private rooms, at your own risk.

## Games

| Game | Site | What Party Pilot does |
| --- | --- | --- |
| [BombParty](#bombparty) | jklm.fun | Finds a word for the prompt in under a millisecond, in every language, going for extra lives |
| [PopSauce](#popsauce) | jklm.fun | Answers questions it has seen before instantly, asks Claude about new ones (images included) |
| [Krillion](#krillion) | krillion.io | Suggests rare but valid answers in every mode, plays Puffer Party turns instantly |

Each game gets a panel inside the page, in the same style: what it just played, how fast, and its settings.
`Alt+W` pauses or resumes it in any game. The toolbar popup holds the settings and lifetime stats.

## BombParty

- **Detects the game's language automatically** from the room's dictionary and loads the matching word list:
  English, French, German, Spanish, Brazilian Portuguese, Breton, Nahuatl and the three Pokémon dictionaries.
  For languages it has no list for (Italian, Basque…), it learns the words other players get accepted.
- **Goes for extra lives**: it picks the word that covers the most missing bonus letters, rare letters first
  (Q, J, K, W…), then the shortest one.
- **Is fast**: it reacts to the server's `nextTurn` event and submits through the game's socket in under a
  millisecond. An index of two-letter sequences finds a word in under a millisecond, even in the 660,000-word
  German list. In a test game, a word was accepted 40 to 110 ms after the turn started, network included.
- **Learns**: words the server refuses are remembered per language and never tried again. Words other players
  get accepted are added to the list.
- **Instant or human mode**: send the word at once, or type it at a chosen speed (WPM) after a chosen reaction delay.

## PopSauce

- **Remembers answers**: when a challenge ends, the game reveals the answer. Party Pilot stores it under a hash
  of the question (and its image or text), so the next time the same challenge comes up it answers instantly.
- **Asks Claude about new challenges**: unknown questions, images included, go to Claude (Haiku 5.5 by default,
  about $0.0002 per question). It sends up to three guesses, the next one only if the previous one was wrong.
  In a test game, it found 4 challenges out of 5, each in 1.3 to 2 seconds.
- **Settings**: AI on or off, and a delay before answering.

## Krillion

Krillion keeps its answers on its server, so Party Pilot never looks for them there: it reads the prompt shown on
the page and asks Claude for answers that are rare but certainly valid (rarer answers score more).

- **Daily dive, Unlimited, archive, themed packs**: as soon as a prompt appears, Claude returns about 14 answers,
  rarest first, shown as chips in the panel. Click one to type it, double-click to send it. **Auto** mode (off by
  default) sends the best untried answer, at most one per second, accepts the game's spelling corrections and moves
  on to the next prompt. In a test, a full Unlimited dive went 7 for 7 (6 answers scored "rare"), and the movies pack
  7 of 7.
- **Puffer Party**: Party Pilot follows the room from the updates the page already receives, remembers every answer
  used or rejected in the room, and fetches answers for each new category ahead of time. On your turn it answers in
  about 1 to 120 ms. A delay setting (0 to 3 s) makes it look human. In a private test room it passed the puffer 27
  times with no repeated answer.

Turning auto on in the daily dive submits to the real daily leaderboard.

## Claude API key

PopSauce and Krillion need a Claude API key. Paste it in the popup (**IA** section), or put it in a file named
`ai-key.local.json` next to `manifest.json`:

```json
{"apiKey": "sk-ant-…"}
```

That file is ignored by git. The key only goes to `api.anthropic.com`, from the extension's background worker;
game pages never see it. The popup also lets you pick the model: Haiku 5.5 (fastest, cheapest), Sonnet 5.5 or Opus 5.5.

## Install

1. Download this repository (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` (`helium://extensions` in Helium, `brave://extensions` in Brave) and turn on
   **Developer mode**.
3. Click **Load unpacked** and pick the folder.
4. Open a BombParty or PopSauce room on jklm.fun, or krillion.io.

Turn off other helpers for the same game (such as Bomb Party Buddy): two scripts would answer at once.

## How it works

| Path | Role |
| --- | --- |
| `core.js` | BombParty: language detection, dictionary index, word choice (no DOM) |
| `bot.js` | BombParty: runs in the game page, listens to the game socket, plays, draws the panel |
| `bridge.js` | BombParty: isolated content script serving word lists, settings, stats and learned words |
| `words/` | BombParty: one normalized word list per language, sorted by length |
| `popsauce/` | PopSauce: bridge (storage, Claude requests) and the page bot with its panel |
| `krillion/` | Krillion: `tap.js` relays the party room updates the page receives; `helper.js` holds the logic, Claude calls and panel |
| `background.js` | Service worker: the only code that calls the Claude API |
| `popup/` | Toolbar popup: settings, lifetime stats, AI model and key |
| `icons/` | Logo (`logo.svg`) and toolbar icons |

## Credits

BombParty word lists come from [NiTrO0FuN/bomb-party-buddy](https://github.com/NiTrO0FuN/bomb-party-buddy)
(MIT, see `WORDLIST-LICENSE.txt`). Party Pilot itself is under the MIT license (`LICENSE`).

*Built by Ludovic Marie's AI agent (Claude Code).*
