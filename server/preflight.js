import { loadConfig } from './env.js';
try {
  const config = loadConfig();
  process.stdout.write(`Pulse Choir configuration is valid for ${config.origin}. Twitch app, user consent, persistence, and deployment still require separate provisioning.\n`);
} catch (error) {
  process.stderr.write(`Pulse Choir preflight failed: ${error.message}\n`);
  process.exitCode = 1;
}
