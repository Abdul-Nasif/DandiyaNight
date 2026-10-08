/* Landing page: 3-step register + verify e-pass */
(function () {
  const PRICE = 169, FEE = 10, TOTAL = PRICE + FEE;
  const $ = id => document.getElementById(id);

  const form = $("regForm"), cart = $("cart"), pay = $("pay"), done = $("done"), steps = $("steps");
  if (!form) return;   // not on landing page

  const panes = { form, cart, pay, done };
  const order = ["form", "cart", "pay"];
  const val = n => form.elements[n].value.trim();

  function show(name, scroll = true) {
    Object.entries(panes).forEach(([k, el]) => (el.hidden = k !== name));
    steps.hidden = name === "done";
    const cur = order.indexOf(name);
    steps.querySelectorAll("[data-s]").forEach(s => {
      const i = order.indexOf(s.dataset.s);
      s.classList.toggle("on", i === cur);
      s.classList.toggle("ok", i < cur);
    });
    steps.querySelectorAll("i").forEach((l, k) => l.classList.toggle("ok", k < cur));
    if (scroll) document.querySelector(".reg").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  show("form", false);

  form.addEventListener("submit", e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    $("c-name").textContent = val("name");
    $("c-sub").textContent = val("roll").toUpperCase() + ", " + val("branch") + ", " + val("year");
    show("cart");
  });
  $("editBtn").addEventListener("click", () => show("form"));
  $("cartBack").addEventListener("click", () => show("form"));
  $("toPay").addEventListener("click", () => show("pay"));
  $("payBack").addEventListener("click", () => show("cart"));

  /* -------- glass dropdowns -------- */
  document.querySelectorAll(".dd").forEach(dd => {
    const sel = dd.querySelector("select"), btn = dd.querySelector(".dd-btn"), list = dd.querySelector(".dd-list");
    const opts = []; let act = -1;
    list.setAttribute("role", "listbox");

    const add = o => {
      const d = document.createElement("div");
      d.className = "dd-o"; d.setAttribute("role", "option");
      d.textContent = o.textContent; d.dataset.v = o.value || o.textContent;
      list.append(d); opts.push(d);
    };
    [...sel.children].forEach(c => {
      if (c.tagName === "OPTGROUP") {
        const g = document.createElement("div");
        g.className = "dd-g"; g.setAttribute("role", "presentation");
        g.textContent = c.label; list.append(g);
        [...c.children].forEach(add);
      } else if (!c.disabled) add(c);
    });

    const setAct = i => {
      opts.forEach((o, k) => o.classList.toggle("act", k === i));
      act = i; if (i >= 0) opts[i].scrollIntoView({ block: "nearest" });
    };
    const open  = () => { dd.classList.add("open"); btn.setAttribute("aria-expanded", "true");
                          setAct(Math.max(0, opts.findIndex(o => o.dataset.v === sel.value))); };
    const close = () => { dd.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
    const pick  = o => {
      sel.value = o.dataset.v; btn.textContent = o.textContent;
      btn.classList.remove("ph", "bad");
      opts.forEach(x => x.setAttribute("aria-selected", x === o));
      close(); btn.focus();
    };

    btn.addEventListener("click", () => (dd.classList.contains("open") ? close() : open()));
    list.addEventListener("mousedown", e => e.preventDefault());
    list.addEventListener("click", e => { const o = e.target.closest(".dd-o"); if (o) pick(o); });
    btn.addEventListener("keydown", e => {
      const isOpen = dd.classList.contains("open");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) open();
        else setAct(Math.min(opts.length - 1, Math.max(0, act + (e.key === "ArrowDown" ? 1 : -1))));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (isOpen && act >= 0) pick(opts[act]); else open();
      } else if (e.key === "Escape" || e.key === "Tab") close();
    });
    document.addEventListener("click", e => { if (!dd.contains(e.target)) close(); });
    sel.addEventListener("focus", () => btn.focus());
    sel.addEventListener("invalid", () => btn.classList.add("bad"));
  });

  /* -------- screenshot picker -------- */
  const shot = $("shot"), payErr = $("payErr");
  const showErr = m => { payErr.textContent = m; payErr.hidden = false; };
  const resetShot = () => {
    shot.value = ""; $("prev").hidden = true;
    shot.parentElement.classList.remove("has");
    $("dropTxt").textContent = "Tap to upload your screenshot";
  };
  shot.addEventListener("change", () => {
    const f = shot.files[0];
    payErr.hidden = true;
    if (!f) return resetShot();
    if (!f.type.startsWith("image/") || f.size > 10 * 1024 * 1024) {
      resetShot(); return showErr("Upload an image (PNG or JPG) under 10 MB.");
    }
    $("prev").src = URL.createObjectURL(f); $("prev").hidden = false;
    shot.parentElement.classList.add("has");
    $("dropTxt").textContent = f.name;
  });

  /* -------- shrink screenshot client-side -------- */
  const toJpeg = file => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => rej(new Error("Could not read that image."));
    img.src = URL.createObjectURL(file);
  });

  /* -------- submit -------- */
  pay.addEventListener("submit", async e => {
    e.preventDefault();
    if (!pay.reportValidity()) return;
    const btn = $("payBtn");
    btn.disabled = true; btn.textContent = "Submitting...";
    payErr.hidden = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      data.utr = $("utr").value.trim();
      data.screenshot = await toJpeg(shot.files[0]);

      const r = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Could not submit.");

      $("ref").textContent = j.ref;
      $("viewPass").href = "/verify/" + encodeURIComponent(j.ref);
      $("doneMsg").textContent = "Thanks, " + val("name").split(" ")[0] +
        ". We are checking your ₹" + TOTAL + " payment. Once verified, your e-pass is unlocked.";
      show("done");
    } catch (err) {
      showErr(err.message || "Could not submit. Try again.");
    }
    btn.disabled = false; btn.textContent = "Submit payment details";
  });

  $("again").addEventListener("click", () => {
    form.reset(); pay.reset(); resetShot();
    document.querySelectorAll(".dd-btn").forEach(b => {
      b.classList.add("ph");
      b.textContent = b.dataset.default || b.textContent;
    });
    show("form");
  });

  /* -------- verify form -------- */
  const vf = $("verifyForm");
  if (vf) {
    vf.addEventListener("submit", e => {
      e.preventDefault();
      const ref = $("verifyRef").value.trim().toUpperCase();
      if (!ref) return;
      window.location.href = "/verify/" + encodeURIComponent(ref);
    });
  }
})();