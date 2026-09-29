# UniQuiz

Realtime university knowledge competition platform.

## Product name
**مسابقة بنك المعلومات**

## Core qualification rules
- Up to 20 colleges can be configured; the operator selects the actual participants before the draw.
- The draw creates ordered qualification sessions, normally two colleges per session; an odd participant may receive a solo session.
- Qualification is score-based, not knockout.
- Every session uses 10 unique questions.
- Each session contains 5 categories with 2 questions from each category.
- All questions are treated as one common difficulty level.
- Every question has a 25-second answer window.
- A correct answer earns the displayed whole-number second remaining: 25 points at 25 seconds, decreasing by one point each second down to 1.
- Wrong or unanswered answers earn 0 points.
- The audience display reveals correctness, response time, and awarded points after each question.
- The overall ranking updates after each reveal.

## Runtime topology
- Mac: authoritative server + operator console + audience display output.
- Team A Windows PC: browser-only answer station.
- Team B Windows PC: browser-only answer station.
- Local-first networking; internet is not required during the competition.

## Repository structure
This repository will be a single monorepo containing the server, web UI, shared types, documentation, and tooling.

> Real competition question banks and answers must not be committed to Git.
