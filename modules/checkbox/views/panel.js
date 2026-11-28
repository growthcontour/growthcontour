/* Checkbox — фіскальні чеки в картці замовлення (модуль checkbox). Підключається хуком displayOrderPayment. */
(function () {
	"use strict";
	const root = document.getElementById("cb-panel");
	if (!root || root.dataset.ready) return;
	root.dataset.ready = "1";

	const OID = Number(root.dataset.order);
	const EDIT = root.dataset.edit === "1";
	const SETTINGS = root.dataset.settings === "1";
	let L = {};
	try {
		L = JSON.parse(root.dataset.l || "{}");
	} catch (e) {}
	const B = "/api/module/checkbox/order/" + OID;
	const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const t = (k) => (L[k] !== undefined ? L[k] : k);
	const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴";
	const date = (v) => (v ? new Date(v).toLocaleString() : "");
	const RB = { QUEUED: "info", CREATED: "warning", DONE: "success", ERROR: "danger", CANCELLATION: "secondary", CANCELLED: "secondary" };
	const EB = { CREATED: "warning", DONE: "success", DONE_WITHOUT_SMS: "success", CANCELLED: "secondary", RETURNED: "secondary", RECEIPT_ERROR: "danger", ERROR: "danger" };

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
			if (!window.__cbNotyf) window.__cbNotyf = new Notyf({ duration: 5000, position: { x: "right", y: "top" } });
			return ok ? window.__cbNotyf.success(msg) : window.__cbNotyf.error(msg);
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

	function receiptRow(r) {
		const done = r.status === "DONE";
		return `<div class="border-top px-3 py-2" data-rc="${r.id}">
			<div class="d-flex flex-wrap align-items-center gap-2">
				<span class="badge rounded-0 text-bg-${r.type === "RETURN" ? "danger" : "light border"}">${esc(t("type_" + r.type))}</span>
				<span class="badge rounded-0 text-bg-${RB[r.status] || "secondary"}">${esc(t("rs_" + r.status))}</span>
				<b>${money(r.total)}</b>
				${r.payment_type ? `<span class="small text-secondary">${esc(t("pt_" + r.payment_type))}</span>` : ""}
				${r.chain === "pre" ? `<span class="badge rounded-0 text-bg-light border">${esc(t("ch_pre"))}</span>` : r.chain === "after" ? `<span class="badge rounded-0 text-bg-light border">${esc(t("ch_after"))}</span>` : ""}
				${r.source === "ettn" ? `<span class="badge rounded-0 text-bg-light border">${esc(t("src_ettn"))}</span>` : ""}
				<span class="ms-auto btn-group btn-group-sm flex-wrap">
					${EDIT && r.status === "QUEUED" ? `<button type="button" class="btn btn-outline-primary rounded-0" data-act="retry" title="${esc(t("retry"))}"><i class="fa-solid fa-paper-plane"></i></button>` : ""}
					<button type="button" class="btn btn-outline-secondary rounded-0" data-act="refresh" title="${esc(t("refresh"))}"><i class="fa-solid fa-rotate"></i></button>
					${done ? `<a class="btn btn-outline-secondary rounded-0" href="${B}/receipt/${r.id}/file/pdf/" target="_blank" rel="noopener" title="PDF"><i class="fa-regular fa-file-pdf"></i></a>` : ""}
					${done ? `<a class="btn btn-outline-secondary rounded-0" href="${B}/receipt/${r.id}/file/html/" target="_blank" rel="noopener" title="${esc(t("print"))}"><i class="fa-solid fa-print"></i></a>` : ""}
					${done && r.tax_url ? `<a class="btn btn-outline-secondary rounded-0" href="${esc(r.tax_url)}" target="_blank" rel="noopener" title="${esc(t("tax_link"))}"><i class="fa-solid fa-landmark"></i></a>` : ""}
					${done ? `<button type="button" class="btn btn-outline-secondary rounded-0" data-act="send" title="${esc(t("send"))}"><i class="fa-regular fa-envelope"></i></button>` : ""}
					${EDIT && done && r.type === "SELL" && !r.chain ? `<button type="button" class="btn btn-outline-danger rounded-0" data-act="return"><i class="fa-solid fa-rotate-left me-1"></i>${esc(t("return"))}</button>` : ""}
				</span>
			</div>
			<div class="small text-secondary mt-1">${[r.fiscal_code ? `${esc(t("fiscal_code"))} ${esc(r.fiscal_code)}` : "", esc(date(r.fiscal_date || r.date_add)), r.register ? esc(r.register) : "", r.user ? esc(r.user) : ""].filter(Boolean).join(" · ")}</div>
			${r.error ? `<div class="small text-danger mt-1">${esc(r.error)}</div>` : ""}
			<div class="small mt-2 d-none" data-extra></div>
		</div>`;
	}

	function ettnRow(e) {
		const open = e.status === "CREATED" || e.status === "RECEIPT_ERROR";
		return `<div class="border-top px-3 py-2" data-et="${e.id}">
			<div class="d-flex flex-wrap align-items-center gap-2">
				<span class="badge rounded-0 text-bg-light border"><i class="fa-solid fa-truck-fast me-1"></i>${esc(t("ettn"))} ${esc(e.ttn)}</span>
				<span class="badge rounded-0 text-bg-${EB[e.status] || "secondary"}">${esc(t("es_" + e.status))}</span>
				<b>${money(e.total)}</b>
				<span class="ms-auto btn-group btn-group-sm">
					${e.status !== "ERROR" ? `<button type="button" class="btn btn-outline-secondary rounded-0" data-act="ettn-refresh" title="${esc(t("refresh"))}"><i class="fa-solid fa-rotate"></i></button>` : ""}
					${EDIT && open ? `<button type="button" class="btn btn-outline-success rounded-0" data-act="ettn-fiscalize" title="${esc(t("ettn_fiscalize"))}"><i class="fa-solid fa-receipt"></i></button>` : ""}
					${EDIT && (e.status === "CREATED" || e.status === "ERROR") ? `<button type="button" class="btn btn-outline-danger rounded-0" data-act="ettn-cancel" title="${esc(t("ettn_cancel"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}
				</span>
			</div>
			<div class="small text-secondary mt-1">${[esc(date(e.date_add)), e.register ? esc(e.register) : "", e.last_check ? `${esc(t("checked"))} ${esc(date(e.last_check))}` : ""].filter(Boolean).join(" · ")}</div>
			${e.error ? `<div class="small text-danger mt-1">${esc(e.error)}</div>` : ""}
		</div>`;
	}

	function chainRow(c) {
		const open = c.status === "PARTIAL_PAID" || c.status === "FULL_PAID";
		return `<div class="border-top px-3 py-2 bg-body-tertiary">
			<div class="d-flex flex-wrap align-items-center gap-2">
				<span class="badge rounded-0 text-bg-light border"><i class="fa-solid fa-link me-1"></i>${esc(t("chain"))} ${esc(c.relation_id)}</span>
				<span class="badge rounded-0 text-bg-${c.status === "FULL_PAID" ? "success" : c.status === "PARTIAL_PAID" ? "warning" : "secondary"}">${esc(t("cs_" + c.status))}</span>
				<span class="small">${esc(t("paid"))}: <b>${money(c.paid)}</b> / ${money(c.total)}${c.left > 0 ? ` · ${esc(t("left"))}: <b>${money(c.left)}</b>` : ""}</span>
				<span class="ms-auto btn-group btn-group-sm">
					<button type="button" class="btn btn-outline-secondary rounded-0" data-act="chain-refresh" title="${esc(t("refresh"))}"><i class="fa-solid fa-rotate"></i></button>
					${EDIT && open ? `<button type="button" class="btn btn-outline-danger rounded-0" data-act="chain-return"><i class="fa-solid fa-rotate-left me-1"></i>${esc(t("chain_return"))}</button>` : ""}
				</span>
			</div>
			${c.left > 0 && open ? `<div class="small text-secondary mt-1">${esc(t("chain_help"))}</div>` : ""}
		</div>`;
	}

	function render() {
		const s = state;
		if (!s.supported) {
			root.innerHTML = s.registers ? `<div class="p-3 small text-secondary"><i class="fa-solid fa-receipt me-1"></i>${esc(t("unsupported"))}</div>` : "";
			return;
		}
		if (!s.registers.length) {
			root.innerHTML = `<div class="p-3 small"><i class="fa-solid fa-receipt me-1"></i>${esc(t("no_registers"))} ${SETTINGS ? `<a href="/modules/checkbox/">${esc(t("setup"))}</a>` : ""}</div>`;
			return;
		}
		let h = `<div class="px-3 pt-3 pb-2">
			<div class="d-flex align-items-center mb-2"><i class="fa-solid fa-receipt me-2"></i><b class="me-auto">${esc(t("title"))}</b><span class="small text-secondary">${esc(t("total"))}: <b>${money(s.total)}</b></span></div>`;
		if (EDIT) {
			h += `<div class="row g-2 align-items-end">
				${s.registers.length > 1 ? `<div class="col-sm-4"><label class="form-label small mb-1">${esc(t("register"))}</label><select class="form-select form-select-sm rounded-0" data-f="register">${s.registers.map((r) => `<option value="${r.id}"${r.id === s.register ? " selected" : ""}>${esc(r.name)}</option>`).join("")}</select></div>` : ""}
				<div class="col-sm-4"><label class="form-label small mb-1">${esc(t("payment"))}</label><select class="form-select form-select-sm rounded-0" data-f="pay"><option value="CASHLESS">${esc(t("pt_CASHLESS"))}</option><option value="CASH">${esc(t("pt_CASH"))}</option></select></div>
				${s.chain && s.chain.status === "PARTIAL_PAID" ? "" : `<div class="col-sm-4"><button type="button" class="btn btn-sm btn-primary rounded-0 w-100" data-act="sell"><i class="fa-solid fa-receipt me-1"></i>${esc(t("sell"))}</button></div>`}
				<div class="col-sm-8"><label class="form-label small mb-1">${esc(s.chain && s.chain.status === "PARTIAL_PAID" ? t("pay_amount") : t("prepay_amount"))}</label><input type="number" min="0.01" step="0.01" class="form-control form-control-sm rounded-0" data-f="amount" placeholder="${esc(s.chain && s.chain.status === "PARTIAL_PAID" ? Number(s.chain.left).toFixed(2) : "")}" /></div>
				<div class="col-sm-4"><button type="button" class="btn btn-sm btn-outline-primary rounded-0 w-100" data-act="${s.chain && s.chain.status === "PARTIAL_PAID" ? "chain-pay" : "prepay"}">${esc(s.chain && s.chain.status === "PARTIAL_PAID" ? t("chain_pay") : t("prepay"))}</button></div>
			</div>`;
			if (s.shipments.length)
				h += `<div class="input-group input-group-sm mt-2">
					<span class="input-group-text rounded-0"><i class="fa-solid fa-truck-fast"></i></span>
					<select class="form-select rounded-0" data-f="ship">${s.shipments.map((x) => `<option value="${x.id}">${esc(x.ttn)} · ${esc(t("cod"))} ${money(x.cod)}</option>`).join("")}</select>
					<button type="button" class="btn btn-outline-primary rounded-0" data-act="ettn" title="${esc(t("ettn_help"))}">${esc(t("ettn_create"))}</button>
				</div>`;
		}
		h += `</div>`;
		if (s.chain) h += chainRow(s.chain);
		const list = [...s.ettn.map(ettnRow), ...s.receipts.map(receiptRow)];
		h += list.length ? list.join("") : `<div class="border-top px-3 py-2 small text-secondary">${esc(t("no_receipts"))}</div>`;
		root.innerHTML = h;
	}

	/* ─── Повернення: позиції чека продажу ─── */
	let modal = null;
	function returnModal(rc, f) {
		let el = document.getElementById("cb-return");
		if (!el) {
			el = document.createElement("div");
			el.id = "cb-return";
			el.className = "modal fade";
			el.tabIndex = -1;
			document.body.appendChild(el);
			modal = new bootstrap.Modal(el);
		}
		el.innerHTML = `<div class="modal-dialog modal-lg"><form class="modal-content rounded-0" autocomplete="off">
			<div class="modal-header"><h5 class="modal-title">${esc(t("return_title"))}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
			<div class="modal-body">
				<table class="table table-sm align-middle"><thead><tr><th>${esc(t("item"))}</th><th class="text-end">${esc(t("price"))}</th><th class="text-end">${esc(t("returned"))}</th><th style="width:120px">${esc(t("qty"))}</th></tr></thead>
				<tbody>${f.items
					.map(
						(it) => `<tr data-index="${it.index}"><td>${esc(it.name)}<div class="small text-secondary">${esc(it.code)}</div></td><td class="text-end text-nowrap">${money(it.price)}</td><td class="text-end">${it.returned}</td>
						<td><input type="number" class="form-control form-control-sm rounded-0" min="0" max="${it.quantity - it.returned}" step="any" value="${it.quantity - it.returned}" /></td></tr>`
					)
					.join("")}</tbody></table>
				<div class="small text-secondary">${esc(t("return_help"))}</div>
			</div>
			<div class="modal-footer">
				<button type="button" class="btn btn-outline-secondary rounded-0" data-bs-dismiss="modal">${esc(t("cancel"))}</button>
				<button type="submit" class="btn btn-danger rounded-0"><i class="fa-solid fa-rotate-left me-1"></i>${esc(t("return_do"))}</button>
			</div>
		</form></div>`;
		const form = el.querySelector("form");
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const items = [...form.querySelectorAll("tr[data-index]")].map((tr) => ({ index: Number(tr.dataset.index), qty: Number(tr.querySelector("input").value) || 0 })).filter((x) => x.qty > 0);
			if (!items.length) return toast(t("return_empty"), false);
			if (!confirm(t("confirm_return"))) return;
			const btn = form.querySelector("[type=submit]");
			btn.disabled = true;
			try {
				state = await api(`/receipt/${rc.id}/return/`, { items });
				modal.hide();
				render();
				toast(t("return_done"), true);
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
		const rbox = b.closest("[data-rc]");
		const ebox = b.closest("[data-et]");
		const rid = rbox ? Number(rbox.dataset.rc) : 0;
		const eid = ebox ? Number(ebox.dataset.et) : 0;
		const val = (f) => (root.querySelector(`[data-f="${f}"]`) || {}).value;
		b.disabled = true;
		try {
			if (act === "sell") {
				const body = { payment_type: val("pay"), ...(val("register") ? { register: Number(val("register")) } : {}) };
				if (!confirm(t("confirm_sell").replace("%s", money(state.total)))) return;
				try {
					state = await api("/sell/", body);
				} catch (err) {
					// Уже є чинний чек — видати ще один лише за явним підтвердженням
					if (err.code !== "modules.checkbox.e.already_fiscal" || !confirm(err.message + "\n\n" + t("force_sell"))) throw err;
					state = await api("/sell/", { ...body, force: true });
				}
				render();
				toast(t("sell_done"), true);
			} else if (act === "prepay" || act === "chain-pay") {
				const amount = val("amount");
				if (act === "prepay" && !amount) return toast(t("prepay_empty"), false);
				const body = { payment_type: val("pay"), amount: amount === "" ? null : Number(amount), ...(val("register") ? { register: Number(val("register")) } : {}) };
				const sum = amount === "" ? state.chain.left : Number(amount);
				if (!confirm(t(act === "prepay" ? "confirm_prepay" : "confirm_chain_pay").replace("%s", money(sum)))) return;
				state = await api(act === "prepay" ? "/chain/prepay/" : "/chain/pay/", body);
				render();
				toast(t("sell_done"), true);
			} else if (act === "chain-refresh") {
				state = await api("/chain/refresh/");
				render();
			} else if (act === "chain-return") {
				if (!confirm(t("confirm_chain_return"))) return;
				state = await api("/chain/return/");
				render();
				toast(t("return_done"), true);
			} else if (act === "ettn") {
				if (!confirm(t("confirm_ettn"))) return;
				state = await api("/ettn/create/", { shipment: Number(val("ship")) });
				render();
				toast(t("ettn_done"), true);
			} else if (act === "retry") {
				state = await api(`/receipt/${rid}/retry/`);
				render();
			} else if (act === "refresh") {
				state = await api(`/receipt/${rid}/refresh/`);
				render();
			} else if (act === "return") {
				returnModal({ id: rid }, await api(`/receipt/${rid}/return-form/`));
			} else if (act === "send") {
				const extra = rbox.querySelector("[data-extra]");
				if (!extra.classList.contains("d-none")) return extra.classList.add("d-none");
				extra.innerHTML = `<div class="input-group input-group-sm">
					<input type="email" class="form-control rounded-0" placeholder="Email" value="${esc(state.contacts.email || "")}" data-email />
					<input type="text" class="form-control rounded-0" placeholder="380XXXXXXXXX" value="" data-phone title="${esc(t("sms_paid"))}" />
					<button type="button" class="btn btn-outline-primary rounded-0" data-act="send-do">${esc(t("send"))}</button>
				</div>`;
				extra.classList.remove("d-none");
			} else if (act === "send-do") {
				const extra = rbox.querySelector("[data-extra]");
				await api(`/receipt/${rid}/send/`, { email: extra.querySelector("[data-email]").value.trim(), phone: extra.querySelector("[data-phone]").value.trim() });
				toast(t("sent"), true);
				extra.classList.add("d-none");
			} else if (act === "ettn-refresh") {
				state = await api(`/ettn/${eid}/refresh/`);
				render();
			} else if (act === "ettn-cancel") {
				if (!confirm(t("confirm_ettn_cancel"))) return;
				state = await api(`/ettn/${eid}/cancel/`);
				render();
			} else if (act === "ettn-fiscalize") {
				if (!confirm(t("confirm_ettn_fiscalize"))) return;
				state = await api(`/ettn/${eid}/fiscalize/`);
				render();
			}
		} catch (err) {
			toast(err.message, false);
		} finally {
			if (b.isConnected) b.disabled = false;
		}
	});

	load();
})();