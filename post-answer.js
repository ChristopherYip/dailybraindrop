// post-answer.js
// Checks the database for questions posted ~2 hours ago that haven't
// been answered yet, and posts the answer as a reply to the original tweet.
// Run this on its own Railway Cron Schedule (e.g. every 15 minutes).

import { TwitterApi } from "twitter-api-v2";
import pg from "pg";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const dbUrl = requireEnv("DATABASE_URL");
  const xApiKey = requireEnv("X_API_KEY");
  const xApiSecret = requireEnv("X_API_SECRET");
  const xAccessToken = requireEnv("X_ACCESS_TOKEN");
  const xAccessSecret = requireEnv("X_ACCESS_SECRET");

  const delayHours = parseFloat(process.env.ANSWER_DELAY_HOURS || "2");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS pending_answers (
      id SERIAL PRIMARY KEY,
      tweet_id TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      replied BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  const due = await client.query(
    `SELECT id, tweet_id, options_text, answer_text FROM pending_answers
     WHERE replied = FALSE
     AND posted_at <= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY posted_at ASC;`,
    [delayHours]
  );

  if (due.rows.length === 0) {
    console.log("No answers due yet.");
    await client.end();
    return;
  }

  const twitter = new TwitterApi({
    appKey: xApiKey,
    appSecret: xApiSecret,
    accessToken: xAccessToken,
    accessSecret: xAccessSecret,
  });

  for (const row of due.rows) {
    try {
      const replyText = `Answer: ${row.answer_text}`.slice(0, 280);
      const result = await twitter.v2.reply(replyText, row.tweet_id);
      console.log(`Replied to ${row.tweet_id} with answer. Reply ID: ${result.data.id}`);
      await client.query(`UPDATE pending_answers SET replied = TRUE WHERE id = $1;`, [row.id]);
    } catch (err) {
      console.error(`Failed to reply to tweet ${row.tweet_id}:`, err.message);
      // Leave replied = FALSE so it gets retried next run
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
