#!/usr/bin/env node
/**
 * Jenkins MCP Server
 *
 * Authentication: Jenkins API Token
 *   - JENKINS_URL      e.g. https://jenkins.example.com
 *   - JENKINS_USER     your Jenkins username or email  e.g. user@example.com
 *   - JENKINS_TOKEN    API token from Jenkins → User Profile → Configure → Add new Token
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config — read from env, fail fast if missing
// ---------------------------------------------------------------------------
const JENKINS_URL = (process.env.JENKINS_URL ?? "").replace(/\/$/, "");
const JENKINS_USER = process.env.JENKINS_USER ?? "";
const JENKINS_TOKEN = process.env.JENKINS_TOKEN ?? "";

if (!JENKINS_URL || !JENKINS_USER || !JENKINS_TOKEN) {
  console.error(
    "ERROR: JENKINS_URL, JENKINS_USER, and JENKINS_TOKEN must all be set."
  );
  process.exit(1);
}

const AUTH = Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString("base64");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function jenkinsGet(path: string): Promise<unknown> {
  const url = `${JENKINS_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${AUTH}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Jenkins GET ${path} → HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text; // some endpoints return plain text (e.g. log output)
  }
}

async function jenkinsPost(
  path: string,
  params?: Record<string, string>
): Promise<{ status: number; body: string }> {
  let url = `${JENKINS_URL}${path}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${AUTH}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  return { status: res.status, body: await res.text() };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "jenkins-mcp", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Tool 1 — list_jobs
// ---------------------------------------------------------------------------
server.registerTool(
  "list_jobs",
  {
    description:
      "List all top-level Jenkins jobs (name, URL, colour/status). " +
      "Pass a folder path to list jobs inside a folder, e.g. 'MyFolder'.",
    inputSchema: z.object({
      folder: z
        .string()
        .optional()
        .describe(
          "Optional folder path (e.g. 'MyFolder' or 'Org/Team'). Leave empty for top-level jobs."
        ),
    }),
  },
  async ({ folder }) => {
    try {
      const base = folder
        ? `/job/${folder.split("/").join("/job/")}`
        : "";
      const data = (await jenkinsGet(
        `${base}/api/json?tree=jobs[name,url,color,lastBuild[number,result]]`
      )) as { jobs?: Array<{ name: string; url: string; color: string; lastBuild?: { number: number; result: string } }> };

      if (!data.jobs || data.jobs.length === 0) {
        return textResult("No jobs found.");
      }

      const lines = data.jobs.map((j) => {
        const last = j.lastBuild
          ? ` | last build #${j.lastBuild.number}: ${j.lastBuild.result ?? "IN_PROGRESS"}`
          : "";
        return `• ${j.name} [${j.color}]${last}\n  ${j.url}`;
      });
      return textResult(lines.join("\n\n"));
    } catch (err) {
      return errorResult(`list_jobs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2 — trigger_build
// ---------------------------------------------------------------------------
server.registerTool(
  "trigger_build",
  {
    description:
      "Trigger a Jenkins build for a job. Supports parameterised and non-parameterised jobs. " +
      "Returns the queue item URL so you can poll for the build number.",
    inputSchema: z.object({
      job_path: z
        .string()
        .describe(
          "Full job path relative to Jenkins root, e.g. 'MyFolder/MyJob' or 'MyJob'."
        ),
      parameters: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Optional key/value build parameters, e.g. {\"BRANCH\": \"main\", \"ENV\": \"staging\"}."
        ),
    }),
  },
  async ({ job_path, parameters }) => {
    try {
      const encoded = job_path.split("/").join("/job/");
      const hasParams = parameters && Object.keys(parameters).length > 0;
      const path = `/job/${encoded}/${hasParams ? "buildWithParameters" : "build"}`;
      const { status } = await jenkinsPost(path, hasParams ? (parameters as Record<string, string>) : undefined);

      // 201 = queued successfully, 303 = redirect (also success for older Jenkins)
      if (status === 201 || status === 200 || status === 303) {
        return textResult(
          `✅ Build triggered for '${job_path}'.\n` +
          `Check status with get_build_status or get_build_log.`
        );
      }
      return errorResult(
        `trigger_build got unexpected HTTP ${status} for job '${job_path}'.`
      );
    } catch (err) {
      return errorResult(`trigger_build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3 — get_build_status
// ---------------------------------------------------------------------------
server.registerTool(
  "get_build_status",
  {
    description:
      "Get the status of a specific build number (or 'lastBuild' / 'lastSuccessfulBuild' / 'lastFailedBuild').",
    inputSchema: z.object({
      job_path: z
        .string()
        .describe("Full job path, e.g. 'MyFolder/MyJob' or 'MyJob'."),
      build_number: z
        .union([z.number().int().positive(), z.enum(["lastBuild", "lastSuccessfulBuild", "lastFailedBuild", "lastStableBuild"])])
        .describe("Build number (integer) or a Jenkins alias like 'lastBuild'.")
        .optional(),
    }),
  },
  async ({ job_path, build_number }) => {
     const bn = build_number ?? "lastBuild";
    try {
      const encoded = job_path.split("/").join("/job/");
      const data = (await jenkinsGet(
        `/job/${encoded}/${bn}/api/json?tree=number,result,building,timestamp,duration,url,description,causes[shortDescription]`
      )) as {
        number: number;
        result: string | null;
        building: boolean;
        timestamp: number;
        duration: number;
        url: string;
        description?: string;
        causes?: Array<{ shortDescription: string }>;
      };

      const started = new Date(data.timestamp).toISOString();
      const durationSec = Math.round(data.duration / 1000);
      const status = data.building ? "IN PROGRESS ⏳" : (data.result ?? "UNKNOWN");
      const cause = data.causes?.map((c) => c.shortDescription).join(", ") ?? "unknown";

      return textResult(
        [
          `Job:      ${job_path}`,
          `Build:    #${data.number}`,
          `Status:   ${status}`,
          `Started:  ${started}`,
          `Duration: ${durationSec}s`,
          `Cause:    ${cause}`,
          data.description ? `Desc:     ${data.description}` : null,
          `URL:      ${data.url}`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (err) {
      return errorResult(`get_build_status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 4 — get_build_log
// ---------------------------------------------------------------------------
server.registerTool(
  "get_build_log",
  {
    description:
      "Fetch the console log for a Jenkins build. Defaults to the last 150 lines to avoid huge output. " +
      "Set tail_lines to 0 to get the full log.",
    inputSchema: z.object({
      job_path: z
        .string()
        .describe("Full job path, e.g. 'MyFolder/MyJob' or 'MyJob'."),
      build_number: z
        .union([z.number().int().positive(), z.enum(["lastBuild", "lastSuccessfulBuild", "lastFailedBuild"])])
        .default("lastBuild")
        .describe("Build number or Jenkins alias."),
      tail_lines: z
        .number()
        .int()
        .min(0)
        .default(150)
        .describe("Number of trailing lines to return. 0 = full log."),
    }),
  },
  async ({ job_path, build_number, tail_lines }) => {
    try {
      const encoded = job_path.split("/").join("/job/");
      const log = (await jenkinsGet(
        `/job/${encoded}/${build_number}/consoleText`
      )) as string;

      if (!log || log.trim().length === 0) {
        return textResult("(log is empty)");
      }

      if (tail_lines === 0) {
        return textResult(log);
      }

      const lines = log.split("\n");
      const tail = lines.slice(-tail_lines).join("\n");
      const omitted = lines.length - tail_lines;
      const header =
        omitted > 0
          ? `[... ${omitted} lines omitted — set tail_lines=0 for full log ...]\n\n`
          : "";
      return textResult(header + tail);
    } catch (err) {
      return errorResult(`get_build_log failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 5 — get_job_info
// ---------------------------------------------------------------------------
server.registerTool(
  "get_job_info",
  {
    description:
      "Get metadata about a Jenkins job: description, build health, last few builds, parameters.",
    inputSchema: z.object({
      job_path: z
        .string()
        .describe("Full job path, e.g. 'MyFolder/MyJob' or 'MyJob'."),
    }),
  },
  async ({ job_path }) => {
    try {
      const encoded = job_path.split("/").join("/job/");
      const data = (await jenkinsGet(
        `/job/${encoded}/api/json?tree=name,description,healthReport[description,score],lastBuild[number,result,timestamp],lastSuccessfulBuild[number,timestamp],lastFailedBuild[number,timestamp],property[parameterDefinitions[name,type,defaultParameterValue[value],description]],builds[number,result]{0,5}`
      )) as {
        name: string;
        description?: string;
        healthReport?: Array<{ description: string; score: number }>;
        lastBuild?: { number: number; result: string; timestamp: number };
        lastSuccessfulBuild?: { number: number; timestamp: number };
        lastFailedBuild?: { number: number; timestamp: number };
        property?: Array<{ parameterDefinitions?: Array<{ name: string; type: string; defaultParameterValue?: { value: string }; description?: string }> }>;
        builds?: Array<{ number: number; result: string }>;
      };

      const parts: string[] = [];
      parts.push(`Job: ${data.name}`);
      if (data.description) parts.push(`Description: ${data.description}`);

      if (data.healthReport?.length) {
        parts.push(`Health: ${data.healthReport[0].score}% — ${data.healthReport[0].description}`);
      }

      if (data.lastBuild) {
        parts.push(`Last build:            #${data.lastBuild.number} ${data.lastBuild.result ?? "IN_PROGRESS"} (${new Date(data.lastBuild.timestamp).toISOString()})`);
      }
      if (data.lastSuccessfulBuild) {
        parts.push(`Last successful build:  #${data.lastSuccessfulBuild.number} (${new Date(data.lastSuccessfulBuild.timestamp).toISOString()})`);
      }
      if (data.lastFailedBuild) {
        parts.push(`Last failed build:      #${data.lastFailedBuild.number} (${new Date(data.lastFailedBuild.timestamp).toISOString()})`);
      }

      const params = data.property
        ?.flatMap((p) => p.parameterDefinitions ?? []);
      if (params && params.length > 0) {
        parts.push("\nParameters:");
        params.forEach((p) => {
          const def = p.defaultParameterValue?.value ? ` (default: ${p.defaultParameterValue.value})` : "";
          parts.push(`  • ${p.name} [${p.type}]${def}${p.description ? " — " + p.description : ""}`);
        });
      }

      if (data.builds?.length) {
        parts.push("\nRecent builds:");
        data.builds.forEach((b) => parts.push(`  #${b.number}: ${b.result ?? "IN_PROGRESS"}`));
      }

      return textResult(parts.join("\n"));
    } catch (err) {
      return errorResult(`get_job_info failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("jenkins-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
