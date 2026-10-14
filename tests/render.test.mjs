import test from "node:test";
import assert from "node:assert/strict";

import {
  groupModelIds,
  renderImageResult,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/agy-cc/scripts/lib/render.mjs";

function checkReport(overrides = {}) {
  return {
    ready: true,
    node: { available: true, detail: "v24.13.1" },
    agy: { available: true, detail: "1.3.5", binary: "agy" },
    auth: { loggedIn: true, detail: "signed in; 3 models available", models: ["m-high", "m-low", "other-medium"] },
    agyHome: "C:\\data\\agy-cc\\agy-homes",
    userToolPermission: "always-proceed",
    actionsTaken: [],
    nextSteps: [],
    ...overrides
  };
}

test("the check is one fixed table with the same rows in the same order", () => {
  const output = renderSetupReport(checkReport());
  const labels = [...output.matchAll(/^\| ([^|]+) \|/gm)].map((match) => match[1].trim());
  assert.deepEqual(labels, ["Item", "Node", "agy", "Sign-in", "Models", "Your toolPermission", "Plugin agy home", "Runs"]);
  assert.match(output, /^## agy check: ready$/m);
  assert.match(output, /\| Models \| m low\/high · other medium \|/);
  assert.match(output, /never use your global agy settings/);
  assert.match(output, /Next steps: none\./);
});

test("a check that is not ready keeps its next steps and says what is missing", () => {
  const output = renderSetupReport(
    checkReport({
      ready: false,
      auth: { loggedIn: false, detail: "Please sign in", models: [] },
      nextSteps: ["Run `agy` once in a terminal and complete the Google sign-in it asks for."]
    })
  );
  assert.match(output, /^## agy check: needs attention$/m);
  assert.match(output, /\| Sign-in \| not signed in \(Please sign in\) \|/);
  assert.match(output, /\| Models \| none listed \|/);
  const labels = [...output.matchAll(/^\| ([^|]+) \|/gm)].map((match) => match[1].trim());
  assert.deepEqual(labels, ["Item", "Node", "agy", "Sign-in", "Models", "Your toolPermission", "Plugin agy home", "Runs"]);
  assert.match(output, /- Run `agy` once in a terminal/);
});

test("model ids are grouped by family with efforts in order", () => {
  assert.equal(
    groupModelIds(["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low", "gpt-oss-120b-medium", "plain"]),
    "gemini-4-argon low/medium/high · gpt-oss-120b medium · plain"
  );
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Critique",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /agy returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderReviewResult lists run problems next to the findings", () => {
  const output = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "ok", findings: [], next_steps: [] },
      rawOutput: "{}",
      parseError: null
    },
    { reviewLabel: "Critique", targetLabel: "working tree diff", failures: ["agy hit its --print-timeout (5s)"] }
  );
  assert.match(output, /agy run problems:\n- agy hit its --print-timeout \(5s\)/);
});

test("renderNativeReviewResult says the review failed when agy reported problems", () => {
  const output = renderNativeReviewResult(
    { status: 0, stdout: "", stderr: "", failures: ["agy returned an empty response."] },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /agy review failed\./);
  assert.match(output, /agy returned an empty response\./);
});

test("renderTaskResult keeps the answer and appends any problems", () => {
  assert.equal(renderTaskResult({ rawOutput: "done", failures: [] }), "done\n");
  const output = renderTaskResult({ rawOutput: "partial", failures: ["agy hit its --print-timeout (5s)"] });
  assert.match(output, /^partial\n\nagy run problems:/);
});

test("renderStoredJobResult prefers rendered output and shows the conversation id", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "agy Critique",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      jobClass: "review",
      rendered: "# agy Critique\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# agy Critique/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /agy conversation ID: thr_123/);
  assert.doesNotMatch(output, /Continue:/, "only delegate runs can be continued");
});

test("renderStoredJobResult offers to continue a delegate run", () => {
  const output = renderStoredJobResult(
    { id: "run-1", status: "completed", jobClass: "task", threadId: "thr_9" },
    { threadId: "thr_9", jobClass: "task", rendered: "Handled.\n" }
  );
  assert.match(output, /Continue: \/agy-cc:delegate --resume/);
});

test("renderImageResult reports the saved file or the reason there is none", () => {
  const saved = renderImageResult({
    output: { path: "/tmp/a.jpg", bytes: 10, type: "jpeg", source: "/home/brain/x/a.jpg" },
    otherImages: [],
    warnings: [],
    response: "Generated."
  });
  assert.match(saved, /Saved: \/tmp\/a\.jpg/);
  assert.match(saved, /JPEG/);

  const missing = renderImageResult({ failures: ["agy finished without producing an image."], response: "" });
  assert.match(missing, /No image was produced\./);
  assert.match(missing, /without producing an image/);
});

test("review validation follows the schema exactly", async () => {
  const { validateReviewResultShape } = await import("../plugins/agy-cc/scripts/lib/render.mjs");
  const finding = {
    severity: "high",
    title: "t",
    body: "b",
    file: "a.js",
    line_start: 1,
    line_end: 2,
    confidence: 0.5,
    recommendation: "r"
  };
  const good = { verdict: "approve", summary: "ok", findings: [finding], next_steps: ["x"] };
  assert.equal(validateReviewResultShape(good), null);
  assert.match(validateReviewResultShape({ ...good, extra: 1 }), /Unexpected top-level/);
  assert.match(validateReviewResultShape({ ...good, findings: [{ ...finding, extra: 1 }] }), /Unexpected field/);
  assert.match(validateReviewResultShape({ ...good, verdict: " approve " }), /verdict/);
  assert.match(validateReviewResultShape({ ...good, verdict: "banana" }), /verdict/);
  assert.match(validateReviewResultShape({ ...good, findings: [null] }), /must be an object/);
  assert.match(validateReviewResultShape({ ...good, findings: [{ ...finding, confidence: 2 }] }), /confidence/);
  assert.match(validateReviewResultShape({ ...good, findings: [{ ...finding, line_end: 0 }] }), /line_end/);
  assert.match(validateReviewResultShape({ ...good, next_steps: [42] }), /next_steps\[0\]/);
});

test("table cells survive missing fields, pipes and every kind of line break", () => {
  const output = renderSetupReport({ ready: false, node: null, auth: { loggedIn: false, detail: "a|b\rc\r\nd\ne" } });
  assert.doesNotMatch(output, /undefined/);
  assert.match(output, /not signed in \(a\\\|b c d e\)/);
  assert.match(output, /\| Node \| not found \(unknown\) \|/);
});
