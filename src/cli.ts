import { main } from './main.ts';

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error) => {
    process.stderr.write(`fatal: ${(error as Error).stack ?? error}\n`);
    process.exit(1);
  },
);
