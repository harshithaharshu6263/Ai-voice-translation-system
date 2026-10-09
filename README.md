# VoiceTranslate

A Flask translation workspace running at http://127.0.0.1:8500.

## Features

- Register and sign in with hashed passwords; update your name or password.
- Translate text across the languages supported by Google Translate. Input defaults to automatic language detection. The displayed language is an estimate, especially for short or mixed text.
- Record speech in Chrome or Edge, edit the transcript, and then translate. Choose the spoken language for microphone recognition; automatic text detection does not detect spoken audio languages.
- Upload WAV, MP3, M4A, OGG, WebM, FLAC, or AAC recordings (25 MB / 2 minutes maximum). FFmpeg converts recordings; the online Google speech service transcribes them. Uploads are deleted after processing.
- Two-person conversation mode: choose each person's spoken language and take turns, with optional translated playback. Typed turns work without a microphone.
- Private, persistent SQLite history with search, pagination, replay, deletion, and a favorite phrasebook.
- Listen using a matching installed system voice or generated online audio. Playback speed is adjustable. MP3 downloads depend on gTTS language support.
- Download UTF-8 text and Word documents. Print / PDF opens the browser's print dialog: choose Save as PDF. The print layout contains only the original text and translation and supports the browser's multilingual font rendering.
- Email original and translated text with an optional Word document, translated MP3, saved PDF, or your audio recording, when SMTP is configured. To attach a PDF, save it using Print / PDF and select the saved file in the email dialog.
- Responsive layout, dark/light theme, larger text, keyboard navigation, live status announcements, and clear recording indicators. Ctrl/Cmd + Enter translates; Escape stops recording/playback.

## Run

From this directory, create an environment and install dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

The default port is 8500. To change it, set PORT in the environment or .env.

For the locally installed .dependencies folder, use:

```powershell
.\start.ps1
```

Or:

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) '.dependencies'
python app.py
```

Open http://127.0.0.1:8500. The existing demo login remains `harshita@gmail.com` / `1234`. Create an account for your own history. A demo account is seeded only when DEMO_LOGIN=true; disabling this does not remove a previously created account. Change the demo password through Profile if needed.

## Email configuration

Copy .env.example to .env and enter your SMTP username and password. For Gmail, use an App Password. Restart the app after editing the configuration. Emails are sent only when the user clicks Send email.

The app generates a persistent session secret in instance/secret.key; SECRET_KEY can override it. Accounts and history are stored in instance/voice_translate.sqlite3. Keep instance/ to retain them. .env, instance/, dependency folders, and logs are excluded from Git.

## Verification

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) '.dependencies'
python -m unittest -v test_workspace
```

Tests use a temporary database, mocked online services, and real FFmpeg audio conversion. They check authentication, CSRF, account isolation, history, favorites, pagination, Unicode exports, uploads, profile changes, and email attachments.

An optional online smoke test uses synthetic audio and a temporary account, without sending email or adding data to your account database:

```powershell
python smoke_services.py
```

## Service requirements

Translation, generated speech, and recognition need an internet connection. Live microphone recognition also requires browser permission and browser support; use typed input or uploaded recordings when live recording is unavailable. Downloadable speech has fewer supported languages than translation. Short and mixed-language text can be misidentified: select the source language manually if needed.

Translation uses Google's public web endpoint with explicit connection/read timeouts; deep-translator supplies the language list. Audio recognition uses the SpeechRecognition library's Google service over HTTPS. These free services can rate-limit requests or change availability.

The server binds to localhost by default. HOST can be set for another deployment. Use a production WSGI server, HTTPS, COOKIE_SECURE=true, and a strong SECRET_KEY for a public deployment.

## Files

- app.py: startup entry point
- workspace.py: routes, accounts, persistence, transcription, exports, email
- templates/auth.html and templates/workspace.html: active pages
- static/workspace.js, preferences.js, workspace.css: interface and accessibility
- test_workspace.py: regression tests
- start.ps1: local launcher

Speech upload libraries: https://pypi.org/project/SpeechRecognition/ and https://github.com/imageio/imageio-ffmpeg
