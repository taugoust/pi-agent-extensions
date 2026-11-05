// Bounded contract for NativeTaskStore, not the worker cancellation protocol.
// Child numbers stand for fresh launch identities; the owner process stays alive.
module native_task {
  type Entry = { attempt: int, child: int, outcome: str }
  type Snapshot = {
    attempt: int, child: int, nextChild: int, running: bool,
    history: List[Entry], summaryAttempt: int, summary: int, checkpointed: bool
  }
  type Command = {
    kind: str, child: int, other: int, attempt: int,
    outcome: str, summary: int, method: str, result: str
  }
  var state: Snapshot
  var command: Command

  pure def cmd(kind: str, child: int, other: int, attempt: int,
    outcome: str, summary: int, method: str, result: str): Command =
    { kind: kind, child: child, other: other, attempt: attempt,
      outcome: outcome, summary: summary, method: method, result: result }

  action init = all {
    state' = { attempt: 1, child: 1, nextChild: 2, running: true,
      history: List(), summaryAttempt: 0, summary: 0, checkpointed: false },
    command' = cmd("init", 1, 0, 1, "", 0, "", "ok")
  }

  pure def finished(s: Snapshot, child: int, outcome: str, summary: int): Snapshot = {
    val history = if (s.history.length() == 32) s.history.tail() else s.history
    if (child != s.child) s else s.with("running", false)
      .with("history", history.append({ attempt: s.attempt, child: child, outcome: outcome }))
      .with("summaryAttempt", s.attempt).with("summary", summary)
      .with("checkpointed", outcome == "checkpointed")
  }

  action finish = {
    nondet child = 1.to(state.nextChild - 1).oneOf()
    nondet outcome = Set("partial", "delivered", "checkpointed").oneOf()
    nondet summary = 1.to(2).oneOf()
    all {
      state' = finished(state, child, outcome, summary),
      command' = cmd("finish", child, 0, state.attempt, outcome, summary, "", "ok")
    }
  }

  // A separate generated trace reaches the retention boundary reliably.
  action historyStep = all {
    state' = finished(state, state.child, "partial", 1),
    command' = cmd("finish", state.child, 0, state.attempt, "partial", 1, "", "ok")
  }

  action resume = all {
    state.attempt < 3,
    state' = if (state.running) state else state.with("attempt", state.attempt + 1)
      .with("child", state.nextChild).with("nextChild", state.nextChild + 1).with("running", true),
    command' = cmd("resume", state.nextChild, 0, state.attempt, "", 0, "",
      if (state.running) "rejected" else "ok")
  }

  // Choose arrival order, NOT an independently chosen scheduler winner.
  // In this single-process scope the first request takes the synchronous lock.
  action competingResume = {
    nondet lowArrivesFirst = Set(true, false).oneOf()
    val first = if (lowArrivesFirst) state.nextChild else state.nextChild + 1
    val second = if (lowArrivesFirst) state.nextChild + 1 else state.nextChild
    all {
      not(state.running), state.attempt < 3,
      state' = state.with("attempt", state.attempt + 1).with("child", first)
        .with("nextChild", state.nextChild + 2).with("running", true),
      command' = cmd("competingResume", first, second, state.attempt, "", 0, "", "ok")
    }
  }

  action verifyStopped = {
    nondet child = 1.to(state.nextChild - 1).oneOf()
    nondet attempt = 1.to(state.attempt).oneOf()
    all {
      state' = state,
      command' = cmd("verifyStopped", child, 0, attempt, "", 0, "",
        if (child == state.child and attempt == state.attempt and not(state.running)) "ok" else "rejected")
    }
  }

  action foreign = {
    nondet method = Set("get", "list", "finish", "resume", "verifyStopped").oneOf()
    all {
      state' = state,
      command' = cmd("foreign", state.child, 0, state.attempt, "", 0, method, "denied")
    }
  }

  action reconstruct = all {
    state' = state,
    command' = cmd("reconstruct", 0, 0, 0, "", 0, "", "ok")
  }

  action step = any { finish, resume, competingResume, verifyStopped, foreign, reconstruct }

  val bounded = state.attempt >= 1 and state.attempt <= 3 and state.history.length() <= 32
    and state.summaryAttempt <= state.attempt
    and state.history.foldl(true, (valid, entry) => valid and entry.attempt <= state.attempt)
}
