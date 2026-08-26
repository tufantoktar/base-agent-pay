const TASK_TYPES = new Set([
  "summarize",
  "rewrite",
  "classify",
  "structured-answer",
]);

export class AiProvider {
  async run() {
    throw new Error("AiProvider.run must be implemented");
  }
}

export class MockAiProvider extends AiProvider {
  async run({ taskType, input }) {
    const normalizedInput = normalizeInput(input);
    const normalizedTaskType = normalizeTaskType(taskType);

    return {
      provider: "mock",
      mode: "deterministic",
      taskType: normalizedTaskType,
      output: createMockOutput(normalizedTaskType, normalizedInput),
      metadata: {
        inputCharacters: normalizedInput.length,
        inputWords: wordCount(normalizedInput),
      },
    };
  }
}

export function normalizeTaskType(taskType) {
  if (!TASK_TYPES.has(taskType)) {
    throw new Error(`Unsupported task type: ${taskType}`);
  }
  return taskType;
}

export function normalizeInput(input) {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function createMockOutput(taskType, input) {
  if (!input) {
    return "No input provided.";
  }

  switch (taskType) {
    case "summarize":
      return summarize(input);
    case "rewrite":
      return rewrite(input);
    case "classify":
      return classify(input);
    case "structured-answer":
      return structuredAnswer(input);
    default:
      throw new Error(`Unsupported task type: ${taskType}`);
  }
}

function summarize(input) {
  const words = input.split(" ");
  const summary = words.slice(0, 24).join(" ");
  return words.length > 24
    ? `${summary}. Summary focus: ${keywords(input).join(", ")}.`
    : `${summary}.`;
}

function rewrite(input) {
  const sentence = input.replace(/[.!?]+$/u, "");
  return `Clear rewrite: ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function classify(input) {
  const lower = input.toLowerCase();
  const labels = [];

  if (/\b(pay|price|invoice|wallet|usdc|transaction|budget)\b/u.test(lower)) {
    labels.push("payments");
  }
  if (/\b(api|contract|agent|model|code|task|data)\b/u.test(lower)) {
    labels.push("technical");
  }
  if (/\b(urgent|asap|now|immediately|today)\b/u.test(lower)) {
    labels.push("time-sensitive");
  }
  if (/\b(risk|bug|fail|error|unsafe|problem)\b/u.test(lower)) {
    labels.push("risk");
  }

  return labels.length > 0
    ? `Classification: ${labels.join(", ")}.`
    : "Classification: general.";
}

function structuredAnswer(input) {
  const terms = keywords(input);
  return JSON.stringify(
    {
      answer: summarize(input),
      keywords: terms,
      confidence: "mock-medium",
      nextAction: terms.length > 0 ? `Review ${terms[0]}` : "Review input",
    },
    null,
    2,
  );
}

function keywords(input) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "but",
    "for",
    "from",
    "have",
    "into",
    "that",
    "the",
    "this",
    "with",
    "you",
  ]);

  const counts = new Map();
  for (const word of input.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    if (word.length < 4 || stopWords.has(word)) {
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([word]) => word);
}

function wordCount(input) {
  return input.length === 0 ? 0 : input.split(" ").length;
}

