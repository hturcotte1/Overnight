// Spike 3: does a Bee to-do with an alarm buzz the watch, and do we hear about it when it is
// ticked (approved) or deleted (rejected) in the Bee app?
//
// Usage: node spikes/03-bee-todo-alarm.ts [alarmMinutes=2] [listenMinutes=10]
// Creates ONE clearly labelled test to-do in the logged-in Bee account, then listens.
// Raw output is saved to ~/.overnight/spikes/03-todo-alarm.jsonl (never committed).
import { bee, requireLogin, saveRaw, shape, stamp } from "./lib/util.ts";

const alarmMinutes = Number(process.argv[2] ?? 2);
const listenMinutes = Number(process.argv[3] ?? 10);
const client = bee();
await requireLogin(client);

// Listen before creating, so the todo-created event is not missed.
const stream = client.sse.streamJson<Record<string, unknown>>({
  types: ["todo-created", "todo-updated", "todo-deleted"],
});
let closedByUs = false;
const stop = () => {
  closedByUs = true;
  stream.close();
};
const timer = setTimeout(stop, listenMinutes * 60_000);

const alarmAt = new Date(Date.now() + alarmMinutes * 60_000).toISOString();
const created = await client.api.todos.create<Record<string, unknown>>({
  text: "💡 Overnight test: tick me when this buzzes",
  alarmAt,
});
saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "created", created });
const createdTodo = (created?.todo ?? created) as Record<string, unknown>;
const todoId = String(createdTodo?.id ?? "?");
console.log(JSON.stringify({ at: stamp(), label: "todos.create", todoId, alarmAt, shape: shape(created) }, null, 2));
console.log(`${stamp()} alarm set for ${alarmMinutes} min from now. Watch the wrist, then tick the to-do in the Bee app.`);

try {
  for await (const { data } of stream.events) {
    saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "event", data });
    const todo = (data.todo ?? data) as Record<string, unknown>;
    const id = String(todo?.id ?? data.id ?? "?");
    const mine = id === todoId;
    console.log(
      JSON.stringify({
        at: stamp(),
        keys: Object.keys(data).sort().join("+"),
        todoId: id,
        mine,
        completed: todo?.completed,
        shape: shape(data),
      }),
    );
    if (mine && (todo?.completed === true || !("todo" in data))) {
      console.log(`${stamp()} saw the answer for our test to-do. Listening 20 more seconds for any follow-up events.`);
      setTimeout(stop, 20_000);
    }
  }
} catch (error) {
  if (!closedByUs) {
    console.error(`${stamp()} stream ended with an error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
}

// Whatever the stream said, ask Bee directly for the final state of the test to-do.
try {
  const final = await client.api.todos.get<Record<string, unknown>>(todoId);
  saveRaw("03-todo-alarm.jsonl", { at: stamp(), label: "final", final });
  const finalTodo = (final?.todo ?? final) as Record<string, unknown>;
  console.log(JSON.stringify({ at: stamp(), label: "todos.get (final)", completed: finalTodo?.completed, shape: shape(final) }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ at: stamp(), label: "todos.get (final)", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }));
}
