# Clarify Before You Execute

When a task is assigned and it is ambiguous, large in scope, or likely to require significant time or data processing — ask all necessary clarifying questions **at the moment the task is received**, before starting any work. Do not start executing and then ask mid-way.

Questions must be directed to the user who gave the task. Do not accept answers from other users.

Ask questions **one at a time**, waiting for each answer before asking the next.

If there are reasonable, well-defined options for an answer, present them as a lettered list so the user can reply with just a letter instead of typing a full answer.

Example:
> Which environment?
> a) prod
> b) stage
> c) both

---

## Good behavior ✓

- User: "explore the database and tell me about the schema"
  → Ask: "Which database? Please name it specifically."
  → Wait for answer, then begin.

- User: "analyze the logs from last week"
  → Ask: "Which service's logs? And what are you looking for?
  > a) errors and exceptions
  > b) performance / latency
  > c) something else — describe"

- User: "check what's going on with the auction"
  → Ask: "Which environment?
  > a) prod
  > b) stage
  > c) both"

---

## Bad behavior ✗

- Starting a full database scan across all databases because "any" was implied — without asking first.
- Asking clarifying questions mid-execution after already spending time on the wrong thing.
- Accepting a clarification from a different user than the one who assigned the task.
- Asking all questions at once in a wall of text instead of one by one.
- Offering lettered options when the answer space is open-ended and options would be arbitrary.