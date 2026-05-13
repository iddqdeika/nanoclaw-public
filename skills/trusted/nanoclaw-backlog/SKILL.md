---
name: nanoclaw-backlog
description: Manage the Nanoclaw (Andy) improvement backlog — add, view, and close feature requests
---

# /backlog — Nanoclaw Backlog

This skill manages the personal improvement backlog for Nanoclaw (Andy). Use it to track feature requests, UX improvements, and integration ideas — with motivation and priority.

## Storage

Backlog lives at `/workspace/global/memory/nanoclaw-backlog.md`. Read and write this file directly.

## Commands

### `/backlog`
Show all items. Format:
- First: all **open** items, sorted by priority (высокий → средний → низкий)
- Then: all **closed** items, collapsed (title + date closed only)

### `/backlog add [text]`
Add a new item. If text is provided, use it as the title. Then ask:
1. Мотивация — зачем это нужно? (one sentence)
2. Приоритет — высокий / средний / низкий

Generate a short ID: `NB-{N}` where N is next sequential number.

Append to the file in this format:
```
## NB-{N} — {title}
- **Приоритет:** высокий | средний | низкий
- **Статус:** открыт
- **Добавлен:** YYYY-MM-DD
- **Мотивация:** {motivation}
```

### `/backlog close <id>`
Close an item. Ask for a brief closing note (optional). Update the item:
```
- **Статус:** закрыт
- **Закрыт:** YYYY-MM-DD
- **Итог:** {note}
```

### `/backlog comment <id> <text>`
Append a comment to an item:
```
- **Комментарий YYYY-MM-DD:** {text}
```

## Proactive detection

During any conversation, if the user says something like:
- "хочу чтобы ты..."
- "было бы хорошо если..."
- "добавь в беклог"
- "запомни что хочу..."
- "надо бы сделать..."

→ After completing the main response, suggest: "Добавить это в беклог Nanoclaw? (NB-{N})"

If user confirms — add the item, using their phrase as title and asking for priority.

## File format (full example)

```markdown
# Nanoclaw Backlog

_Беклог доработок Nanoclaw (Andy). Обновляется по мере обсуждения._

---

## NB-1 — Проактивное предложение добавить в беклог
- **Приоритет:** высокий
- **Статус:** открыт
- **Добавлен:** 2026-04-13
- **Мотивация:** Не терять идеи, которые звучат в разговоре мимоходом

## NB-2 — Интеграция с Grafana алертами
- **Приоритет:** средний
- **Статус:** закрыт
- **Добавлен:** 2026-04-10
- **Закрыт:** 2026-04-13
- **Итог:** Реализовано через alerting_manage_rules
```
