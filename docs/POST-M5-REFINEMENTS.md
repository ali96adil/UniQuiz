# Post-M5 Presentation, Scoring & Official Results Refinement

Status: in progress
Base: M5 merged on `main`

## Requested event-day refinements

1. Increase both audience header logos while preserving layout balance.
2. Add persistent Arabic patronage/supervision lines to the audience presentation:
   - برعاية السيد رئيس جامعة بابل الاستاذ الدكتور امين عجيل ياسر الياسري المحترم
   - وإشراف الاستاذ الدكتور ميثاق طالب عبد الجبوري مساعد رئيس الجامعة للشؤون الإدارية المحترم
3. Fix final-ranking presentation so the same college is not visually duplicated in the featured/final podium composition.
4. Change the authoritative answer window to 25 seconds.
5. Scoring rule:
   - correct answer score equals the displayed remaining whole second;
   - 25 seconds remaining = 25 points, 24 = 24, ... 1 = 1;
   - timeout / wrong / no answer = 0.
6. Remove the unnecessary audience interstitial between consecutive questions so the flow advances directly to the next useful question state.
7. Add cumulative answer time per college to the qualification ranking and final results.
8. Add an operator export action for an official A4 PDF results statement after qualification completion.

## Official PDF statement

The PDF must be print-ready and include:
- University and Student Activities Department logos.
- Competition title and organizational identity.
- Patronage and supervision lines.
- Export date/time.
- Official final ranking for all participating colleges.
- Rank, college name, total score, cumulative answer time, and counted/revealed question count.
- Clearly distinguished top three places.
- A clean formal layout suitable for archiving and official circulation.

The PDF must be generated from authoritative persisted competition results, not from a screenshot of the audience display.
