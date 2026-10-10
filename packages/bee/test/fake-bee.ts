// Synthetic: a stand-in for the `bee` program, used only by real-library.test.ts. It never talks
// to Bee, and every word it prints is made up.
//
// The test starts it as `node fake-bee.ts <scenario> <the arguments Bee's library passes>`, so
// the real library's own spawning, JSON parsing, stream reading and killing are what get tested.
import { appendFileSync } from "node:fs";

const [scenario = "", ...args] = process.argv.slice(2);
const command = args.filter((arg) => arg !== "--json").join(" ");

const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);

// Like the real program: the error goes to standard error, the usage text to standard output,
// and the exit code is 1. (Set the code and let Node finish, so nothing printed is cut short.)
const fail = (message: string): void => {
  process.stdout.write("Usage: bee <command> [options]\n  made-up help text\n");
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const stayOpen = (): void => void setInterval(() => {}, 1000);

// A test that needs to know whether this process was really stopped names a file in this
// variable. Each stand-in that is meant to be stopped adds its process id to it.
const notePid = (): void => {
  const file = process.env.FAKE_BEE_PID_FILE;
  if (file) appendFileSync(file, `${process.pid}\n`);
};

const EXPECTED_TYPES = "new-utterance,new-conversation,update-conversation,delete-conversation,todo-deleted";
const UUID = "0f0e0d0c-1111-4222-8333-444455556666";
const ASK_TEXT = "💡 Build tonight? Chore wheel";

const utteranceLine = (id: number, text: string): unknown => ({
  type: "new-utterance",
  conversation_uuid: UUID,
  utterance: { id, sample_id: `s-${id}`, start: 0, end: 2, text, spoken_at: "2026-10-09T18:00:05Z" },
});

function streamOpening(): boolean {
  const types = args[args.indexOf("--types") + 1];
  if (!args.includes("--json") || !args.includes("--types") || types !== EXPECTED_TYPES) {
    fail("fake-bee: the stream was not asked for the way we expect");
    return false;
  }
  print({ timestamp: 1760032800000 });
  print(utteranceLine(1, "a made-up line from the fake program"));
  return true;
}

// One line of the stream, written in two pieces with a pause between them. The cut falls in the
// middle of the two bytes that make up "é", which is how a long line really arrives.
function printInTwoPieces(value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const cut = bytes.indexOf(0xc3) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 150);
}

if (!args.includes("--json")) {
  fail("fake-bee: expected --json");
} else if (scenario === "logged-out") {
  fail("Not logged in. Run 'bee login' first.");
} else if (scenario === "hang") {
  notePid();
  stayOpen();
} else if (scenario === "stream-ends") {
  streamOpening();
} else if (scenario === "stream-waits") {
  notePid();
  if (streamOpening()) stayOpen();
} else if (scenario === "stream-fails") {
  if (streamOpening()) fail("The made-up connection dropped.\nsecond line of detail");
} else if (scenario === "stream-split") {
  if (streamOpening()) printInTwoPieces(utteranceLine(2, "a made-up café line, cut in two"));
} else if (scenario === "not-json") {
  process.stdout.write("this is not JSON, and it mentions Peregrine\n");
} else if (scenario === "stdout-only") {
  // Not something the real program does: it fails without a word on standard error, so Bee's
  // library uses standard output as the error message.
  process.stdout.write("Name: Peregrine Quillfeather\nsecond made-up line\n");
  process.exitCode = 1;
} else if (scenario === "create-slow" && command.startsWith("todos create ")) {
  // The to-do "is created", but the reply comes after the test's time limit has passed.
  notePid();
  setTimeout(() => print({ id: 77, text: ASK_TEXT, completed: false, created_at: Date.now() }), 5000);
} else if (command === "me") {
  print({ id: 3, first_name: "Peregrine", last_name: "Quillfeather" });
} else if (command === "todos get 11") {
  print({ id: 11, text: "made-up to-do", alarm_at: 1760032920000, completed: true, created_at: 1760032800000, corrections: [], timezone: "America/Boise" });
} else if (command.startsWith("todos get ")) {
  fail("Todo not found.");
} else if (command === "todos list --limit 20") {
  // Newest first, completed ones included, as the real program lists them.
  const now = Date.now();
  print({
    todos: [
      { id: 78, text: "a made-up to-do of Bee's own", alarm_at: null, completed: false, created_at: now, corrections: [] },
      { id: 77, text: ASK_TEXT, alarm_at: now + 120_000, completed: false, created_at: now, corrections: [] },
      { id: 60, text: ASK_TEXT, alarm_at: null, completed: true, created_at: now - 86_400_000, corrections: [] },
    ],
    next_cursor: null,
    timezone: "America/Boise",
  });
} else if (command.startsWith("todos create ")) {
  // The text has spaces in it. It must arrive as one argument, with each flag as its own word.
  const [, , textFlag, text, alarmFlag, alarmAt] = args;
  if (textFlag === "--text" && text === ASK_TEXT && alarmFlag === "--alarm-at" && alarmAt === "2026-10-09T18:02:00.000Z") {
    print({ id: 12, text, alarm_at: Date.parse(alarmAt), completed: false, created_at: 1760032800000, corrections: [], timezone: "America/Boise" });
  } else {
    fail("fake-bee: todos create was not called the way we expect");
  }
} else if (command === "changed" || command.startsWith("changed --cursor ")) {
  print({ meta: { next_cursor: command === "changed" ? "first-cursor" : "later-cursor" }, conversations: [{ id: 9001 }], todos: [], facts: [] });
} else if (command.startsWith("conversations transcript 404 ")) {
  fail("Conversation not found");
} else if (command.startsWith("conversations transcript ")) {
  print({ conversationId: 9001, transcript: [{ id: 30, text: "a made-up stored line", spoken_at: 1760032805000, speaker: "Peregrine", realtime: false }], note: "" });
} else {
  fail("fake-bee: no made-up answer for this command");
}
