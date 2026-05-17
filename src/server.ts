import { env } from './config/env';
import app from './app';

export default app;

if (require.main === module) {
  app.listen(env.PORT, () => {
    // Keep startup log compact so the hackathon demo stays easy to scan.
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}
