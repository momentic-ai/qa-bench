# Devin QA isolation

`--agent devin-qa` uses Devin's default model and effort for browser-only
full-app testing. The VM network policy restricts access to the fixture, and
the task prompt forbids outside research and prior-session lookup. Built-in
retrieval tools can bypass the VM policy, so those restrictions depend on
Devin following the prompt. Runs record `retrieval: "prompt-restricted"` in
their settings. This adapter runs one fixture at a time by default and does
not create child sessions.

## Setup

Use a dedicated org without connected repositories or knowledge notes. Set
`DEVIN_ORGANIZATION_ID` and `DEVIN_TOKEN` in the eval environment.
The token needs session and security-profile management permissions.

From the repository root, check authentication and VM policy prerequisites:

```bash
pnpm devin-preflight
```

This creates or verifies an unbound mandatory deny-all profile, starts no
session, and checks credentials and the clean-org requirements. It does not
change organization defaults.

The adapter prepares a mandatory profile allowing only the fixture's exact
E2B hostname, denies external MCP servers, removes GitHub CLI credentials,
and makes built-in Devin management tools read-only. It rejects Outposts.
Sessions are disposable, findings
use structured output, and USD cost stays unavailable rather than assuming an
ACU conversion. Profiles remain for audit and reuse.

## Observed bypass

The [isolation probe](https://app.devin.ai/sessions/49cdc66639d64d38a038781adc4d1298)
used a mandatory profile allowing only `example.com`, an empty external MCP
allowlist, read-only Devin management tools and git, and no GitHub CLI token.
It ran no benchmark fixture and was terminated after collecting its output.

| Access path                                                                                        | Probe result                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Shell HTTPS to example.com                                                                         | HTTP 200                                    |
| Shell HTTPS to github.com, api.github.com, raw.githubusercontent.com, codeberg.org, www.google.com | Blocked by DNS policy                       |
| Built-in `web_search`                                                                              | Retrieved live public GitHub issue content  |
| Built-in `devin_ask_wiki_question`                                                                 | Retrieved indexed public repository content |

[Security profiles](https://docs.devin.ai/product-guides/security-profiles)
document VM network restrictions and external MCP allowlists. Those controls
did not block the two built-in retrieval tools in this probe. Read-only Devin
management tools also retain access to prior sessions and knowledge.

The task prompt explicitly prohibits built-in web search, DeepWiki,
prior-session and knowledge lookup, external repositories, issues, fixes,
benchmark answers and previous reports. Findings must come from browser
exploration and reproduction in the running fixture. Blocked flows belong in
coverage limitations. These instructions do not enforce isolation of the
server-side tools. Stronger isolation requires controls from Cognition and
another probe of every retrieval path.
