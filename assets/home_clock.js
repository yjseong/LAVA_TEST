/* UTC / KST clock of the Home page (the box at the top left of the map).
 * Plain DOM, no Dash callback: a callback every second made the browser tab title flicker ("Updating...") and
 * made Dash re-check all its components each second. It fills <div id="home-clocks"> (pages/home.py), which has
 * no Dash children, so Dash never touches what is written here. */
(function () {
  function el(tag, css, text) {
    var e = document.createElement(tag);
    e.style.cssText = css;
    if (text !== undefined) { e.textContent = text; }
    return e;
  }
  var FMT = {};                                // the formatters are built once, not on every tick
  function fmt(kind, zone) {
    var key = kind + zone;
    if (!FMT[key]) {
      FMT[key] = kind === 'date'
        ? new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: '2-digit', year: 'numeric' })
        : new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit',
                                             hourCycle: 'h23' });
    }
    return FMT[key];
  }
  function date(zone, now) { return fmt('date', zone).format(now); }
  function time(zone, now) { return fmt('time', zone).format(now); }
  function block(label) {
    var b = el('div', 'flex:1 1 0;min-width:0;white-space:nowrap');
    b.appendChild(el('div', 'font-size:14px;color:#667085;font-weight:700', label));
    b._date = b.appendChild(el('div', 'font-size:16px;font-weight:700'));
    b._time = b.appendChild(el('div', 'font-size:19px;font-weight:700;font-variant-numeric:tabular-nums'));
    return b;
  }
  function ensure() {                            // creates the clock inside <div id="home-clocks"> the first time
    var host = document.getElementById('home-clocks');
    if (!host) { return null; }
    if (!host._clock) {                          // first time for this element (also after navigating back to Home)
      var row = el('div', 'display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:12px;width:100%');
      host._clock = { utc: row.appendChild(block('UTC')), kst: row.appendChild(block('KST')) };
      host.appendChild(row);
    }
    return host._clock;
  }
  function tick() {
    var c = ensure();
    if (!c) { return; }
    var now = new Date();
    c.utc._date.textContent = date('UTC', now);        c.utc._time.textContent = time('UTC', now);
    c.kst._date.textContent = date('Asia/Seoul', now); c.kst._time.textContent = time('Asia/Seoul', now);
  }
  function start() {
    // The observer only reacts while the box does not exist yet. It must NOT call tick(): tick() writes into the
    // observed page, which would trigger the observer again and again (an endless loop that froze the page).
    new MutationObserver(function () {
      var host = document.getElementById('home-clocks');
      if (host && !host._clock) { tick(); }
    }).observe(document.body, { childList: true, subtree: true });
    window.setInterval(tick, 1000);
    tick();
  }
  if (document.body) { start(); } else { document.addEventListener('DOMContentLoaded', start); }
})();
