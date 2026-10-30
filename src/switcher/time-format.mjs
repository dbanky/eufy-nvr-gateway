// Times as shown on the stream and in the log, in the camera's time zone. 24-hour clock.

export function createTimeFormat(timeZone) {
  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const hms = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone, hour12: false });
  // Calendar day number in the time zone, so "yesterday" means yesterday where the camera is.
  const day = (t) => {
    const [y, m, d] = new Date(t).toLocaleDateString('en-CA', { timeZone }).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };

  // "since 18:33" · "since yesterday 22:10" · "since Mon 22:10" · "since 12 Oct"
  const since = (t, now) => {
    const daysAgo = day(now) - day(t);
    if (daysAgo <= 0) return `since ${hm(t)}`;
    if (daysAgo === 1) return `since yesterday ${hm(t)}`;
    if (daysAgo < 7) return `since ${new Date(t).toLocaleDateString('en-GB', { timeZone, weekday: 'short' })} ${hm(t)}`;
    return `since ${new Date(t).toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'short' })}`;
  };

  return { hm, hms, since };
}
