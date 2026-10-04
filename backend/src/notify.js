/**
 * Optional "new request" notification. Set the NOTIFY_WEBHOOK_URL secret to a Slack / Discord / ntfy / generic webhook URL.
 *   NOTIFY_FORMAT=json (default): POST {"text": "...", "content": "..."}  — works with Slack and Discord incoming webhooks
 *   NOTIFY_FORMAT=text          : POST the message as plain text         — works with ntfy.sh topics
 * Failures are logged and never affect the contributor's submission.
 */
export async function notifyNewRequest(env, { origin, proposal }) {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  const n = proposal.payload.changes.length, who = proposal.meta?.name, note = proposal.meta?.message;
  const text = "New family tree request: " + n + " change" + (n === 1 ? "" : "s") + (who ? " from " + who : "") + (note ? " — “" + note.slice(0, 200) + "”" : "") + ". Review it: " + origin + "/admin.html";
  const plain = (env.NOTIFY_FORMAT || "json") === "text";
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": plain ? "text/plain" : "application/json" }, body: plain ? text : JSON.stringify({ text, content: text }) });
  } catch (e) {
    console.error("notification failed:", e);
  }
}
