/* Monobank — оплата в картці замовлення (модуль monobank). Підключається хуком displayOrderPayment. */
(function () {
	"use strict";
	const root = document.getElementById("mono-panel");
	if (!root || root.dataset.ready) return;
	root.dataset.ready = "1";

	const OID = Number(root.dataset.order);
	const EDIT = root.dataset.edit === "1";
	const SETTINGS = root.dataset.settings === "1";
	let L = {};
	try {
		L = JSON.parse(root.dataset.l || "{}");
	} catch (e) {}
	const B = "/api/module/monobank/order/" + OID;
	const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const t = (k) => (L[k] !== undefined ? L[k] : k);
	const money = (v, cur) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + esc(cur || "");
	const date = (v) => (v ? new Date(v).toLocaleString() : "");
	const BADGE = { created: "warning", processing: "info", hold: "primary", success: "success", failure: "danger", reversed: "secondary", expired: "secondary", removed: "secondary" };
	const RBADGE = { processing: "info", success: "success", failure: "danger" };

	async function api(path, body) {
		const res = await fetch(B + path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}) });
		let j = {};
		try {
			j = await res.json();
		} catch (e) {}
		if (!res.ok || !j.ok) throw Object.assign(new Error(j.error || t("error")), { code: j.code || "" });
		return j;
	}
	function toast(msg, ok) {
		if (window.Notyf) {
			if (!window.__monoNotyf) window.__monoNotyf = new Notyf({ duration: 4000, position: { x: "right", y: "top" } });
			return ok ? window.__monoNotyf.success(msg) : window.__monoNotyf.error(msg);
		}
		if (!ok) alert(msg);
	}

	let state = null;

	async function load() {
		root.innerHTML = '<div class="p-3 text-secondary small"><span class="spinner-border spinner-border-sm"></span></div>';
		try {
			state = await api("/");
		} catch (e) {
			root.innerHTML = `<div class="p-3 text-danger small">${esc(e.message)}</div>`;
			return;
		}
		render();
	}

	function details(i) {
		const p = i.payment_info;
		if (!p) return "";
		const parts = [
			p.masked_pan ? `<i class="fa-regular fa-credit-card me-1"></i>${esc(p.masked_pan)}` : "",
			p.system ? esc(p.system) : "",
			p.method ? esc(t("pm_" + p.method)) : "",
			p.bank ? esc(p.bank) : "",
			p.rrn ? `RRN ${esc(p.rrn)}` : "",
			p.approval_code ? `${esc(t("approval"))} ${esc(p.approval_code)}` : "",
			i.fee !== null ? `${esc(t("fee"))}: ${money(i.fee, i.currency)}` : "",
		].filter(Boolean);
		return parts.length ? `<div class="small mt-1">${parts.join(" · ")}</div>` : "";
	}

	function refundsList(i) {
		if (!i.refunds.length) return "";
		return `<div class="small mt-1">${i.refunds
			.map(
				(r) =>
					`<div><i class="fa-solid fa-rotate-left me-1 text-secondary"></i>${esc(r.hold ? t("hold_released") : t("refund"))} ${esc(r.number)}: <b>${money(r.amount, i.currency)}</b> <span class="badge rounded-0 text-bg-${RBADGE[r.status] || "secondary"}">${esc(t("rs_" + r.status))}</span> <span class="text-secondary">${esc(date(r.date_add))}${r.user ? " · " + esc(r.user) : ""}</span></div>`
			)
			.join("")}</div>`;
	}

	function invoiceRow(i) {
		const open = i.status === "created" || i.status === "processing";
		const paid = i.status === "success" || i.status === "reversed";
		const meta = [
			i.expires_at && i.status === "created" ? `${esc(t("expires"))}: ${esc(date(i.expires_at))}` : "",
			i.hold_until && i.status === "hold" ? `<span class="text-danger">${esc(t("hold_until"))}: ${esc(date(i.hold_until))}</span>` : "",
			i.paid_at ? `${esc(t("paid_at"))}: ${esc(date(i.paid_at))}` : "",
			i.account ? esc(i.account) : "",
			i.user ? `${esc(t("by"))}: ${esc(i.user)}` : "",
			i.failure_reason ? `${esc(t("failure"))}: ${esc(i.failure_reason)}` : "",
		].filter(Boolean);
		const amount = i.final_amount !== null && i.final_amount !== i.amount ? `${money(i.final_amount, i.currency)} <s class="text-secondary small">${money(i.amount, i.currency)}</s>` : money(i.amount, i.currency);
		return `<div class="border-top px-3 py-2" data-inv="${i.id}">
			<div class="d-flex flex-wrap align-items-center gap-2">
				<span class="badge rounded-0 text-bg-${BADGE[i.status] || "secondary"}">${esc(t("st_" + i.status))}</span>
				<b>${amount}</b>
				${i.payment_type === "hold" ? `<span class="badge rounded-0 text-bg-light border">${esc(t("pt_hold"))}</span>` : ""}
				${i.source === "qr" ? `<span class="badge rounded-0 text-bg-light border"><i class="fa-solid fa-qrcode me-1"></i>${esc(i.qr || t("src_qr"))}</span>` : ""}
				${i.source === "wallet" ? `<span class="badge rounded-0 text-bg-light border"><i class="fa-regular fa-credit-card me-1"></i>${esc(t("src_wallet"))}</span>` : ""}
				${i.payment_type === "verification" ? `<span class="badge rounded-0 text-bg-light border">${esc(t("pt_verification"))}</span>` : ""}
				${i.source === "statement" ? `<span class="badge rounded-0 text-bg-light border" title="${esc(t("src_statement_help"))}">${esc(t("src_statement"))}</span>` : ""}
				<span class="small text-secondary">${esc(date(i.date_add))}</span>
				<span class="ms-auto btn-group btn-group-sm flex-wrap">
					<button type="button" class="btn btn-outline-secondary rounded-0" data-act="refresh" title="${esc(t("refresh"))}"><i class="fa-solid fa-rotate"></i></button>
					<button type="button" class="btn btn-outline-secondary rounded-0" data-act="events" title="${esc(t("events"))}"><i class="fa-solid fa-list"></i></button>
					${paid ? `<button type="button" class="btn btn-outline-secondary rounded-0" data-act="receipt" title="${esc(t("receipt"))}"><i class="fa-solid fa-receipt"></i></button>` : ""}
					${paid && i.fiscal ? `<button type="button" class="btn btn-outline-secondary rounded-0" data-act="fiscal" title="${esc(t("fiscal"))}"><i class="fa-solid fa-file-invoice"></i></button>` : ""}
					${EDIT && i.status === "hold" ? `<button type="button" class="btn btn-outline-success rounded-0" data-act="finalize"><i class="fa-solid fa-check me-1"></i>${esc(t("finalize"))}</button>` : ""}
					${EDIT && i.status === "hold" ? `<button type="button" class="btn btn-outline-danger rounded-0" data-act="release" title="${esc(t("release"))}"><i class="fa-solid fa-lock-open"></i></button>` : ""}
					${EDIT && i.status === "success" && i.refundable > 0 ? `<button type="button" class="btn btn-outline-danger rounded-0" data-act="refund"><i class="fa-solid fa-rotate-left me-1"></i>${esc(t("refund"))}</button>` : ""}
					${EDIT && i.status === "created" ? `<button type="button" class="btn btn-outline-danger rounded-0" data-act="remove" title="${esc(t("remove"))}"><i class="fa-solid fa-ban"></i></button>` : ""}
				</span>
			</div>
			${
				open
					? `<div class="input-group input-group-sm mt-2">
				<input type="text" class="form-control rounded-0" value="${esc(i.page_url)}" readonly data-url />
				<button type="button" class="btn btn-outline-primary rounded-0" data-act="copy"><i class="fa-regular fa-copy me-1"></i>${esc(t("copy"))}</button>
				<a class="btn btn-outline-secondary rounded-0" href="${esc(i.page_url)}" target="_blank" rel="noopener" title="${esc(t("open"))}"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
			</div>`
					: ""
			}
			${details(i)}
			${refundsList(i)}
			${meta.length ? `<div class="small text-secondary mt-1">${meta.join(" · ")}</div>` : ""}
			<div class="small mt-2 d-none" data-extra></div>
		</div>`;
	}

	function render() {
		const s = state;
		if (!s.has_accounts) {
			root.innerHTML = `<div class="p-3 small"><i class="fa-solid fa-credit-card me-1"></i>${esc(t("no_accounts"))} ${SETTINGS ? `<a href="/modules/monobank/">${esc(t("setup"))}</a>` : ""}</div>`;
			return;
		}
		let h = `<div class="px-3 pt-3 pb-2">
			<div class="d-flex align-items-center mb-2"><i class="fa-solid fa-credit-card me-2"></i><b class="me-auto">${esc(t("title"))}</b></div>
			<div class="small">${esc(t("total"))}: <b>${money(s.total, s.currency)}</b> · ${esc(t("paid"))}: <b>${money(s.paid, s.currency)}</b> · ${esc(t("due"))}: <b>${money(s.due, s.currency)}</b></div>`;
		if (!s.supported) h += `<div class="small text-danger mt-2">${esc(t("unsupported"))}</div>`;
		else if (EDIT)
			h += `<div class="row g-2 align-items-end mt-1">
				<div class="col-sm-5"><label class="form-label small mb-1">${esc(t("amount"))}</label><input type="number" min="0.01" step="0.01" class="form-control form-control-sm rounded-0" data-f="amount" placeholder="${esc(Number(s.due).toFixed(2))}" title="${esc(t("amount_help"))}" /></div>
				<div class="col-sm-4"><label class="form-label small mb-1">${esc(t("payment_type"))}</label><select class="form-select form-select-sm rounded-0" data-f="type"><option value="">${esc(t("pt_default"))}</option><option value="debit">${esc(t("pt_debit"))}</option>${s.hold_allowed ? `<option value="hold">${esc(t("pt_hold"))}</option>` : ""}</select></div>
				<div class="col-sm-3"><button type="button" class="btn btn-sm btn-primary rounded-0 w-100" data-act="create"><i class="fa-solid fa-link me-1"></i>${esc(t("create"))}</button></div>
			</div>${extraTools(s)}`;
		h += `</div>`;
		h += s.invoices.length ? s.invoices.map(invoiceRow).join("") : `<div class="border-top px-3 py-2 small text-secondary">${esc(t("no_invoices"))}</div>`;
		root.innerHTML = h;
	}

	/* QR-каса й збережені картки: та сама сума й тип, що й для посилання */
	function extraTools(s) {
		let h = "";
		if (s.qr && s.qr.length)
			h += `<div class="input-group input-group-sm mt-2">
				<span class="input-group-text rounded-0"><i class="fa-solid fa-qrcode"></i></span>
				<select class="form-select rounded-0" data-f="qr">${s.qr.map((q) => `<option value="${q.id}">${esc(q.name)}</option>`).join("")}</select>
				<button type="button" class="btn btn-outline-primary rounded-0" data-act="qr">${esc(t("qr_assign"))}</button>
			</div>`;
		if (s.tokenization && !s.client) h += `<div class="small text-secondary mt-2"><i class="fa-regular fa-credit-card me-1"></i>${esc(t("cards_no_client"))}</div>`;
		else if (s.tokenization) {
			h += `<div class="d-flex flex-wrap gap-2 align-items-center mt-2 small"><i class="fa-regular fa-credit-card"></i><b>${esc(t("cards"))}</b>
				<button type="button" class="btn btn-sm btn-link p-0" data-act="cards-refresh" title="${esc(t("refresh"))}"><i class="fa-solid fa-rotate"></i></button>
				<button type="button" class="btn btn-sm btn-link p-0 ms-auto" data-act="card-verify">${esc(t("card_verify"))}</button></div>`;
			h += s.cards.length
				? s.cards
						.map(
							(c) => `<div class="input-group input-group-sm mt-1" data-card="${c.id}">
					<span class="input-group-text rounded-0 flex-grow-1">${esc(c.masked_pan || "—")}${c.status === "new" ? ` <span class="badge text-bg-secondary rounded-0 ms-1">${esc(t("card_new"))}</span>` : ""}</span>
					<button type="button" class="btn btn-outline-success rounded-0" data-act="card-pay"><i class="fa-solid fa-bolt me-1"></i>${esc(t("card_pay"))}</button>
					<button type="button" class="btn btn-outline-danger rounded-0" data-act="card-delete" title="${esc(t("card_delete"))}"><i class="fa-solid fa-trash"></i></button>
				</div>`
						)
						.join("")
				: `<div class="small text-secondary">${esc(t("cards_none"))}</div>`;
		}
		return h;
	}
	const formValues = () => {
		const amount = root.querySelector('[data-f="amount"]').value;
		const type = root.querySelector('[data-f="type"]').value;
		return { amount: amount === "" ? null : Number(amount), payment_type: type || undefined };
	};

	async function copy(url, box) {
		try {
			await navigator.clipboard.writeText(url);
		} catch (e) {
			// Без HTTPS clipboard недоступний — виділяємо текст для Ctrl+C
			const el = (box || root).querySelector("[data-url]");
			if (el) el.select();
		}
	}

	/* ─── Повернення: модальне вікно з позиціями замовлення ─── */
	let modal = null;
	function refundModal(inv, f) {
		let el = document.getElementById("mono-refund");
		if (!el) {
			el = document.createElement("div");
			el.id = "mono-refund";
			el.className = "modal fade";
			el.tabIndex = -1;
			document.body.appendChild(el);
			modal = new bootstrap.Modal(el);
		}
		const rows = f.items
			.map(
				(it) => `<tr data-item="${it.id}" data-unit="${it.unit}">
					<td>${esc(it.name)}${it.sku ? `<div class="small text-secondary">${esc(it.sku)}</div>` : ""}</td>
					<td class="text-end text-nowrap">${money(it.unit, f.currency)}</td>
					<td style="width:110px"><input type="number" class="form-control form-control-sm rounded-0" min="0" max="${it.available}" step="1" value="0" data-qty /></td>
					<td class="text-center"><input type="checkbox" class="form-check-input" data-restock ${it.mapped ? "checked" : "disabled"} /></td>
				</tr>`
			)
			.join("");
		el.innerHTML = `<div class="modal-dialog modal-lg"><form class="modal-content rounded-0" autocomplete="off">
			<div class="modal-header"><h5 class="modal-title">${esc(t("refund_title"))}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
			<div class="modal-body">
				<div class="small mb-2">${esc(t("refundable"))}: <b>${money(f.refundable, f.currency)}</b>${f.fiscal ? ` · <span class="text-primary">${esc(t("fiscal_on"))}</span>` : ""}</div>
				<table class="table table-sm align-middle"><thead><tr><th>${esc(t("item"))}</th><th class="text-end">${esc(t("price"))}</th><th>${esc(t("qty"))}</th><th class="text-center">${esc(t("restock"))}</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="text-secondary">${esc(t("no_items"))}</td></tr>`}</tbody></table>
				<div class="row g-2">
					<div class="col-md-4"><label class="form-label small mb-1">${esc(t("shipping"))}</label><input type="number" class="form-control form-control-sm rounded-0" min="0" max="${f.shipping}" step="0.01" value="0" data-shipping /></div>
					<div class="col-md-4"><label class="form-label small mb-1">${esc(t("refund_amount"))}</label><input type="number" class="form-control form-control-sm rounded-0" min="0" step="0.01" data-amount ${f.fiscal ? "readonly" : ""} /><div class="form-text">${esc(f.fiscal ? t("amount_fiscal") : t("amount_manual"))}</div></div>
					<div class="col-md-4"><label class="form-label small mb-1">${esc(t("reason"))}</label><input type="text" class="form-control form-control-sm rounded-0" maxlength="255" data-reason /></div>
				</div>
			</div>
			<div class="modal-footer">
				<button type="button" class="btn btn-outline-secondary rounded-0" data-bs-dismiss="modal">${esc(t("cancel"))}</button>
				<button type="submit" class="btn btn-danger rounded-0"><i class="fa-solid fa-rotate-left me-1"></i>${esc(t("refund_do"))}</button>
			</div>
		</form></div>`;
		const form = el.querySelector("form");
		const amountEl = form.querySelector("[data-amount]");
		let touched = false;
		const recalc = () => {
			if (touched && !f.fiscal) return;
			let sum = Number(form.querySelector("[data-shipping]").value) || 0;
			form.querySelectorAll("tr[data-item]").forEach((tr) => (sum += (Number(tr.querySelector("[data-qty]").value) || 0) * Number(tr.dataset.unit)));
			amountEl.value = sum ? sum.toFixed(2) : "";
		};
		form.addEventListener("input", (e) => {
			if (e.target === amountEl) touched = !!amountEl.value;
			else recalc();
		});
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const items = [...form.querySelectorAll("tr[data-item]")]
				.map((tr) => ({ id_item: Number(tr.dataset.item), qty: Number(tr.querySelector("[data-qty]").value) || 0, restock: tr.querySelector("[data-restock]").checked }))
				.filter((x) => x.qty > 0);
			const amount = Number(amountEl.value) || 0;
			if (!amount) return toast(t("refund_empty"), false);
			if (!confirm(t("confirm_refund").replace("%s", amount.toFixed(2) + " " + f.currency))) return;
			const btn = form.querySelector("[type=submit]");
			btn.disabled = true;
			try {
				state = await api(`/${inv.id}/refund/`, {
					items,
					shipping: Number(form.querySelector("[data-shipping]").value) || 0,
					amount: touched && !f.fiscal ? amount : null,
					reason: form.querySelector("[data-reason]").value,
					restock: items.some((x) => x.restock),
				});
				modal.hide();
				render();
				toast(t("refund_done"), true);
			} catch (err) {
				toast(err.message, false);
			} finally {
				btn.disabled = false;
			}
		});
		modal.show();
	}

	root.addEventListener("click", async (e) => {
		const b = e.target.closest("[data-act]");
		if (!b) return;
		const act = b.dataset.act;
		const box = b.closest("[data-inv]");
		const iid = box ? Number(box.dataset.inv) : 0;
		const inv = iid ? state.invoices.find((i) => i.id === iid) : null;
		const extra = box ? box.querySelector("[data-extra]") : null;
		b.disabled = true;
		try {
			if (act === "create") {
				const amount = root.querySelector('[data-f="amount"]').value;
				const type = root.querySelector('[data-f="type"]').value;
				const r = await api("/create/", { amount: amount === "" ? null : Number(amount), payment_type: type || undefined });
				toast(t("created"), true);
				await load();
				await copy(r.invoice.page_url);
			} else if (act === "qr") {
				const body = { ...formValues(), payment_type: undefined, qr: Number(root.querySelector('[data-f="qr"]').value) };
				try {
					await api("/qr/", body);
				} catch (err) {
					// Каса зайнята іншою сумою — скинути й виставити нову за підтвердженням
					if (err.code !== "modules.monobank.e.qr_busy" || !confirm(err.message + "\n\n" + t("qr_force"))) throw err;
					await api("/qr/", { ...body, force: true });
				}
				toast(t("qr_done"), true);
				await load();
			} else if (act === "card-pay") {
				const card = Number(b.closest("[data-card]").dataset.card);
				const v = formValues();
				const sum = v.amount === null ? state.due : v.amount;
				if (!confirm(t("confirm_card_pay").replace("%s", Number(sum).toFixed(2) + " " + state.currency))) return;
				const r = await api("/cards/pay/", { ...v, card });
				state = r;
				render();
				toast(r.tds ? t("card_tds") : t("card_paid"), true);
				if (r.tds && r.invoice.page_url) await copy(r.invoice.page_url);
			} else if (act === "card-verify") {
				const r = await api("/cards/verify/");
				state = r;
				render();
				await copy(r.invoice.page_url);
				toast(t("card_verify_done"), true);
			} else if (act === "card-delete") {
				if (!confirm(t("confirm_card_delete"))) return;
				state = await api(`/cards/${Number(b.closest("[data-card]").dataset.card)}/delete/`);
				render();
			} else if (act === "cards-refresh") {
				state = await api("/cards/refresh/");
				render();
			} else if (act === "copy") {
				await copy(inv.page_url, box);
				toast(t("copied"), true);
				api(`/${iid}/copied/`).catch(() => null);
			} else if (act === "refresh") {
				state = await api(`/${iid}/refresh/`);
				render();
			} else if (act === "remove") {
				if (!confirm(t("confirm_remove"))) return;
				state = await api(`/${iid}/remove/`);
				render();
			} else if (act === "finalize") {
				const v = prompt(t("finalize_prompt"), "");
				if (v === null) return;
				if (!confirm(t("confirm_finalize"))) return;
				state = await api(`/${iid}/finalize/`, { amount: v.trim() === "" ? null : Number(v.replace(",", ".")) });
				render();
			} else if (act === "release") {
				if (!confirm(t("confirm_release"))) return;
				state = await api(`/${iid}/release/`);
				render();
			} else if (act === "refund") {
				refundModal(inv, await api(`/${iid}/refund-form/`));
			} else if (act === "receipt") {
				if (!extra.classList.contains("d-none") && extra.dataset.kind === "receipt") return extra.classList.add("d-none");
				extra.dataset.kind = "receipt";
				extra.innerHTML = `<div class="input-group input-group-sm">
					<input type="email" class="form-control rounded-0" value="${esc(state.email || "")}" placeholder="${esc(t("email"))}" data-email />
					<button type="button" class="btn btn-outline-primary rounded-0" data-act="receipt-send"><i class="fa-regular fa-envelope me-1"></i>${esc(t("receipt_send"))}</button>
					<a class="btn btn-outline-secondary rounded-0" href="${B}/${iid}/receipt/" target="_blank" rel="noopener"><i class="fa-regular fa-file-pdf me-1"></i>${esc(t("receipt_pdf"))}</a>
				</div>`;
				extra.classList.remove("d-none");
			} else if (act === "receipt-send") {
				const email = extra.querySelector("[data-email]").value.trim();
				if (!email) return toast(t("email_required"), false);
				await api(`/${iid}/receipt/`, { email });
				toast(t("receipt_sent"), true);
			} else if (act === "fiscal") {
				if (!extra.classList.contains("d-none") && extra.dataset.kind === "fiscal") return extra.classList.add("d-none");
				extra.dataset.kind = "fiscal";
				const r = await api(`/${iid}/fiscal/`);
				extra.innerHTML = r.checks.length
					? r.checks
							.map(
								(c) =>
									`<div class="d-flex flex-wrap gap-2 align-items-center"><span>${esc(t("ft_" + c.type))}</span><span class="badge rounded-0 text-bg-${c.status === "done" ? "success" : c.status === "failed" ? "danger" : "secondary"}">${esc(t("fs_" + c.status))}</span>${c.description ? `<span class="text-secondary">${esc(c.description)}</span>` : ""}${c.tax_url ? `<a href="${esc(c.tax_url)}" target="_blank" rel="noopener">${esc(t("tax_link"))}</a>` : ""}${c.has_file ? `<a href="${B}/${iid}/fiscal/${encodeURIComponent(c.id)}/" target="_blank" rel="noopener"><i class="fa-regular fa-file-pdf me-1"></i>PDF</a>` : ""}</div>`
							)
							.join("")
					: `<span class="text-secondary">${esc(t("fiscal_empty"))}</span>`;
				extra.classList.remove("d-none");
			} else if (act === "events") {
				if (!extra.classList.contains("d-none") && extra.dataset.kind === "events") return extra.classList.add("d-none");
				extra.dataset.kind = "events";
				const r = await api(`/${iid}/events/`);
				extra.innerHTML = r.rows.length
					? r.rows
							.map(
								(ev) =>
									`<div class="d-flex gap-2"><span class="text-secondary text-nowrap">${esc(date(ev.date_add))}</span><span>${esc(t("ev_" + ev.type))}${ev.status ? ` → ${esc(t("st_" + ev.status))}` : ""}${ev.user ? ` · ${esc(ev.user)}` : ""}</span></div>`
							)
							.join("")
					: `<span class="text-secondary">${esc(t("events_empty"))}</span>`;
				extra.classList.remove("d-none");
			}
		} catch (err) {
			toast(err.message, false);
		} finally {
			if (b.isConnected) b.disabled = false;
		}
	});

	load();
})();