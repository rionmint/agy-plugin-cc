import test from "node:test";
import assert from "node:assert/strict";

import {
  renderImageResult,
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/agy-cc/scripts/lib/render.mjs";

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
