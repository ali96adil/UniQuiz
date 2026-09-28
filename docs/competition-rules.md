# Qualification Rules

## Participants
- The operator configures up to 20 colleges.
- Before the draw, the operator selects the colleges that are actually participating.
- The participant count may be even or odd.
- With an odd count, one college may compete in a solo qualification session.

## Qualification model
- Qualification is score-based, not knockout.
- Every college completes exactly one qualification session.
- A normal session contains two colleges answering the same questions at the same time.
- A solo session follows the same scoring and timing rules.
- The final qualification ranking is based on accumulated points.

## Questions
- Each session contains 10 unique questions.
- Questions must not repeat across qualification sessions in the same competition.
- Each session contains 5 categories.
- Each category contributes exactly 2 questions.
- All questions use one common difficulty level.
- Category ordering may be shuffled while preserving the 2-per-category rule.

## Timing and scoring
- Each question has a 45-second answer window.
- Correct answers submitted in 5 seconds or less earn 10 points.
- Correct answers submitted after 5 seconds decrease continuously to 1 point at 45 seconds.
- Wrong answers earn 0 points.
- Unanswered questions earn 0 points.

For a correct answer with response time t in seconds:

```
if t <= 5:
  score = 10
else if t <= 45:
  score = 10 - ((t - 5) * 9 / 40)
else:
  score = 0
```

The authoritative response time is measured by the server using a monotonic clock.

## Reveal and transparency
After each question is closed, the audience display reveals for each active college:
- submitted answer;
- correct or wrong state;
- response time;
- awarded points;
- official correct answer.

The overall ranking is recalculated and published after each reveal.

## Ranking states
A college can be:
- PLAYING
- COMPLETED
- NOT_STARTED

Colleges that have not started must not be presented as having zero competitive points.

## Auditability
The server records question start time, submission time, submitted answer, correctness, response duration, awarded points, and reveal time for every response.
