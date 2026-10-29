import { DevinQaClient } from "./qa-client";
import { prepareSecurityProfile, verifyCleanOrganization } from "./qa-security";

const client = DevinQaClient.fromEnvironment();
await verifyCleanOrganization(client);
await prepareSecurityProfile(client, []);
process.stdout.write(
  "Devin QA authentication and VM policy prerequisites passed. No session started.\n",
);
