function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  // The rest of `schemas/review-output.schema.json`: a review that passes here
  // is one the renderer can show without inventing anything.
  if (!["approve", "needs-attention"].includes(data.verdict.trim())) {
    return "`verdict` must be `approve` or `needs-attention`.";
  }
  for (const [index, finding] of data.findings.entries()) {
    const where = `findings[${index}]`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return `\`${where}\` must be an object.`;
    }
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
      return `\`${where}.severity\` must be critical, high, medium or low.`;
    }
    for (const key of ["title", "body", "file"]) {
      if (typeof finding[key] !== "string" || !finding[key].trim()) {
        return `\`${where}.${key}\` must be a non-empty string.`;
      }
    }
    if (typeof finding.recommendation !== "string") {
      return `\`${where}.recommendation\` must be a string.`;
    }
    for (const key of ["line_start", "line_end"]) {
      if (!Number.isInteger(finding[key]) || finding[key] < 1) {
        return `\`${where}.${key}\` must be a positive integer.`;
      }
    }
    if (finding.line_end < finding.line_start) {
      return `\`${where}.line_end\` is before \`line_start\`.`;
    }
    if (typeof finding.confidence !== "number" || !(finding.confidence >= 0 && finding.confidence <= 1)) {
      return `\`${where}.confidence\` must be a number from 0 to 1.`;
    }
  }
  for (const [index, step] of data.next_steps.entries()) {
    if (typeof step !== "string" || !step.trim()) {
      return `\`next_steps[${index}]\` must be a non-empty string.`;
    }
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * agy conversations live in the plugin's own agy home, not the user's, so the
 * way back into one is the plugin's resume flag rather than a raw agy command.
 */
function formatResumeHint(job) {
  if (!job?.threadId || job.jobClass !== "task") {
    return null;
  }
  return "/agy-cc:delegate --resume (continues the latest delegate conversation in this repository)";
}

function appendFailureLines(lines, failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return;
  }
  lines.push("", "agy run problems:");
  for (const failure of failures) {
    lines.push(`- ${failure}`);
  }
}

function appendNoteLines(lines, notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return;
  }
  lines.push("", "Notes:");
  for (const note of notes) {
    lines.push(`- ${note}`);
  }
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active runs:");
  lines.push("| Run | Kind | Status | Phase | Elapsed | agy Conversation ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/agy-cc:runs ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/agy-cc:stop ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  agy conversation ID: ${job.threadId}`);
  }
  const resumeHint = formatResumeHint(job);
  if (resumeHint) {
    lines.push(`  Continue: ${resumeHint}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Stop: /agy-cc:stop ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Show: /agy-cc:show ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /agy-cc:review --wait");
    lines.push("  Stricter pass: /agy-cc:critique --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# agy Check",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- agy: ${report.agy.detail}`,
    `- auth: ${report.auth.detail}`,
    `- plugin agy home: ${report.agyHome}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    ""
  ];

  if (report.userToolPermission) {
    lines.push(
      `Your own agy setting toolPermission=${report.userToolPermission} is not used: every bridge run starts agy in the plugin home above with its own permission profile.`,
      ""
    );
  }

  if (report.actionsTaken?.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps?.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# agy ${meta.reviewLabel}`,
      "",
      "agy did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendFailureLines(lines, meta.failures);
    appendNoteLines(lines, meta.notes);
    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# agy ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "agy returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendFailureLines(lines, meta.failures);
    appendNoteLines(lines, meta.notes);
    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# agy ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendFailureLines(lines, meta.failures);
  appendNoteLines(lines, meta.notes);
  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const lines = [
    `# agy ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (failures.length === 0 && result.status === 0) {
    lines.push("agy review completed without any output.");
  } else {
    lines.push("agy review failed.");
  }

  appendFailureLines(lines, failures);
  appendNoteLines(lines, result.notes);

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput.trimEnd() : "";
  const failures = Array.isArray(parsedResult?.failures) ? parsedResult.failures : [];
  const notes = Array.isArray(parsedResult?.notes) ? parsedResult.notes : [];
  if (rawOutput && failures.length === 0 && notes.length === 0) {
    return `${rawOutput}\n`;
  }
  if (rawOutput) {
    const lines = [rawOutput];
    appendFailureLines(lines, failures);
    appendNoteLines(lines, notes);
    return `${lines.join("\n")}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "agy did not return a final message.";
  return `${message}\n`;
}

/** Where the image went, or why there is none. */
export function renderImageResult(result) {
  const lines = ["# agy Image", ""];
  if (result.output) {
    lines.push(`Saved: ${result.output.path}`);
    lines.push(`- ${result.output.bytes} bytes, ${String(result.output.type).toUpperCase()}`);
    lines.push(`- Copied from: ${result.output.source}`);
    if (result.otherImages?.length) {
      lines.push(`- agy also drew ${result.otherImages.length} more image(s) in the same conversation:`);
      for (const other of result.otherImages) {
        lines.push(`  - ${other}`);
      }
    }
  } else {
    lines.push("No image was produced.");
    appendFailureLines(lines, result.failures);
  }
  if (result.output && result.warnings?.length) {
    lines.push("", "agy also reported:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  const response = String(result.response ?? "").trim();
  if (response) {
    lines.push("", "agy said:", "", response);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# agy Runs",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent runs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No runs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# agy Run Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const jobClass = storedJob?.jobClass ?? job.jobClass ?? null;
  const footer = (output) => {
    if (!threadId) {
      return output;
    }
    const resume =
      jobClass === "task"
        ? "\nContinue: /agy-cc:delegate --resume (continues the latest delegate conversation in this repository)"
        : "";
    return `${output}\nagy conversation ID: ${threadId}${resume}\n`;
  };

  // The rendered output already carries any failure notes, so it wins over
  // the bare answer text.
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return footer(output);
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.agy?.stdout === "string" && storedJob.result.agy.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    return footer(output);
  }

  const lines = [
    `# ${job.title ?? "agy Result"}`,
    "",
    `Run: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`agy conversation ID: ${threadId}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const delivered = job.cancelKill?.delivered ?? job.killDelivered;
  const lines = [
    "# agy Stop",
    "",
    delivered === false
      ? `Stop requested for ${job.id}, but process kill was not confirmed.`
      : `Stopped ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  if (delivered === false) {
    lines.push("- Kill delivered: false (process may still be running).");
  }
  lines.push("- Check `/agy-cc:runs` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
