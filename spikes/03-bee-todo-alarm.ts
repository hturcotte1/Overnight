// Spike 3: does a Bee to-do with an alarm buzz the watch, and do we hear about it when it is
// ticked (approved) or deleted (rejected) in the Bee app?
//
// Usage: node spikes/03-bee-todo-alarm.ts [alarmMinutes=2] [listenMinutes=10] [text]
// Creates ONE clearly labelled test to-do in the logged-in Bee account, then watches it two ways:
// the live stream, and polling `bee todos get` every 5 seconds.
// Raw output is saved to ~/.overnight/spikes/03-todo-alarm.jsonl (never committed).
import { bee, beeJson, firstLine, listenByType, requireLogin, saveRaw, shape, stamp } from "./lib/util.ts";

const alarmMinutes = Number(process.argv[2] ?? 2);
const listenMinutes = Number(process.argv[3] ?? 10);
if (!Number.isFinite(alarmMinutes) || alarmMinutes <= 0 || !Number.isFinite(listenMinutes) || listenMinutes <= 0) {
  console.error("Usage: node spikes/03-bee-todo-alarm.ts [alarmMinutes=2] [listenMinutes=10] [text]  (both numbers must be above 0)");
  process.exit(2);
}
const client = bee();
await requireLogin(client);

let todoId: string | undefined;
const pending: Array<{ type: string; data: Record<string, unknown> }> = [];
let stopTimer: NodeJS.Timeout | undefined;

function stopSoon(reason: string, seconds: number): void {
  if (stopTimer) return;
  console.log(`${stamp()} ${reason} Listening ${seconds} more seconds for follow-up events.`);
  stopTimer = setTimeout(() => listener.close(), seconds * 1000);
}

function handle(type: string, data: Record<string, unknown>): void {
  const todo = data.todo as Record<string, unknown> | undefined;
  if (!todo) return; // the connect message, or something that is not a to-do event
  const id = String(todo.id ?? "?");
  const mine = todoId !== undefined && id === todoId;
  console.log(JSON.stringify({ at: stamp(), type, todoId: id, mine, completed: todo.completed, shape: shape(data) }));
  if (mine && (type === "todo-deleted" || todo.completed === true)) stopSoon(`the stream delivered the answer (${type}).`, 20);
}

// Listen before creating, so a todo-created event is not missed.
const listener = listenByType(client, ["todo-created", "todo-updated", "todo-deleted"], ({ type, data }) => {
  saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "event", type, data });
  if (todoId === undefined) pending.push({ type, data });
  else handle(type, data);
});
const timer = setTimeout(() => listener.close(), listenMinutes * 60_000);
// Give the three streams a moment to connect.
await new Promise((resolve) => setTimeout(resolve, 3_000));

// Always UTC with a Z: other time zone forms are undocumented.
const alarmAt = new Date(Date.now() + alarmMinutes * 60_000).toISOString();
const text = process.argv[4] ?? "💡 Overnight test: tick me when this buzzes";
try {
  const created = await beeJson<Record<string, unknown>>(client, ["todos", "create", "--text", text, "--alarm-at", alarmAt]);
  saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "created", created });
  const createdTodo = (created?.todo ?? created) as Record<string, unknown> | undefined;
  if (createdTodo?.id === undefined || createdTodo.id === null) throw new Error("Bee created the to-do but returned no id, so it cannot be watched");
  todoId = String(createdTodo.id);
  console.log(JSON.stringify({ at: stamp(), label: "todos.create", todoId, alarmAt, shape: shape(created) }, null, 2));
} catch (error) {
  listener.close();
  clearTimeout(timer);
  console.error(`${stamp()} could not create the test to-do: ${firstLine(error)}`);
  process.exit(1);
}
console.log(`${stamp()} alarm set for ${alarmMinutes} min from now. Watch the wrist, then tick or delete the to-do in the Bee app.`);
for (const { type, data } of pending.splice(0)) handle(type, data);

// Poll the to-do as well. In our first run the tick showed up in `bee todos get` but no
// todo-updated event ever arrived on the stream, so polling may be the only reliable signal.
// One poll at a time: the next is scheduled only after the previous one has returned.
let lastSeen = "";
let stopped = false;
let pollTimer: NodeJS.Timeout | undefined;
async function pollOnce(): Promise<void> {
  let state: string;
  try {
    const current = await beeJson<Record<string, unknown>>(client, ["todos", "get", todoId as string], 20_000);
    const todo = (current?.todo ?? current) as Record<string, unknown>;
    state = `completed=${String(todo?.completed)}`;
  } catch (error) {
    state = `error: ${firstLine(error)}`;
  }
  if (stopped) return;
  if (state !== lastSeen) {
    lastSeen = state;
    saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "poll", state });
    console.log(JSON.stringify({ at: stamp(), label: "poll todos.get", todoId, state }));
    // Only two things count as an answer: ticked, or gone. Any other error means "try again".
    if (state === "completed=true") stopSoon("the poll saw the to-do ticked.", 30);
    else if (/^error: .*not found/i.test(state)) stopSoon("the poll saw the to-do deleted.", 30);
    else if (state !== "completed=false") console.log(`${stamp()} that poll did not give an answer. Still watching.`);
  }
  pollTimer = setTimeout(pollOnce, 5_000);
}
pollTimer = setTimeout(pollOnce, 5_000);

const failedStreams = await listener.done;
stopped = true;
clearTimeout(pollTimer);
clearTimeout(timer);
clearTimeout(stopTimer);
if (failedStreams > 0) process.exitCode = 1;

// Whatever the stream said, ask Bee directly for the final state of the test to-do.
try {
  const final = await beeJson<Record<string, unknown>>(client, ["todos", "get", todoId as string], 20_000);
  saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "final", final });
  const finalTodo = (final?.todo ?? final) as Record<string, unknown>;
  console.log(JSON.stringify({ at: stamp(), label: "todos.get (final)", completed: finalTodo?.completed, shape: shape(final) }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ at: stamp(), label: "todos.get (final)", error: firstLine(error) }));
}
