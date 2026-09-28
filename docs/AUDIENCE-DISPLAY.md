# Audience Display Specification

## Purpose
The audience display is a fullscreen broadcast-style surface for the competition. It must always communicate the current competition state clearly without exposing private answer correctness before a question is closed.

## Persistent layout

### Header
Persistent brand area:
- University of Babylon logo
- Student Activities Department logo
- configurable event title
- configurable subtitle / venue / season text

### Main Stage
Primary content area. Its content changes according to the audience display state.

### Ranking Sidebar
Persistent side area used primarily for the overall ranking, with optional alternate content during selected presentation states.

### Footer / Information Strip
Configurable lower-third style area for:
- current round
- current question
- next round
- announcements
- custom operator text

## Configurable visible terminology
All audience-facing Arabic labels are editable in competition settings. Internal code names remain stable.

Default terms:
- Round: جولة
- Current round: الجولة الحالية
- Next round: الجولة القادمة
- Ranking: الترتيب العام
- Question: السؤال
- Correct answer: الإجابة الصحيحة
- Intermission: استراحة قصيرة
- Final results: النتائج النهائية

## Official audience display states

### WELCOME
Used before the competition starts.

Main Stage:
- event title
- welcome message
- optional venue/season text

Sidebar:
- hidden, event information, or participant count

Footer:
- configurable welcome/status text

### DRAW_INTRO
Introduces the draw.

Main Stage:
- draw title
- number of participating colleges
- optional explanatory text

Sidebar:
- participant list or draw status

### DRAW_ACTIVE
Animated draw in progress.

Main Stage:
- animated college cards/names
- pairing reveal

Sidebar:
- drawn / remaining participants

### DRAW_COMPLETE
Official ordered round list after the draw.

Main Stage:
- ordered round schedule
- paired and solo rounds

Sidebar:
- participant summary

### ROUND_INTRO
Introduces the selected round.

Main Stage:
- round number/name
- College A vs College B
- solo-round variant when applicable

Sidebar:
- overall ranking or next-round information

### QUESTION_READY
Operator has prepared the next question, but it is not visible to competitors/audience yet.

Main Stage:
- configurable ready message
- question number
- category
- "استعدوا" style prompt

Sidebar:
- current ranking

### QUESTION_COUNTDOWN
Three-second presentation countdown.

Main Stage:
- full-size 3
- then 2
- then 1

Behavior:
- question text/options remain hidden
- authoritative 45-second question timer has not started yet
- OSC prestart cues may be emitted

### QUESTION_ACTIVE
The question is live.

Main Stage:
- question number
- category
- question text
- four answer options: A, B, C, D
- authoritative countdown timer from 45 seconds

Team status:
- waiting / answer received for each active team
- never reveal selected option or correctness while question is active

Sidebar:
- overall ranking
- active teams highlighted if desired

### QUESTION_CLOSED
Answers are locked; reveal has not happened yet.

Main Stage:
- question remains visible
- "تم استلام الإجابات" or timeout state
- no correctness shown yet

Sidebar:
- ranking remains unchanged until reveal is committed

### QUESTION_REVEAL
Transparent post-question result.

Main Stage:
- official correct option
- each team's submitted option
- correct/wrong result
- official response time
- awarded points
- updated round totals

Sidebar:
- overall ranking updates after reveal is committed
- rank movement may be animated

### BETWEEN_QUESTIONS
Hold state controlled by the operator.

Main Stage:
- previous result summary, next-question message, or custom announcement

Sidebar:
- current ranking

No automatic transition to the next question.

### ROUND_COMPLETE
Shown after question 10.

Main Stage:
- round completed message
- both colleges' round totals, or solo result

Sidebar:
- recalculated overall ranking

Footer:
- optional next-round preview

### NEXT_ROUND
Used while changing competitors.

Main Stage:
- configurable "الجولة القادمة" message
- next selected colleges
- optional start-soon text

Sidebar:
- ranking or schedule

### INTERMISSION
Manual operator-controlled break state.

Main Stage:
- configurable break/hold message

Sidebar:
- ranking, hidden, or configurable alternate information

### FINAL_RESULTS
Competition results presentation.

Main Stage:
- final results title
- ordered final ranking
- emphasized top positions

Sidebar:
- optional statistics or hidden

## Question presentation rules
- Qualification questions are multiple-choice only.
- Every qualification question has exactly four options: A, B, C, D.
- The question and options are not shown during QUESTION_COUNTDOWN.
- The authoritative question clock starts when the state changes to QUESTION_ACTIVE, immediately after the 3-2-1 countdown.
- Every question is started explicitly by the operator.
- Reveal is also operator-controlled.

## Ranking behavior
- The ranking is recalculated after each committed question reveal.
- PLAYING, COMPLETED and NOT_STARTED are distinct states.
- NOT_STARTED colleges must not be presented as having a competitive score of zero.
- A configurable mode may show all colleges or a condensed top subset, but the full ranking must always be available.

## Branding and editable content
Configurable presentation settings include:
- University logo
- department logo
- competition title
- subtitle
- venue
- season/year
- welcome message
- ready message
- intermission message
- next-round message
- round-complete message
- final-results title
- footer text
- selected terminology labels

## Safety and recovery
The display is a read-only projection of authoritative server state. Refreshing or reconnecting the display must restore the current state without advancing the competition.
