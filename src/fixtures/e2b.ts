import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
} from "@e2b/code-interpreter";
import { setTimeout as delay } from "node:timers/promises";

export const DOCKER_TEMPLATE_VERSION = "v1";
export const DOCKER_INSTALL = `set -eu
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates git curl iptables procps xz-utils
curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-28.3.3.tgz -o /tmp/docker.tgz
printf '%s  /tmp/docker.tgz\\n' 40c16bcf324f354b382d07e845e6a79e3493fc0c09b252dff9e1a46125589bff | sha256sum -c -
tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1
rm /tmp/docker.tgz
mkdir -p /var/lib/docker /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose
printf '%s  /usr/local/lib/docker/cli-plugins/docker-compose\\n' 7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4 | sha256sum -c -
curl -fsSL https://github.com/docker/buildx/releases/download/v0.26.1/buildx-v0.26.1.linux-amd64 -o /usr/local/lib/docker/cli-plugins/docker-buildx
printf '%s  /usr/local/lib/docker/cli-plugins/docker-buildx\\n' 9451034b6ca5354e8bf88a2002a413aedabf110fd0f12ebb0b2f2cc241be8e41 | sha256sum -c -
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx`;
export const START_DOCKER = `set -eu
if ! docker info >/dev/null 2>&1; then
  nohup dockerd >/tmp/mo-evals-dockerd.log 2>&1 &
fi
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then exit 0; fi
  sleep 1
done
cat /tmp/mo-evals-dockerd.log >&2
exit 1`;

export function dockerTemplateName(resources = { cpu: 2, memory: 4 }) {
  return `mo-evals-docker-${DOCKER_TEMPLATE_VERSION}-${resources.cpu}cpu-${resources.memory}g`;
}

export function sandboxLifetimeMs(minutes: number) {
  const milliseconds = minutes * 60_000;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 86_400_000
  ) {
    throw new Error(
      "E2B sandbox lifetime must be positive and at most 24 hours (Pro required above one hour).",
    );
  }
  return milliseconds;
}

export async function executeFixtureCommand(
  sandbox: Sandbox,
  command: string,
  cwd = "/",
  envs: Record<string, string> = {},
  timeoutSeconds = 60,
) {
  try {
    const result = await sandbox.commands.run(command, {
      cwd,
      envs,
      user: "root",
      timeoutMs: timeoutSeconds * 1000,
      requestTimeoutMs: (timeoutSeconds + 30) * 1000,
    });
    return { exitCode: result.exitCode, result: result.stdout + result.stderr };
  } catch (error) {
    if (error instanceof CommandExitError) {
      return { exitCode: error.exitCode, result: error.stdout + error.stderr };
    }
    throw error;
  }
}

export async function deleteFixtureSandbox(id: string) {
  const deleted = await Sandbox.kill(id, { requestTimeoutMs: 60_000 });
  await waitForSandboxDeletion(id);
  return deleted;
}

export async function waitForSandboxDeletion(id: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await Sandbox.getInfo(id, { requestTimeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`E2B sandbox ${id} still exists after deletion.`);
    await delay(1000);
  }
}
