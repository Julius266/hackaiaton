import express from 'express';
import { env } from './config/env';
import { createApp } from './express-factory';

const app = createApp();

/** Satisfies tooling that expects `express` referenced from this entry file. */
void express;

export default app;

if (require.main === module) {
  app.listen(env.PORT, () => {
    // Keep startup log compact so the hackathon demo stays easy to scan.
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}
