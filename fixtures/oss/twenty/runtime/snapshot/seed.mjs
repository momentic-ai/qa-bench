const url = process.env.FIXTURE_URL;
let token;
async function graphql(query, endpoint = "/metadata") {
  const response = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: url,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(300_000),
  });
  const result = await response.json();
  if (result.errors?.length) {
    const error = new Error(JSON.stringify(result.errors));
    error.errors = result.errors;
    throw error;
  }
  if (!response.ok) throw new Error(`Twenty GraphQL: HTTP ${response.status}`);
  return result.data;
}
const credentials = `email: ${JSON.stringify(process.env.FIXTURE_USERNAME)}, password: ${JSON.stringify(process.env.FIXTURE_PASSWORD)}`;
let current = true;
let registration;
try {
  registration = (
    await graphql(`mutation {
    signUp(${credentials}) { tokens { accessOrWorkspaceAgnosticToken { token } } }
  }`)
  ).signUp;
} catch (error) {
  if (
    !error.errors?.every((item) =>
      item.message.includes('Cannot query field "tokens"'),
    )
  )
    throw error;
  current = false;
  registration = (
    await graphql(`mutation {
    signUp(${credentials}) { loginToken { token } }
  }`)
  ).signUp;
}
let loginToken;
if (current) {
  token = registration.tokens.accessOrWorkspaceAgnosticToken.token;
  let workspace;
  try {
    workspace = await graphql(`
      mutation {
        signUpInNewWorkspace(
          input: { displayName: "Workspace", subdomain: "workspace" }
        ) {
          loginToken {
            token
          }
        }
      }
    `);
  } catch (error) {
    if (
      !error.errors?.every((item) =>
        item.message.includes('Unknown argument "input"'),
      )
    )
      throw error;
    workspace = await graphql(`
      mutation {
        signUpInNewWorkspace {
          loginToken {
            token
          }
        }
      }
    `);
  }
  const { signUpInNewWorkspace } = workspace;
  loginToken = signUpInNewWorkspace.loginToken.token;
} else {
  loginToken = registration.loginToken.token;
}
const origin = current ? `, origin: ${JSON.stringify(url)}` : "";
const accessField = current ? "accessOrWorkspaceAgnosticToken" : "accessToken";
const { getAuthTokensFromLoginToken } = await graphql(`mutation {
  getAuthTokensFromLoginToken(loginToken: ${JSON.stringify(loginToken)}${origin}) {
    tokens { ${accessField} { token } }
  }
}`);
token = getAuthTokensFromLoginToken.tokens[accessField].token;
await graphql(`
  mutation {
    activateWorkspace(data: { displayName: "Workspace" }) {
      id
    }
  }
`);
const { currentUser } = await graphql(
  "{ currentUser { workspaceMember { id } } }",
);
const memberId = JSON.stringify(currentUser.workspaceMember.id);
const name = '{name: {firstName: "Eval", lastName: "Admin"}}';
try {
  await graphql(`mutation {
    updateWorkspaceMemberSettings(input: {workspaceMemberId: ${memberId}, update: ${name}})
  }`);
} catch (error) {
  if (
    !error.errors?.every((item) =>
      item.message.includes(
        'Cannot query field "updateWorkspaceMemberSettings"',
      ),
    )
  )
    throw error;
  await graphql(
    `mutation {
    updateWorkspaceMember(id: ${memberId}, data: ${name}) { id }
  }`,
    "/graphql",
  );
}
await graphql("mutation { skipSyncEmailOnboardingStep { success } }");
await graphql("mutation { sendInvitations(emails: []) { __typename } }");
for (let attempt = 0; attempt < 3; attempt++) {
  const { currentUser: ready } = await graphql(
    "{ currentUser { onboardingStatus } }",
  );
  if (ready.onboardingStatus === "COMPLETED") break;
  if (ready.onboardingStatus === "APPS_INSTALLATION") {
    await graphql(
      "mutation { triggerInstallAppsOnboardingStep(universalIdentifiers: [], isAutoSkipped: true) { success } }",
    );
  } else if (ready.onboardingStatus === "BOOK_CALL") {
    await graphql(
      "mutation { completeBookCallOnboardingStep(hasBookedCall: false, isAutoSkipped: true) { success } }",
    );
  } else {
    throw new Error(`Twenty setup is incomplete: ${ready.onboardingStatus}`);
  }
}
const { currentUser: ready } = await graphql(
  "{ currentUser { onboardingStatus } }",
);
if (ready.onboardingStatus !== "COMPLETED")
  throw new Error(`Twenty setup is incomplete: ${ready.onboardingStatus}`);
process.stdout.write(
  "Twenty account setup completed without development seeds.\n",
);
