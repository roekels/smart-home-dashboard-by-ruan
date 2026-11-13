// Pairing for a wall tablet (modules/kiosk). Plain script: ask for a code, show it, poll until an admin approves it
// in Settings, then the Worker sets this tablet's key (an HttpOnly cookie) and we open the wall page.
// It only talks to /api/kiosk/pair/* on its own origin.
(function () {
  "use strict";
  var code = document.getElementById("code"), msg = document.getElementById("msg");
  var where = msg.getAttribute("data-dashboard") || "your dashboard";
  var secret = null, timer = 0;

  function post(path, body) {
    return fetch(path, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "X-Dashboard": "1" },
      body: JSON.stringify(body || {}),
    });
  }

  function start() {
    window.clearTimeout(timer);
    post("/api/kiosk/pair/start").then(function (r) {
      if (!r.ok) throw new Error(r.status === 429 ? "Too many tablets pairing right now. Trying again in a minute." : "Could not get a code. Trying again.");
      return r.json();
    }).then(function (j) {
      secret = j.secret;
      code.textContent = j.code;
      msg.textContent = "On " + where + ", open Settings > Wall tablets and type this code. It is valid for 10 minutes.";
      timer = window.setTimeout(poll, 3000);
    }).catch(function (e) {
      msg.textContent = e.message;
      timer = window.setTimeout(start, 60000);
    });
  }

  function poll() {
    post("/api/kiosk/pair/poll", { secret: secret }).then(function (r) {
      if (r.status === 410) return start(); // expired or used: a fresh code
      if (!r.ok) { timer = window.setTimeout(poll, 10000); return; }
      return r.json().then(function (j) {
        if (j.status === "paired") {
          code.textContent = "Paired";
          msg.textContent = "Opening the wall page …";
          window.location.replace("/kiosk");
          return;
        }
        timer = window.setTimeout(poll, 3000);
      });
    }).catch(function () { timer = window.setTimeout(poll, 10000); });
  }

  start();
})();
