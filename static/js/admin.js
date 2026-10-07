(function () {
  const root = document.getElementById("adminRoot");
  if (!root) return;

  const $ = id => document.getElementById(id);
  const tbody = $("adminTbody");
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll("tr[data-id]"));
  const searchInput  = $("searchFilter");
  const statusSelect = $("statusFilter");
  const emptyFilter  = $("emptyFilter");

  const statTotal    = $("statTotal");
  const statPending  = $("statPending");
  const statApproved = $("statApproved");
  const statRejected = $("statRejected");

  /* ---------- expand / collapse ---------- */
  function detailFor(id) { return tbody.querySelector('tr.detail-row[data-for="' + id + '"]'); }
  function toggleDetails(mainRow) {
    const d = detailFor(mainRow.dataset.id);
    if (!d) return;
    d.hidden = !d.hidden;
  }

  /* ---------- filters ---------- */
  function applyFilters() {
    const q = (searchInput.value || "").toLowerCase().trim();
    const st = statusSelect.value || "";
    let shown = 0;
    rows.forEach(r => {
      const hay = [
        r.dataset.code, r.dataset.names, r.dataset.emails,
        r.dataset.phones, r.dataset.roll, r.dataset.utr
      ].join(" ").toLowerCase();
      const visible = (!q || hay.includes(q)) && (!st || r.dataset.status === st);
      r.hidden = !visible;
      const d = detailFor(r.dataset.id);
      if (d) d.hidden = true;
      if (visible) shown++;
    });
    emptyFilter.hidden = shown > 0 || rows.length === 0;
  }
  searchInput.addEventListener("input", applyFilters);
  statusSelect.addEventListener("change", applyFilters);

  /* ---------- stats ---------- */
  function refreshStats() {
    const total    = rows.length;
    const pending  = rows.filter(r => r.dataset.status === "pending_approval").length;
    const approved = rows.filter(r => r.dataset.status === "approved").length;
    const rejected = rows.filter(r => r.dataset.status === "rejected").length;
    statTotal.textContent    = total;
    statPending.textContent  = pending;
    statApproved.textContent = approved;
    statRejected.textContent = rejected;
  }

  /* ---------- modal ---------- */
  const modal = $("shotModal"), modalImg = $("modalImg"), modalCode = $("modalCode");
  function openModal(id, code) {
    modalCode.textContent = code || "";
    modalImg.src = "/admin/screenshot/" + id + "?t=" + Date.now();
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; modalImg.src = ""; }
  $("modalClose").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

  /* ---------- delegation ---------- */
  root.addEventListener("click", async e => {
    const btn = e.target.closest("button, a");
    if (!btn) return;

    if (btn.classList.contains("details-btn")) {
      e.preventDefault();
      const mainRow = btn.closest("tr[data-id]");
      toggleDetails(mainRow);
      return;
    }

    if (btn.classList.contains("view-shot")) {
      e.preventDefault();
      openModal(btn.dataset.id, btn.dataset.code);
      return;
    }

    if (btn.classList.contains("approve-btn")) {
      e.preventDefault();
      if (btn.disabled) return;
      if (!confirm("Approve this registration?")) return;
      const id = btn.dataset.id;
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = "…";
      try {
        const r = await fetch("/admin/approve/" + id, {
          method: "POST", credentials: "same-origin",
          headers: { "Accept": "application/json" },
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        updateRowStatus(id, "approved");
      } catch (err) {
        alert("Approve failed: " + err.message);
        btn.disabled = false; btn.textContent = orig;
      }
      return;
    }

    if (btn.classList.contains("reject-btn")) {
      e.preventDefault();
      if (btn.disabled) return;
      const notes = prompt("Reason for rejection (optional):", "");
      if (notes === null) return;
      const id = btn.dataset.id;
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = "…";
      try {
        const r = await fetch("/admin/reject/" + id, {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ notes }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        updateRowStatus(id, "rejected");
      } catch (err) {
        alert("Reject failed: " + err.message);
        btn.disabled = false; btn.textContent = orig;
      }
      return;
    }
  });

  function updateRowStatus(id, status) {
    const row = tbody.querySelector('tr[data-id="' + id + '"]');
    if (!row) return;
    row.dataset.status = status;

    const badge = row.querySelector(".badge");
    badge.className = "badge " + ({
      approved: "badge-active",
      rejected: "badge-inactive",
      pending_approval: "badge-pending",
    }[status] || "badge-ghost");
    badge.textContent = status.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    row.querySelectorAll(".approve-btn, .reject-btn").forEach(b => b.disabled = true);

    // add e-pass link if now approved
    if (status === "approved") {
      const actions = row.querySelector(".row-actions");
      if (actions && !actions.querySelector(".btn-ghost")) {
        const a = document.createElement("a");
        a.className = "btn btn-mini btn-ghost";
        a.target = "_blank";
        a.href = "/admin/epass/" + id;
        a.textContent = "e-Pass";
        actions.insertBefore(a, actions.querySelector(".approve-btn"));
      }
    }
    refreshStats();
    applyFilters();
  }

  refreshStats();
  applyFilters();
})();