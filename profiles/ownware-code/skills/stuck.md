---
name: stuck
description: When you've burned multiple turns making no progress, stop retrying and run a structured diagnosis instead.
trigger: /stuck
allowedTools:
  - readFile
  - glob
  - grep
  - shell_execute
  - ask_user
---

# Stuck — diagnose, don't keep guessing

You are stuck. The last few turns produced no progress, or the same fix keeps not fixing the thing. Retrying the same shape of action is the failure mode. Stop.

## Step 1 — State the symptom precisely

In one or two sentences: what is actually happening, and how do you know? Cite the exact error, the exact failing test name, or the exact wrong output. "It's broken" is not a symptom; "test `auth.session > restores from cookie` returns `null` instead of the user object" is.

If you cannot get to that level of precision, **that's the bug** — your reproduction isn't tight enough. Fix that first. Tighten the repro until you can name the exact failure, then continue.

## Step 2 — List your load-bearing assumptions

Write down 3–5 things you've been assuming are true about this code. Examples:

- "The cookie is set before the test runs."
- "This function is called from a single place."
- "The env var is loaded by the time auth runs."
- "The schema migration ran on the test DB."

Star the one you have the **least** evidence for. That's the next target.

## Step 3 — Test that assumption directly

Don't read more code to confirm it. Run something:

- Add a one-line log at the suspected boundary, run the failing case, observe the actual value.
- Run the function in isolation with the same input and observe.
- `grep` for every caller of the symbol you assumed had one caller.
- For a CLI / API change: invoke it directly and read what it actually does, not what you think it does.

The point is to **disprove** the assumption. If it survives an actual test, cross it off and move on to the next starred one.

## Step 4 — If still stuck after testing 2–3 assumptions, ask

Use `ask_user` with a real question. Not "should I try X or Y?" — that pushes the work back. Instead:

- What you've ruled out (the assumptions you tested and the result).
- Where you're blocked (precise — function, file, error).
- Two paths from here, each with its trade-off, and your recommendation if you have one.

If the user has context the code can't tell you (intent, history, business constraint, deferred decision), this is where it gets unblocked.

## Step 5 — Log what you learned

When you escape stuck, write down what assumption was wrong and why your mental model missed it — one or two lines in your end-of-turn summary. The pattern that put you in stuck will try again later; naming it is how you stop hitting it.

## What this skill is not

- Not an excuse to give up. Five minutes of structured diagnosis beats fifty minutes of retries; the goal is faster forward progress, not abandoning the problem.
- Not a license to ask the user before doing real work. If you haven't disproved at least one assumption, you haven't earned the question yet.
- Not a substitute for reading the error. Read the error. Read the stack trace. Read the test name. The signal is usually in the first line, not the eighteenth.
