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
- Each question has a 25-second answer window.
- A correct answer earns the displayed whole-number second remaining: 25 → 25 points, 24 → 24 points, …, 1 → 1 point.
- At 25,000 ms / timer 0, the answer window has expired and the score is 0.
- Wrong answers earn 0 points.
- Unanswered questions earn 0 points.
- No fractional points are awarded.

The authoritative response time is measured by the server using a monotonic clock at millisecond precision.

For the cumulative response-time figure shown in the ranking and official report, a revealed question with no submitted answer counts as the full 25-second window. This cumulative time is informational and does not change rank when points are tied.

## Reveal and transparency
When all required stations have answered, UniQuiz closes the question immediately, emits the answered OSC cue, waits 1.5 seconds, and reveals automatically. Timeout closure retains the explicit operator Reveal action.

After Reveal, the audience display shows for each active college:
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
