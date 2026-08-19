---
name: gh-commit
description: Analyze the Git diff and create logical, atomic commits.
---

<!-- @format -->

# Commit

Analyze the Git diff and organize changes into logical, atomic commits.

## When to use

Use this skill when:

- Implementation is complete.
- Changes are ready to be committed.

Do not use this skill for:

- GitHub Issues
- Pull Requests

---

## Principles

- One commit should have one purpose.
- Split unrelated changes into separate commits.
- Keep refactoring separate from feature changes whenever possible.
- Commit only files related to the current change.
- Exclude temporary or unrelated files.

---

## Commit Message

- Follow the project's commit message convention.
- If no convention exists, use Conventional Commits.
- **Write the commit message in Korean.**

---

## Quality Checklist

Before committing, verify that:

- The commit represents a single logical change.
- The commit message accurately describes the change.
- No unrelated files are included.
- Do not combine multiple logical changes into a single commit.
