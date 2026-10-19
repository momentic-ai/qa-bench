const { io } = require("socket.io-client");

const username = "admin";
const password = "momentic-eval";
const statusSlug = "momentic-service-status";
const baseUrl = "http://uptime-kuma:3001";
const fixtureUrl = process.env.FIXTURE_URL;
const defaultMonitor = {
  parent: null,
  interval: 60,
  retryInterval: 60,
  maxretries: 1,
  retryOnlyOnStatusCodeFailure: false,
  notificationIDList: {},
  ignoreTls: false,
  upsideDown: false,
  expiryNotification: false,
  domainExpiryNotification: true,
  maxredirects: 10,
  accepted_statuscodes: ["200-299"],
  saveResponse: false,
  saveErrorResponse: true,
  responseMaxLength: 1024,
  dns_resolve_type: "A",
  dns_resolve_server: "",
  docker_container: "",
  docker_host: null,
  proxyId: null,
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  rabbitmqNodes: [],
  conditions: [],
};

const monitors = [
  {
    ...defaultMonitor,
    name: "Uptime Kuma Dashboard",
    type: "http",
    url: `${baseUrl}/`,
    interval: 60,
    maxretries: 1,
    accepted_statuscodes: ["200-299"],
  },
  {
    ...defaultMonitor,
    name: "Application Entry API",
    type: "http",
    url: `${baseUrl}/api/entry-page`,
    interval: 60,
    maxretries: 1,
    accepted_statuscodes: ["200-299"],
  },
  {
    ...defaultMonitor,
    name: "Admin Sign-in Page",
    type: "http",
    url: `${baseUrl}/login`,
    interval: 60,
    maxretries: 1,
    accepted_statuscodes: ["200-299"],
  },
  {
    ...defaultMonitor,
    name: "Web Console TCP",
    type: "port",
    hostname: "uptime-kuma",
    port: 3001,
    interval: 60,
    maxretries: 1,
  },
];

function ack(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${event} timed out`)),
      10000,
    );
    socket.emit(event, ...args, (result) => {
      clearTimeout(timeout);
      if (result && result.ok === false) {
        reject(new Error(`${event} failed: ${result.msg || "unknown error"}`));
        return;
      }
      resolve(result || {});
    });
  });
}

async function connect() {
  const socket = io(baseUrl, {
    reconnection: false,
    timeout: 5000,
    transports: ["websocket", "polling"],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Socket.IO connection timed out")),
      10000,
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return socket;
}

async function configureDatabase() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/setup-database-info`);
      if (!response.ok) {
        return;
      }

      const info = await response.json();
      if (!info.needSetup) {
        return;
      }

      const setup = await fetch(`${baseUrl}/setup-database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbConfig: { type: "sqlite" } }),
      });
      if (!setup.ok) {
        throw new Error(`SQLite setup failed: HTTP ${setup.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return;
    } catch (error) {
      if (attempt === 119) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  await configureDatabase();

  let socket;
  let needSetup;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      socket = await connect();
      // Database setup can accept sockets before the application handlers are ready.
      needSetup = await ack(socket, "needSetup");
      break;
    } catch (error) {
      socket?.disconnect();
      if (attempt === 29) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  try {
    if (needSetup === true) {
      await ack(socket, "setup", username, password);
      socket.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      socket = await connect();
    }

    let monitorList = {};
    const monitorListReady = new Promise((resolve) => {
      socket.once("monitorList", (list) => {
        monitorList = list || {};
        resolve();
      });
    });
    await ack(socket, "login", { username, password });
    await Promise.race([
      monitorListReady,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    for (const monitor of monitors) {
      const exists = Object.values(monitorList).some(
        (item) => item.name === monitor.name,
      );
      if (!exists) {
        const created = await ack(socket, "add", monitor);
        monitorList[created.monitorID] = { ...monitor, id: created.monitorID };
      }
    }

    let statusPage;
    try {
      statusPage = await ack(socket, "getStatusPage", statusSlug);
    } catch {
      await ack(socket, "addStatusPage", "Momentic Service Status", statusSlug);
      statusPage = await ack(socket, "getStatusPage", statusSlug);
    }

    const statusConfig = {
      ...statusPage.config,
      title: "Momentic Service Status",
      description: `Fixture service health overview. Admin dashboard: ${fixtureUrl}`,
      theme: "light",
      published: true,
      showTags: true,
      footerText: `Admin dashboard: ${fixtureUrl}`,
    };
    const publicMonitors = Object.values(monitorList)
      .filter((monitor) => monitors.some((seed) => seed.name === monitor.name))
      .map((monitor) => ({ ...monitor }));

    await ack(socket, "saveStatusPage", statusSlug, statusConfig, "", [
      { name: "Fixture services", monitorList: publicMonitors },
    ]);

    const settings = await ack(socket, "getSettings");
    await ack(
      socket,
      "setSettings",
      {
        ...settings.data,
        statusPagePublished: true,
        statusPageTheme: "light",
        statusPageTags: true,
      },
      null,
    );
  } finally {
    if (socket) {
      socket.disconnect();
    }
  }

  require("node:fs").writeFileSync("/tmp/fixture-seeded", "ready");
  process.stdout.write("Uptime Kuma fixture provisioned.\n");
  setInterval(() => {}, 3600000);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
