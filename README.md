# jenkins-mcp

An MCP (Model Context Protocol) server for Jenkins. Lets AI assistants (Claude, Cursor, Copilot, and others) interact with any Jenkins instance — list jobs, trigger builds, check status, and fetch console logs.

## Tools

| Tool | Description |
|---|---|
| `list_jobs` | List jobs in any folder. Pass `folder: "MyOrg/MyTeam"` or leave empty for top-level. |
| `get_job_info` | Metadata, health score, last build result, and parameters for a job. |
| `trigger_build` | Trigger a parameterised or plain build. Returns the queue item URL. |
| `get_build_status` | Status, duration, and cause for a build number or alias (`lastBuild`, etc.). |
| `get_build_log` | Console log for any build. `tail_lines` (default 150) limits output; `0` = full log. |

## Requirements

- Node.js ≥ 18
- Network access to your Jenkins instance (VPN if required)
- A Jenkins API token: **Jenkins UI → your username → Configure → Add new Token**

## Installation & usage

### npx (no install needed)

Add to your MCP host config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "npx",
      "args": ["-y", "@ravian0772/jenkins-mcp"],
      "env": {
        "JENKINS_URL": "https://your-jenkins.example.com",
        "JENKINS_USER": "you@example.com",
        "JENKINS_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Global install

```bash
npm install -g @ravian0772/jenkins-mcp
```

Then in your MCP config:

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "jenkins-mcp",
      "env": {
        "JENKINS_URL": "https://your-jenkins.example.com",
        "JENKINS_USER": "you@example.com",
        "JENKINS_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `JENKINS_URL` | ✅ | Base URL of your Jenkins instance, e.g. `https://jenkins.example.com` |
| `JENKINS_USER` | ✅ | Your Jenkins username or email |
| `JENKINS_TOKEN` | ✅ | Jenkins API token (not your password) |

## Example prompts

```
List all jobs in the my-org/my-team folder
Trigger a build of my-org/my-app/main with ENV=staging and SKIP_TESTS=false
What is the status of the last build of my-org/my-app/daily?
Show me the last 200 lines of the console log for my-org/my-app/PR-42 build 5
Get the parameters for the my-org/deploy job
```

## License

MIT
