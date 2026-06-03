// scripts/start-bot.js
// Entry point script to start the Roxstar AI bot.

import { createBotRunner } from '../src/core/BotRunner.js';
import { registerSignalHandlers } from '../src/core/BotRunner.js';

const runner = createBotRunner();
registerSignalHandlers(runner);

runner.start().catch(async (err) => {
  console.error('Bot failed to start:', err);
  await runner.stop('startup_error');
});
