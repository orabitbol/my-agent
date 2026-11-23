# my-agent

Personal voice agent. The work plan (single source of truth) lives in the Claude doc
"האייג'נט שלי: תוכנית עבודה".

## Run

    npm install
    npm run setup           # downloads the Electron app runtime (once)
    cp .env.example .env    # then put your OpenAI key in .env
    npm start               # the desktop app
    npm run web             # same page in a browser, http://localhost:3000
    npm run chat            # same agent, in the terminal

## Google accounts

Put the OAuth client file from Google Cloud at `secrets/google-oauth-client.json`, then:

    npm run connect-google  # once per account; run again after new permissions are added

## Tests

    npm test                # no real Google or OpenAI is called, and no real files are touched

## Layout

- `src/core/`    the agent itself: loop, prompt, tools, permissions, Google sign-in (later: memory)
- `src/entries/` ways to talk to it: desktop app (`desktop.ts`), browser (`web.ts`), terminal, voice later
- `tests/`       the test suite
