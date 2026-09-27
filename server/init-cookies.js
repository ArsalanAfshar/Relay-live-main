import fs from 'fs';

if (process.env.YT_DLP_COOKIES_CONTENT) {
  const path = '/tmp/cookies.txt';
  fs.writeFileSync(path, process.env.YT_DLP_COOKIES_CONTENT);
  process.env.YT_DLP_COOKIES_FILE = path;
}
