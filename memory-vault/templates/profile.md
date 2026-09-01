---
type: Profile
title: <% tp.file.title %>
description: <fill me>
resource: ""
tags: []
timestamp: <% tp.date.now("YYYY-MM-DDTHH:mm:ssZ") %>
project: <% tp.user.config.project_name ?? "" %>
---

# <% tp.file.title %>

Synthesized profile for this project. Capture tech stack, architectural patterns, environment, workflow preferences, and known constraints. Profile entries deduplicate by `(project, type)` — saving a new profile overwrites the previous one.
