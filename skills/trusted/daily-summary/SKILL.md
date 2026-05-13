---
name: daily-summary
description: Summarize all notable events, conversations, incidents, and decisions across all groups for a given period. Groups threaded messages, includes citations and links. Save to global memory.
---

# /daily-summary — Cross-Group Daily Summary

Generate a structured summary of everything notable that happened across all registered groups.

## Mandatory Rule: Citations Over Paraphrase

**ANY summarizable data MUST be rendered as a direct quote (citation), not as a paraphrase or task description.**

- ✅ Correct: > «Фиксирую крайне низкие показатели качества по ЭП d0c00ba5» — Ivlev, #p_resale_sales, 13:37
- ❌ Wrong: Ivlev reported quality issues with endpoint d0c00ba5
- ✅ Correct: > «надо решать проблему ребята» — Octoclick2025
- ❌ Wrong: The client asked to fix the problem

If you cannot quote verbatim, do not include the item. No paraphrase. No task language.

**Bot replies (is_from_me = 1):** Include them, but compress to one line of essential meaning only. Format:
> *[Bot: краткий смысл ответа]* — Andy, HH:MM

Example:
> *[Bot: запросил все таблицы dsp из ClickHouse, вернул список из 27 таблиц]* — Andy, 22:12

Never omit bot replies from threads — they show what action was taken or what information was provided.

## Steps

### 1. Determine time range

Default: last 24 hours. Accept optional argument (e.g. `/daily-summary 2026-04-07` for a specific date).

### 2. Query all messages including bot replies

```python
import sqlite3
conn = sqlite3.connect('/workspace/project/store/messages.db')
rows = conn.execute("""
    SELECT m.id, m.chat_jid, c.name AS group_name, m.sender_name,
           m.content, m.timestamp, m.thread_id, m.is_from_me
    FROM messages m
    JOIN chats c ON m.chat_jid = c.jid
    WHERE m.timestamp >= datetime('now', '-1 day')
      AND m.is_bot_message = 0
      AND m.content IS NOT NULL
      AND m.content != ''
    ORDER BY m.chat_jid, COALESCE(m.thread_id, m.id), m.timestamp ASC
    LIMIT 300
""").fetchall()
conn.close()
```

### 3. Group threads

Messages with the same `thread_id` form a thread:
- Thread root = message where `id == thread_id`
- Thread replies = messages where `thread_id == root_id` but `id != thread_id`
- Standalone messages = `thread_id IS NULL`

Keep threads together as a unit. Do not split replies across sections.

### 4. Identify notable items

For each group, scan for:
- **Incidents** — keywords: инцидент, incident, алерт, alert, упало, down, ошибка, error, критично, critical, выключили, выключил, сломано, сломалось, проблема
- **Decisions** — keywords: решили, договорились, окейси, согласовали, принято, утвердили
- **Questions/issues raised** — unresolved threads with 2+ replies
- **Notable standalone messages** — announcements, status updates, reports

Skip: single-word test messages with no context ("status", "hi", "ONE", "two", "three", "regular", "threaded"), bot commands that produced no meaningful result.

### 5. Tags

For each incident, conversation, or decision, generate a tags block immediately after the title:

```
**Tags:** #Ivlev #YakovGrishchenko #Octoclick2025 #endpoint-d0c00ba5 #quality #kaминари #adScore #popunder #p_resale_sales
```

Tag rules:
- **Persons:** all people who sent at least one message in the thread — `#FirstnameSurname` (no spaces, CamelCase)
- **Key terminology:** product names, system names, IDs, error codes, endpoint names — `#name`
- **Group:** the Slack/Telegram channel name — `#channel-name`
- **Topic keywords:** 2–5 words that describe the topic — `#quality`, `#billing`, `#mismatch`, `#feed`
- Use English or the language of the original term — don't translate proper nouns
- No generic tags like `#message` or `#update`

### 6. Format the summary

```
# Summary — [DATE]

## Incidents

### [Group name] — [time range]
**Tags:** #Person1 #Person2 #term1 #term2 #channel

> «[exact root message quote]»
— [sender], [time]

> «[exact reply]»
— [sender], [time]

> *[Bot: one-line compressed summary of bot action/response]*  — Andy, [time]

> «[exact reply]»
— [sender], [time]

---

## Decisions

### [Topic] — [group] — [time]
**Tags:** #Person1 #Person2 #term

> «[exact quote of decision]»
— [sender], [time]

---

## Notable Conversations

### [Topic / group] — [time range]
**Tags:** #Person1 #term1 #term2

> «[root message]»
— [sender], [time]

> «[reply]»
— [sender], [time]

---

## Links
- [URL] — context from message — [sender], [group], [time]
```

### 7. Save to global memory

```bash
mkdir -p /workspace/global/memory
DATE=$(date +%Y-%m-%d)
```

Write the summary to `/workspace/global/memory/${DATE}-summary.md`.

Update index:
```bash
echo "- [${DATE}-summary.md](${DATE}-summary.md) — Daily summary ${DATE}" >> /workspace/global/memory/INDEX.md
```

### 8. Report back

Send the formatted summary to the user. If long, lead with Incidents, note that the full version is saved to global memory.

## Example output

### p_resale_sales — 07:00–08:00
**Tags:** #YakovGrishchenko #AleksandrIvlev #GeorgyShamiryan #SSP-5028 #billing #historicalData #p_resale_sales

> «не всё так хорошо как хотелось бы. Есть вопросы еще. Если стата с группировками по сорсам и гео будет доступна, например, только со вчерашнего дня, будет норм?»
— Yakov Grishchenko, 07:00

> «Я думаю, что это не ок, так как изначальная цель у рекла была, это сверка за прошлые периоды»
— Aleksandr Ivlev, 07:03

> «давайте остановимся на выше предложенном варианте. Реклу просто скажем, что в нашем апи есть ограничение по хранению старых данных»
— Alice Shamiryan, 07:08
