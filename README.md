# OPEN QUIZ v7.1

Changes:
- Adds a third mode button: PC (host), respondent, projector.
- Projector mode can be selected from the same landing screen by entering the room code.
- Also supports direct projector URL: /display?room=ROOMCODE
- Projector shows question and optional question image.
- During answering it shows only each participant's LOCK status.
- During grading it shows only 採点中.
- When host publishes, it shows all participants' 〇/× and answer images.
- Keeps v6 scoring, 90-second timer, up to 8 participants, QR join, and per-question optional image upload.
- Explicit /display route avoids "Cannot GET" for projector mode.

ZIP structure is flat: server.js, package.json, public/index.html.
